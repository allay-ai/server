import { describe, expect, test } from "bun:test";
import { cachingOf } from "../src/infrastructure/providers/openrouter/openrouter.client";

describe("prompt caching", () => {
  test("Claude models ask OpenRouter to cache the prompt; others cache by themselves", () => {
    expect(cachingOf("anthropic/claude-haiku-5.5")).toEqual({ cache_control: { type: "ephemeral" } });
    expect(cachingOf("~anthropic/claude-haiku-latest")).toEqual({ cache_control: { type: "ephemeral" } });
    expect(cachingOf("~openai/gpt-luna-latest")).toEqual({});
    expect(cachingOf("z-ai/glm-5.3-flash")).toEqual({});
  });
});

describe("provider routing", () => {
  test("requests through OpenRouter go only to providers that don't collect data by default", async () => {
    const { generateText } = await import("ai");
    const { openrouterModels } = await import("../src/infrastructure/providers/openrouter/openrouter.client");
    const { settings } = await import("../src/features/settings/settings");
    const bodies: any[] = [];
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: "gen-1", object: "chat.completion", created: 0, model: "m",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }) as typeof globalThis.fetch;
    const provider = { apiKey: "sk-test", baseURL: "https://openrouter.ai/api/v1", model: "~anthropic/claude-haiku-latest", fetch };
    await generateText({ model: openrouterModels({ provider, platform: "minecraft" } as any), prompt: "hi" });
    expect(bodies[0].provider).toEqual({ data_collection: "deny" });
    expect(settings.get("OPENROUTER_DATA_COLLECTION")).toBe("deny");
  });
});
