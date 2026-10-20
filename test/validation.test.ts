import { describe, expect, test } from "bun:test";
import { commandsFromText, validateCommands } from "../src/agent/commands";
import { parseChatRequest } from "../src/features/chat/chat.types";
import { GAME_TOOLS, OPERATOR_TOOLS } from "../src/features/tools/game.tools";
import { ApiFailure } from "../src/shared/types/errors";

const base = { message: "how do I find diamonds?", user_id: "5627dd98-e6be-3c21-b8a8-e92344183641" };

describe("v2 request validation", () => {
  test("a minimal request gets defaults", () => {
    const parsed = parseChatRequest(base, "self");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.context).toMatchObject({ mode: "ask", platform: "minecraft", tools: [], message: base.message });
  });

  test("tools are deduplicated and extra fields are tolerated", () => {
    const parsed = parseChatRequest({ ...base, tools: ["get_world", "get_world", "future_tool"], extra: 1 }, "self");
    expect(parsed.ok && parsed.context.tools).toEqual(["get_world", "future_tool"]);
  });

  test("an operator's plugin may offer every tool the backend knows", () => {
    const tools = [...GAME_TOOLS, ...OPERATOR_TOOLS];
    const parsed = parseChatRequest({ ...base, player: { name: "Steve", op: true }, tools }, "self");
    expect(parsed.ok && parsed.context.tools).toEqual(tools);
  });

  test("the player's dimension comes through, and an unknown one is dropped instead of refused", () => {
    const dimension = (value: unknown) => {
      const parsed = parseChatRequest({ ...base, player: { name: "Steve", dimension: value } }, "self");
      return parsed.ok ? parsed.context.player?.dimension ?? "none" : "refused";
    };
    expect(dimension("the_nether")).toBe("the_nether");
    expect(dimension("the_aether")).toBe("none");
    expect(dimension(undefined)).toBe("none");
  });

  test("questions are private unless the plugin says otherwise, and askx always is", () => {
    const visibility = (body: object) => {
      const parsed = parseChatRequest({ ...base, ...body }, "self");
      return parsed.ok ? parsed.context.visibility : "error";
    };
    expect(visibility({})).toBe("private");
    expect(visibility({ visibility: "public" })).toBe("public");
    expect(visibility({ mode: "askx", visibility: "public" })).toBe("private");
    expect(visibility({ visibility: "everyone" })).toBe("error");
  });

  test("errors use the v1 codes", () => {
    const code = (body: unknown) => {
      const parsed = parseChatRequest(body, "self");
      return parsed.ok ? "ok" : parsed.error.code;
    };
    expect(code({ ...base, message: "   " })).toBe("EMPTY_QUESTION");
    expect(code({ ...base, mode: "askx", message: " " })).toBe("EMPTY_ACTION");
    expect(code({ ...base, message: "x".repeat(1001) })).toBe("QUESTION_TOO_LONG");
    expect(code({ ...base, mode: "askx", message: "x".repeat(501) })).toBe("ACTION_TOO_LONG");
    expect(code({ message: "hi" })).toBe("BAD_REQUEST");
    expect(code({ ...base, mode: "chat" })).toBe("BAD_REQUEST");
    expect(code({ ...base, platform: "telegram" })).toBe("BAD_REQUEST");
    expect(code(null)).toBe("BAD_REQUEST");
    expect(code({ ...base, user_id: "public:srv-1" })).toBe("BAD_REQUEST");
    expect(code({ ...base, server: { id: "a b" } })).toBe("BAD_REQUEST");
  });
});

describe("askx commands", () => {
  const codeOf = (raw: unknown) => {
    try {
      validateCommands(raw);
      return "ok";
    } catch (e) {
      return (e as ApiFailure).code;
    }
  };

  test("valid commands lose their leading slash", () => {
    expect(validateCommands({ is_sequence: true, commands: ["/give @s diamond_sword", " time set day "] })).toEqual({
      is_sequence: true,
      commands: ["give @s diamond_sword", "time set day"],
    });
  });

  test("refusals, admin commands, and oversize lists are errors", () => {
    expect(codeOf({ is_sequence: false, commands: [], error: "Не могу" })).toBe("AI_ERROR");
    expect(codeOf({ is_sequence: false, commands: ["op Steve"] })).toBe("AI_ERROR");
    expect(codeOf({ is_sequence: false, commands: ["minecraft:stop"] })).toBe("AI_ERROR");
    expect(codeOf({ is_sequence: false, commands: Array(13).fill("say hi") })).toBe("TOO_MANY_COMMANDS");
    expect(codeOf({ commands: "give" })).toBe("INVALID_FORMAT");
    expect(codeOf({ is_sequence: false, commands: ["say a\nop me"] })).toBe("INVALID_FORMAT");
  });

  test("JSON in text, v1 camelCase included, is understood", () => {
    expect(commandsFromText('```json\n{"isSequence": true, "commands": ["say hi"]}\n```')).toMatchObject({ is_sequence: true });
    expect(commandsFromText("not json")).toBeUndefined();
  });
});
