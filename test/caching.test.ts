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
