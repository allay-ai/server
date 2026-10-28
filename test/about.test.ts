import { describe, expect, test } from "bun:test";
import { systemPrompt } from "../src/agent/prompts";
import { MAX_ABOUT, parseChatRequest } from "../src/features/chat/chat.types";

const server = { software: "Paper", version: "26.3", plugin_version: "6.20.0" };
const parse = (extra: Record<string, unknown>) => {
  const parsed = parseChatRequest({ mode: "ask", message: "hi", user_id: "u1", tools: [], ...extra }, "self");
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.context;
};

describe("what the operator wrote about the server", () => {
  test("goes into a question's prompt after the base prompt, framed under Allay's rules", () => {
    const context = parse({ server: { ...server, about: "  Moonlands: hard survival.\nClaims with a golden shovel.  " } });
    expect(context.server?.about).toBe("Moonlands: hard survival.\nClaims with a golden shovel.");
    const prompt = systemPrompt(context);
    expect(prompt).toContain("# About this server");
    expect(prompt).toContain("Claims with a golden shovel.");
    expect(prompt.indexOf("# About this server")).toBeLessThan(prompt.indexOf("# This conversation"));
  });

  test("is cut at the hard limit, not refused", () => {
    const context = parse({ server: { ...server, about: "a".repeat(MAX_ABOUT + 500) } });
    expect(context.server?.about?.length).toBe(MAX_ABOUT);
  });

  test("a blank or bad one is dropped", () => {
    expect(parse({ server: { ...server, about: "   " } }).server?.about).toBeUndefined();
    expect(parse({ server: { ...server, about: 42 } }).server?.about).toBeUndefined();
    expect(systemPrompt(parse({ server }))).not.toContain("# About this server");
  });

  test("stays out of automation agents and command requests", () => {
    const about = { server: { ...server, about: "Moonlands" } };
    expect(systemPrompt(parse({ ...about, mode: "task", task: { id: "t1", name: "x", depth: 1, kind: "chests" } }))).not.toContain("# About this server");
    expect(systemPrompt(parse({ ...about, mode: "askx" }))).not.toContain("# About this server");
  });
});
