import { describe, expect, test } from "bun:test";
import {
  estimateTokens,
  foldTokens,
  type HistoryMessage,
  KEEP_EXCHANGES,
  keepTokens,
  MAX_EXCHANGES,
  MIN_KEEP_EXCHANGES,
  memoryHistory,
  threadOf,
} from "../src/infrastructure/history/history";
import { transcriptOf } from "../src/agent/summary";
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

  test("export holds the player's session, outcomes, and agents' threads; erase removes them and nobody else's", async () => {
    const history = memoryHistory();
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
    const history = memoryHistory();
    for (let i = 0; i < 20; i++) await history.append(thread("p1"), ...exchange(i));
    expect(await history.compact(thread("p1"), async () => "never")).toBe(false);
    expect((await history.load(thread("p1"))).messages).toHaveLength(40);
  });

  test("folds by tokens, keeping about CHAT_KEEP_TOKENS of the newest exchanges", async () => {
    const history = memoryHistory();
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
    const history = memoryHistory();
    for (let i = 0; i < 4; i++) await history.append(thread("p1"), ...sized(i, foldTokens() / 2));
    expect(await history.compact(thread("p1"), async () => "Long talk.")).toBe(true);
    expect((await history.load(thread("p1"))).messages).toHaveLength(MIN_KEEP_EXCHANGES * 4);
  });

  test("many short exchanges fold too", async () => {
    const history = memoryHistory();
    for (let i = 0; i <= MAX_EXCHANGES; i++) await history.append(thread("p1"), ...exchange(i));
    expect(await history.compact(thread("p1"), async () => "Lots of small talk.")).toBe(true);
    expect((await history.load(thread("p1"))).messages).toHaveLength(KEEP_EXCHANGES * 2);
  });

  test("a failed summary keeps the session as it was", async () => {
    const history = memoryHistory();
    for (let i = 0; i <= MAX_EXCHANGES; i++) await history.append(thread("p1"), ...exchange(i));
    await expect(history.compact(thread("p1"), async () => { throw new Error("model down"); })).rejects.toThrow("model down");
    expect((await history.load(thread("p1"))).messages.at(-1)).toEqual({ role: "assistant", content: `answer ${MAX_EXCHANGES}` });
  });

  test("clear starts over", async () => {
    const history = memoryHistory();
    await history.append(thread("p1"), ...exchange(1));
    await history.clear(owner("p1"));
    expect(await history.load(thread("p1"))).toEqual({ messages: [] });
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
