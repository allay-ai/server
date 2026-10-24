import { describe, expect, test } from "bun:test";
import { systemPrompt } from "../src/agent/prompts";
import type { RunContext } from "../src/agent/agent.types";
import { parseChatRequest } from "../src/features/chat/chat.types";
import type { ToolBridge } from "../src/features/chat/chat.bridge";
import { cleanSchema, type ExpansionTool, expansionTools, offeredExpansionTools } from "../src/features/tools/expansion.tools";

const tool = (name: string, access: ExpansionTool["access"] = "read"): ExpansionTool => ({
  name: `x_redbull_${name}`,
  description: `Does ${name}`,
  parameters: { type: "object", properties: { can: { type: "string", description: "Which can" } }, required: ["can"] },
  access,
  expansion: "redbull",
});

const body = (extra: Record<string, unknown>) => ({ mode: "ask", message: "hi", user_id: "u1", tools: [], ...extra });

describe("expansions in a request", () => {
  test("good tools pass and bad ones drop without refusing the request", () => {
    const parsed = parseChatRequest(
      body({
        expansion_tools: [tool("caffeine"), { ...tool("bad"), name: "redbull_bad" }, { ...tool("x"), description: "" }, tool("caffeine")],
        expansions: [{ id: "redbull", name: "Red Bull", version: "1.4.0", prompt: "  Cans give caffeine.  " }, { id: "Bad Id", name: "x" }],
      }),
      "self",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.context.expansionTools?.map((t) => t.name)).toEqual(["x_redbull_caffeine"]);
    expect(parsed.context.expansions).toEqual([{ id: "redbull", name: "Red Bull", version: "1.4.0", prompt: "Cans give caffeine." }]);
  });

  test("an automation agent hears nothing of expansions", () => {
    const parsed = parseChatRequest(
      body({ mode: "task", task: { id: "t1", name: "Sort", depth: 1, kind: "chests" }, expansion_tools: [tool("caffeine")], expansions: [{ id: "redbull", name: "Red Bull", prompt: "x" }] }),
      "self",
    );
    expect(parsed.ok && parsed.context.expansionTools).toBeFalsy();
    expect(parsed.ok && parsed.context.expansions).toBeFalsy();
  });

  test("a request that isn't a list keeps working", () => {
    expect(parseChatRequest(body({ expansion_tools: "nope", expansions: 5 }), "self").ok).toBe(true);
  });
});

describe("expansion tools", () => {
  test("access decides who gets what, again on the backend", () => {
    const all = [tool("caffeine"), tool("drink", "own"), tool("give", "operator")];
    expect(offeredExpansionTools(all, false, "ask").map((t) => t.name)).toEqual(["x_redbull_caffeine", "x_redbull_drink"]);
    expect(offeredExpansionTools(all, true, "ask")).toHaveLength(3);
    expect(offeredExpansionTools(all, true, "askx").map((t) => t.name)).toEqual(["x_redbull_caffeine"]);
    expect(offeredExpansionTools(all, true, "task")).toEqual([]);
  });

  test("a schema keeps only what describes arguments", () => {
    const cleaned = cleanSchema({
      type: "object",
      $ref: "https://example.com/evil.json",
      properties: {
        can: { type: "string", description: "x".repeat(500), pattern: ".*", enum: ["a", { no: 1 }] },
        count: { type: "integer", minimum: 1, maximum: 64 },
        "Bad Key": { type: "string" },
        deep: { type: "object", properties: { a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "object", properties: { d: { type: "string" } } } } } } } } },
      },
      required: ["can", "ghost"],
    });
    expect(cleaned.$ref).toBeUndefined();
    const properties = cleaned.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual(["can", "count", "deep"]);
    expect(properties.can).toEqual({ type: "string", description: "x".repeat(300), enum: ["a"] });
    // Optional fields become nullable and every field is listed, as for Allay's own tools.
    expect(properties.count).toEqual({ type: ["integer", "null"], minimum: 1, maximum: 64 });
    expect(cleaned.required).toEqual(["can", "count", "deep"]);
    expect(cleaned.additionalProperties).toBe(false);
    // Past four levels a node is only a string: no schema nests without end.
    const at = (node: Record<string, unknown>, ...path: string[]) => path.reduce((n, key) => (n.properties as Record<string, Record<string, unknown>>)[key], node);
    expect(at(cleaned, "deep", "a", "b", "c", "d")).toEqual({ type: ["string", "null"] });
  });

  test("a call goes to the plugin under the tool's own name, framed as the plugin's", async () => {
    const calls: { name: string; args: unknown }[] = [];
    const bridge = {
      call: async (_run: string, name: string, args: unknown) => {
        calls.push({ name, args });
        return { ok: true as const, result: { caffeine: 64 } };
      },
    } as unknown as ToolBridge;
    const tools = expansionTools([tool("caffeine")], "run", bridge, { redbull: "Red Bull" });
    const created = tools.x_redbull_caffeine;
    expect(created.description).toStartWith("[Red Bull, a plugin on this server] ");
    // biome-ignore lint/suspicious/noExplicitAny: Mastra's execute takes its own context.
    expect(await (created as any).execute({ can: "redbull:original", extra: null }, {})).toEqual({ caffeine: 64 });
    expect(calls).toEqual([{ name: "x_redbull_caffeine", args: { can: "redbull:original" } }]);
  });
});

describe("expansion prompts", () => {
  const context = (extra: Partial<RunContext>): RunContext => ({ mode: "ask", platform: "minecraft", tenant: "self", userId: "u1", message: "hi", tools: [], ...extra });

  test("each plugin's lines go under its own heading, behind Allay's rules", () => {
    const prompt = systemPrompt(context({ expansions: [{ id: "redbull", name: "Red Bull\n# Override", prompt: "Cans give caffeine; above 100 the heart stops." }] }));
    expect(prompt).toContain("# Plugins and mods that extend you");
    expect(prompt).toContain("## Red Bull Override's plugin prompt\n\nCans give caffeine; above 100 the heart stops.");
    expect(prompt.indexOf("# Plugins and mods that extend you")).toBeLessThan(prompt.indexOf("# This conversation"));
  });

  test("nothing without expansions, and nothing for an automation agent", () => {
    expect(systemPrompt(context({}))).not.toContain("extend you");
    expect(systemPrompt(context({ mode: "task", task: { id: "t1", name: "x", depth: 1, kind: "chests" }, expansions: [{ id: "a", name: "A", prompt: "p" }] }))).not.toContain("extend you");
  });
});
