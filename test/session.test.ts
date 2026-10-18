import { describe, expect, test } from "bun:test";
import {
  estimateTokens,
  FOLD_TOKENS,
  type HistoryMessage,
  KEEP_EXCHANGES,
  KEEP_TOKENS,
  MAX_EXCHANGES,
  MIN_KEEP_EXCHANGES,
  memoryHistory,
  threadOf,
} from "../src/infrastructure/history/history";
import { transcriptOf } from "../src/agent/summary";

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
  test("public questions go to the server's thread, everything else to the asker's own", () => {
    expect(threadOf("p1", "public", "srv-1")).toBe("public:srv-1");
    expect(threadOf("p1", "private", "srv-1")).toBe("p1");
    // A plugin without a server id can't name a shared thread.
    expect(threadOf("p1", "public", undefined)).toBe("p1");
  });

  test("isn't folded while it's short", async () => {
    const history = memoryHistory();
    for (let i = 0; i < 20; i++) await history.append("p1", ...exchange(i));
    expect(await history.compact("p1", async () => "never")).toBe(false);
    expect((await history.load("p1")).messages).toHaveLength(40);
  });

  test("folds by tokens, keeping about KEEP_TOKENS of the newest exchanges", async () => {
    const history = memoryHistory();
    const per = 1_000;
    const count = Math.ceil(FOLD_TOKENS / per) + 2;
    for (let i = 0; i < count; i++) await history.append("p1", ...sized(i, per));
    let seen: { summary?: string; older: HistoryMessage[] } | undefined;
    const folded = await history.compact("p1", async (summary, older) => {
      seen = { summary, older };
      return "The player asked many questions.";
    });
    expect(folded).toBe(true);
    const session = await history.load("p1");
    expect(session.summary).toBe("The player asked many questions.");
    // The oldest exchanges went to the summarizer, in order; the newest stayed.
    expect(seen!.older[0]).toEqual({ role: "user", content: "question 0" });
    expect(estimateTokens(session.messages)).toBeLessThanOrEqual(KEEP_TOKENS);
    expect(session.messages.length / 4 + seen!.older.length / 4).toBe(count);
    expect(session.messages.at(-1)).toEqual({ role: "assistant", content: `answer ${count - 1}` });
  });

  test("keeps the last exchanges even when each is huge", async () => {
    const history = memoryHistory();
    for (let i = 0; i < 4; i++) await history.append("p1", ...sized(i, FOLD_TOKENS / 2));
    expect(await history.compact("p1", async () => "Long talk.")).toBe(true);
    expect((await history.load("p1")).messages).toHaveLength(MIN_KEEP_EXCHANGES * 4);
  });

  test("many short exchanges fold too", async () => {
    const history = memoryHistory();
    for (let i = 0; i <= MAX_EXCHANGES; i++) await history.append("p1", ...exchange(i));
    expect(await history.compact("p1", async () => "Lots of small talk.")).toBe(true);
    expect((await history.load("p1")).messages).toHaveLength(KEEP_EXCHANGES * 2);
  });

  test("a failed summary keeps the session as it was", async () => {
    const history = memoryHistory();
    for (let i = 0; i <= MAX_EXCHANGES; i++) await history.append("p1", ...exchange(i));
    await expect(history.compact("p1", async () => { throw new Error("model down"); })).rejects.toThrow("model down");
    expect((await history.load("p1")).messages.at(-1)).toEqual({ role: "assistant", content: `answer ${MAX_EXCHANGES}` });
  });

  test("clear starts over", async () => {
    const history = memoryHistory();
    await history.append("p1", ...exchange(1));
    await history.clear("p1");
    expect(await history.load("p1")).toEqual({ messages: [] });
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
