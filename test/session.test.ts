import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose from "mongoose";
import {
  estimateTokens,
  foldTokens,
  type HistoryMessage,
  KEEP_EXCHANGES,
  keepTokens,
  MAX_EXCHANGES,
  MIN_KEEP_EXCHANGES,
  type HistoryStore,
  memoryHistory,
  mongoHistory,
  OutcomesModel,
  SessionModel,
  sessionTtl,
  threadOf,
} from "../src/infrastructure/history/history";
import { transcriptOf } from "../src/agent/summary";
import { AdminSessionModel, memorySessions, mongoSessions, type SessionStore } from "../src/infrastructure/admin/sessions";
import { owner, thread } from "./helpers";

const exchange = (i: number, size = 0): HistoryMessage[] => [
  { role: "user", content: `question ${i}` },
  { role: "assistant", content: `answer ${i} ${"x".repeat(size)}`.trim() },
];

/** An exchange about this many tokens long, most of it a tool's result, as in a real run. */
const sized = (i: number, tokens: number): HistoryMessage[] => [
  { role: "user", content: `question ${i}` },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "inventory", input: {} }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "inventory", output: { type: "text", value: "x".repeat(tokens * 3) } }] },
  { role: "assistant", content: `answer ${i}` },
];

const MONGODB = process.env.ALLAY_TEST_MONGODB;
const clock = { time: Date.UTC(2026, 9, 22) };
const now = () => clock.time;

/** Every store keeps the same rules; MongoDB's runs too when ALLAY_TEST_MONGODB points at a throwaway database. */
const stores: Array<[string, () => HistoryStore]> = [["memory", () => memoryHistory(now)], ...(MONGODB ? [["mongodb", () => mongoHistory(now)] as [string, () => HistoryStore]] : [])];

if (MONGODB) {
  beforeAll(async () => {
    await mongoose.connect(MONGODB);
    await SessionModel.syncIndexes();
    await OutcomesModel.syncIndexes();
    await AdminSessionModel.syncIndexes();
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
}

if (MONGODB) {
  test("MongoDB holds sessions and outcomes sealed: no word of them in the clear", async () => {
    clock.time = Date.UTC(2026, 9, 22);
    const history = mongoHistory(now);
    await history.append(thread("sealed"), { role: "user", content: "where is my diamond stash" }, { role: "assistant", content: "behind the waterfall" });
    await history.noteOutcome(owner("sealed"), "[Automation «Furnaces» finished]");
    const raw = JSON.stringify([await SessionModel.collection.findOne({ key: thread("sealed").key }), await OutcomesModel.collection.findOne({ key: thread("sealed").key })]);
    expect(raw).not.toContain("diamond");
    expect(raw).not.toContain("waterfall");
    expect(raw).not.toContain("Furnaces");
    expect((await history.load(thread("sealed"))).messages.map((m) => m.content)).toEqual(["where is my diamond stash", "behind the waterfall"]);
    expect(await history.takeOutcomes(owner("sealed"))).toEqual(["[Automation «Furnaces» finished]"]);
  });
}

describe.each(stores)("the %s session store", (name, make) => {
  beforeEach(async () => {
    clock.time = Date.UTC(2026, 9, 22);
    if (name === "mongodb") await Promise.all([SessionModel.deleteMany({}), OutcomesModel.deleteMany({})]);
  });

  test("export holds the player's session, outcomes, and agents' threads; erase removes them and nobody else's", async () => {
    const history = make();
    await history.append(thread("p1"), ...exchange(1));
    await history.append(thread("p1", { task: "t1" }), ...exchange(2));
    await history.noteOutcome(owner("p1"), "[Automation done]");
    await history.append(thread("p1", { tenant: "license:abc" }), ...exchange(3));
    await history.append(thread("p2"), ...exchange(4));
    const copy = await history.export(owner("p1"));
    expect(copy.session.messages).toHaveLength(2);
    expect(Object.keys(copy.tasks)).toEqual(["t1"]);
    expect(copy.outcomes).toEqual(["[Automation done]"]);
    await history.erase(owner("p1"));
    expect(await history.export(owner("p1"))).toEqual({ session: { messages: [] }, outcomes: [], tasks: {} });
    expect((await history.load(thread("p1", { tenant: "license:abc" }))).messages).toHaveLength(2);
    expect((await history.load(thread("p2"))).messages).toHaveLength(2);
  });

  test("isn't folded while it's short", async () => {
    const history = make();
    for (let i = 0; i < 20; i++) await history.append(thread("p1"), ...exchange(i));
    expect(await history.compact(thread("p1"), async () => "never")).toBe(false);
    expect((await history.load(thread("p1"))).messages).toHaveLength(40);
  });

  test("folds by tokens, keeping about CHAT_KEEP_TOKENS of the newest exchanges", async () => {
    const history = make();
    const per = 1_000;
    const count = Math.ceil(foldTokens() / per) + 2;
    for (let i = 0; i < count; i++) await history.append(thread("p1"), ...sized(i, per));
    let seen: { summary?: string; older: HistoryMessage[] } | undefined;
    const folded = await history.compact(thread("p1"), async (summary, older) => {
      seen = { summary, older };
      return "The player asked many questions.";
    });
    expect(folded).toBe(true);
    const session = await history.load(thread("p1"));
    expect(session.summary).toBe("The player asked many questions.");
    // The oldest exchanges went to the summarizer, in order; the newest stayed.
    expect(seen!.older[0]).toEqual({ role: "user", content: "question 0" });
    expect(estimateTokens(session.messages)).toBeLessThanOrEqual(keepTokens());
    expect(session.messages.length / 4 + seen!.older.length / 4).toBe(count);
    expect(session.messages.at(-1)).toEqual({ role: "assistant", content: `answer ${count - 1}` });
  });

  test("keeps the last exchanges even when each is huge", async () => {
    const history = make();
    for (let i = 0; i < 4; i++) await history.append(thread("p1"), ...sized(i, foldTokens() / 2));
    expect(await history.compact(thread("p1"), async () => "Long talk.")).toBe(true);
    expect((await history.load(thread("p1"))).messages).toHaveLength(MIN_KEEP_EXCHANGES * 4);
  });

  test("many short exchanges fold too", async () => {
    const history = make();
    for (let i = 0; i <= MAX_EXCHANGES; i++) await history.append(thread("p1"), ...exchange(i));
    expect(await history.compact(thread("p1"), async () => "Lots of small talk.")).toBe(true);
    expect((await history.load(thread("p1"))).messages).toHaveLength(KEEP_EXCHANGES * 2);
  });

  test("a failed summary keeps the session as it was", async () => {
    const history = make();
    for (let i = 0; i <= MAX_EXCHANGES; i++) await history.append(thread("p1"), ...exchange(i));
    await expect(history.compact(thread("p1"), async () => { throw new Error("model down"); })).rejects.toThrow("model down");
    expect((await history.load(thread("p1"))).messages.at(-1)).toEqual({ role: "assistant", content: `answer ${MAX_EXCHANGES}` });
  });

  test("clear starts over", async () => {
    const history = make();
    await history.append(thread("p1"), ...exchange(1));
    await history.clear(owner("p1"));
    expect(await history.load(thread("p1"))).toEqual({ messages: [] });
  });

  test("an expired session reads empty everywhere", async () => {
    const history = make();
    await history.append(thread("p1"), ...exchange(1));
    await history.append(thread("p1", { task: "t1" }), ...exchange(2));
    await history.noteOutcome(owner("p1"), "[Automation done]");
    clock.time += sessionTtl() * 1000 + 1;
    expect(await history.load(thread("p1"))).toEqual({ messages: [] });
    expect(await history.export(owner("p1"))).toEqual({ session: { messages: [] }, outcomes: [], tasks: {} });
    expect(await history.takeOutcomes(owner("p1"))).toEqual([]);
    expect(await history.compact(thread("p1"), async () => "never")).toBe(false);
  });

  test("expires to the millisecond, not when a monitor gets round to it", async () => {
    const history = make();
    await history.append(thread("p1"), ...exchange(1));
    clock.time += sessionTtl() * 1000 - 1;
    expect((await history.load(thread("p1"))).messages).toHaveLength(2);
    clock.time += 1;
    expect((await history.load(thread("p1"))).messages).toHaveLength(0);
  });

  test("an append after expiry starts over without the old messages or summary", async () => {
    const history = make();
    for (let i = 0; i <= MAX_EXCHANGES; i++) await history.append(thread("p1"), ...exchange(i));
    await history.compact(thread("p1"), async () => "Old talk.");
    clock.time += sessionTtl() * 1000 + 1;
    await history.append(thread("p1"), ...exchange(999));
    expect(await history.load(thread("p1"))).toEqual({ messages: exchange(999) });
  });

  test("an append renews the session's time", async () => {
    const history = make();
    await history.append(thread("p1"), ...exchange(1));
    clock.time += sessionTtl() * 1000 - 10;
    await history.append(thread("p1"), ...exchange(2));
    clock.time += 20;
    expect((await history.load(thread("p1"))).messages).toHaveLength(4);
  });

  test("outcomes are handed out once, oldest first", async () => {
    const history = make();
    await history.noteOutcome(owner("p1"), "one");
    await history.noteOutcome(owner("p1"), "two");
    expect(await history.takeOutcomes(owner("p1"))).toEqual(["one", "two"]);
    expect(await history.takeOutcomes(owner("p1"))).toEqual([]);
  });

  test("another tenant reaches nothing of the first's, by the same player id", async () => {
    const history = make();
    await history.append(thread("p1", { tenant: "license:a" }), ...exchange(1));
    await history.append(thread("p1", { tenant: "license:a", task: "t1" }), ...exchange(2));
    await history.noteOutcome(owner("p1", "license:a"), "[done]");
    expect(await history.export(owner("p1", "license:b"))).toEqual({ session: { messages: [] }, outcomes: [], tasks: {} });
    expect(await history.takeOutcomes(owner("p1", "license:b"))).toEqual([]);
    await history.erase(owner("p1", "license:b"));
    await history.clear(owner("p1", "license:b"));
    const copy = await history.export(owner("p1", "license:a"));
    expect(copy.session.messages).toHaveLength(2);
    expect(Object.keys(copy.tasks)).toEqual(["t1"]);
    expect(copy.outcomes).toEqual(["[done]"]);
  });

  test("a task prefix is literal, so a player id can't widen an erase", async () => {
    const history = make();
    await history.append(thread("p1x", { task: "t1" }), ...exchange(1));
    await history.erase(owner("p1"));
    await history.erase(owner("p."));
    expect(Object.keys((await history.export(owner("p1x"))).tasks)).toEqual(["t1"]);
  });

  test("exchanges added while the summary is written stay", async () => {
    const history = make();
    for (let i = 0; i <= MAX_EXCHANGES; i++) await history.append(thread("p1"), ...exchange(i));
    await history.compact(thread("p1"), async () => {
      await history.append(thread("p1"), ...exchange(500));
      return "Small talk.";
    });
    const session = await history.load(thread("p1"));
    expect(session.summary).toBe("Small talk.");
    expect(session.messages).toHaveLength((KEEP_EXCHANGES + 1) * 2);
    expect(session.messages.at(-1)).toEqual({ role: "assistant", content: "answer 500" });
  });

  if (name === "mongodb") {
    test("a read that meets an expired session deletes it at once", async () => {
      const history = make();
      await history.append(thread("p1"), ...exchange(1));
      await history.noteOutcome(owner("p1"), "[done]");
      clock.time += sessionTtl() * 1000 + 1;
      await history.load(thread("p1"));
      await history.takeOutcomes(owner("p1"));
      await Bun.sleep(50);
      expect(await SessionModel.countDocuments({})).toBe(0);
      expect(await OutcomesModel.countDocuments({})).toBe(0);
    });
  }

  test("a fold that outlives /ask new leaves the new session alone", async () => {
    const history = make();
    for (let i = 0; i <= MAX_EXCHANGES; i++) await history.append(thread("p1"), ...exchange(i));
    await history.compact(thread("p1"), async () => {
      await history.clear(owner("p1"));
      await history.append(thread("p1"), ...exchange(7));
      return "Old talk.";
    });
    expect(await history.load(thread("p1"))).toEqual({ messages: exchange(7) });
  });

});

const panelStores: Array<[string, () => SessionStore]> = [["memory", () => memorySessions(now)], ...(MONGODB ? [["mongodb", () => mongoSessions(now)] as [string, () => SessionStore]] : [])];

describe.each(panelStores)("the %s panel sessions", (name, make) => {
  beforeEach(async () => {
    clock.time = Date.UTC(2026, 9, 22);
    if (name === "mongodb") await AdminSessionModel.deleteMany({});
  });

  test("a touch renews a session until it runs out, and an expired one stays gone", async () => {
    const sessions = make();
    const id = await sessions.create("ops", 60);
    clock.time += 59_000;
    expect((await sessions.touch(id, 60))?.username).toBe("ops");
    clock.time += 59_000;
    expect((await sessions.touch(id, 60))?.username).toBe("ops");
    clock.time += 60_000;
    expect(await sessions.touch(id, 60)).toBeNull();
    // A touch after expiry doesn't bring it back.
    clock.time -= 30_000;
    expect(await sessions.touch(id, 60)).toBeNull();
  });

  test("sign-out ends one session, removeAll every session of the account", async () => {
    const sessions = make();
    const [a, b, c] = [await sessions.create("ops", 60), await sessions.create("ops", 60), await sessions.create("viewer", 60)];
    await sessions.remove(a);
    expect(await sessions.touch(a, 60)).toBeNull();
    await sessions.removeAll("ops");
    expect(await sessions.touch(b, 60)).toBeNull();
    expect((await sessions.touch(c, 60))?.username).toBe("viewer");
  });

  test("nothing usable as a cookie is stored", async () => {
    if (name !== "mongodb") return;
    const id = await make().create("ops", 60);
    const stored = JSON.stringify(await AdminSessionModel.find({}).lean());
    expect(stored).not.toContain(id);
  });
});

describe("the chat session", () => {
  test("public questions go to the server's thread, everything else to the asker's own, all within the tenant", () => {
    expect(threadOf(owner("p1"), "public", "srv-1")).toEqual({ key: "self:p:srv-1", kind: "public" });
    expect(threadOf(owner("p1"), "private", "srv-1")).toEqual({ key: "self:u:p1", kind: "private" });
    // A plugin without a server id can't name a shared thread.
    expect(threadOf(owner("p1"), "public", undefined)).toEqual({ key: "self:u:p1", kind: "private" });
    expect(threadOf(owner("p1", "license:abc"), "private", undefined, "t1")).toEqual({ key: "license:abc:t:p1:t1", kind: "task" });
    // Another server sending the same server id reaches its own thread, never this one.
    expect(threadOf(owner("p1", "license:abc"), "public", "srv-1").key).not.toBe(threadOf(owner("p1", "license:xyz"), "public", "srv-1").key);
  });

  test("the summarizer reads tool calls and the gist of their results", () => {
    const text = transcriptOf([
      { role: "user", content: "where are my diamonds?" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "find_item", input: { item: "diamond" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "find_item", output: { type: "json", value: { total: 12 } } }] },
      { role: "assistant", content: "12 in the chest." },
    ]);
    expect(text).toBe('Player: where are my diamonds?\n\nAllay called find_item {"item":"diamond"}\n\nfind_item returned {"total":12}\n\nAllay: 12 in the chest.');
  });
});
