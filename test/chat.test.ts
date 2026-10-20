import { afterEach, describe, expect, test } from "bun:test";
import { serve, type Server } from "bun";
import { routes } from "../src/application/routes";
import { handleAsk } from "../src/features/ask/ask.controller";
import { handleAskX } from "../src/features/askx/askx.controller";
import { handleChat, handleToolResult } from "../src/features/chat/chat.controller";
import { handleHealth } from "../src/features/health/health.controller";
import { handleMemories, handleMemory, handleSession, handleUser } from "../src/features/users/users.controller";
import { handleLicense } from "../src/features/billing/license.controller";
import { handleTelegram } from "../src/features/telegram/telegram.controller";
import { finish, reasoning, readSse, scripted, testDeps, text, toolCall } from "./helpers";
import { AUTH, owner, thread } from "./helpers";
import { MAX_MEMORIES } from "../src/infrastructure/memory/memory";
import { type HistoryMessage, MAX_EXCHANGES, maxTokens } from "../src/infrastructure/history/history";

/** Every request here comes from the tenant's own plugin; test/access.test.ts covers the ones that don't. */
const fetch = (url: string, init: RequestInit = {}): Promise<Response> => globalThis.fetch(url, { ...init, headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) } });

const handlers = { handleAsk, handleAskX, handleChat, handleToolResult, handleHealth, handleUser, handleSession, handleMemories, handleMemory, handleLicense, handleTelegram };
let server: Server<undefined> | undefined;

afterEach(() => server?.stop(true));

const start = (deps: ReturnType<typeof testDeps>) => {
  server = serve({ port: 0, routes: routes(deps, handlers) });
  return `http://localhost:${server.port}`;
};

const chat = (base: string, body: object, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/v2/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...headers },
    body: JSON.stringify({ user_id: "player-1", player: { name: "Steve" }, ...body }),
  });

const answerTools = (base: string, results: Record<string, unknown>) => {
  let runId = "";
  return async (event: { event: string; data: any }) => {
    if (event.event === "start") runId = event.data.run_id;
    if (event.event === "tool_call") {
      const response = await fetch(`${base}/api/v2/chat/${runId}/tools/${event.data.call_id}`, {
        method: "POST",
        body: JSON.stringify({ ok: true, result: results[event.data.name] ?? {} }),
      });
      expect(response.status).toBe(200);
    }
  };
};

describe("POST /api/v2/chat", () => {
  test("public questions share the server's thread, with each asker's name, apart from private sessions", async () => {
    const { model, prompts } = scripted([
      [...text("Mine at y -58 with a bed."), finish()],
      [...text("In the Nether."), finish()],
    ]);
    const deps = testDeps(model);
    const base = start(deps);
    const server = { id: "srv-1", software: "Paper", version: "26.3" };
    await readSse(await chat(base, { message: "how do I find netherite?", visibility: "public", server }));
    await readSse(
      await chat(base, { user_id: "player-2", player: { name: "Alex" }, message: "where exactly?", visibility: "public", server }),
    );
    // Alex's follow-up sees Steve's question, marked with his name.
    const second = JSON.stringify(prompts[1]);
    expect(second).toContain("[Steve]");
    expect(second).toContain("how do I find netherite?");
    expect(second).toContain("Visibility: public");
    const kept = await deps.history.load(thread("player-1", { visibility: "public", server: "srv-1" }));
    expect(kept.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(kept.messages[2].content).toStartWith("[Alex] ");
    expect((await deps.history.load(thread("player-1"))).messages).toEqual([]);
  });

  test("streams reasoning, a client tool round trip, the answer, usage, and done", async () => {
    const { model, prompts } = scripted([
      [...reasoning("Let me look at the inventory"), toolCall("inventory", {}), finish("tool-calls")],
      [...text("You have ", "&ea diamond sword&r."), finish()],
    ]);
    const deps = testDeps(model);
    const base = start(deps);
    const response = await chat(base, { message: "what do I have?", tools: ["get_inventory", "get_world"] });
    expect(response.status).toBe(200);
    const events = await readSse(response, answerTools(base, { get_inventory: { main: [{ id: "diamond_sword", count: 1 }] } }));

    expect(events.map((e) => e.event)).toEqual([
      "start", "reasoning", "tool_status", "tool_call", "tool_status", "usage", "text", "text", "usage", "usage", "done",
    ]);
    // Each step reports the totals so far; the last one before done is final.
    expect(events.filter((e) => e.event === "usage").map((e) => e.data.input_tokens)).toEqual([12, 24, 24]);
    expect(events[3].data).toMatchObject({ name: "get_inventory", args: {} });
    expect(events.at(-1)!.data.answer).toBe("You have &ea diamond sword&r.");
    expect(events.at(-2)!.data).toMatchObject({ input_tokens: 24, output_tokens: 14, cost: 0.001 });
    // The second model call saw the plugin's result.
    expect(JSON.stringify(prompts[1])).toContain("diamond_sword");
    // Only the tools the plugin offered, plus web search, reach the model.
    expect(deps.bridge.active).toBe(0);
  });

  test("inspect_item reaches the plugin with its arguments and its result reaches the model", async () => {
    const sword = {
      from: "container", slot: 0, id: "diamond_sword", enchantments: { sharpness: 5 },
      attributes: [{ attribute: "attack_damage", amount: 6, operation: "add_value", slot: "mainhand" }],
      tooltip: { attack_damage: 7, attack_speed: 1.6 },
    };
    const { model, prompts, offered } = scripted([
      [toolCall("inspect_item", { from: "container", slot: 0 }), finish("tool-calls")],
      [...text("7 damage."), finish()],
    ]);
    const base = start(testDeps(model));
    const events = await readSse(
      await chat(base, { message: "which sword is better?", tools: ["inspect_item", "look_at"] }),
      answerTools(base, { inspect_item: sword }),
    );
    expect(events.find((e) => e.event === "tool_call")!.data).toMatchObject({ name: "inspect_item", args: { from: "container", slot: 0 } });
    expect(offered[0]).toEqual(expect.arrayContaining(["look_at", "inspect_item"]));
    expect(JSON.stringify(prompts[1])).toContain("attack_speed");
    expect(events.at(-1)!.data.answer).toBe("7 damage.");
  });

  test("the system prompt describes the player and the offered tools", async () => {
    const { model, prompts, offered } = scripted([[...text("hi"), finish()]]);
    const base = start(testDeps(model));
    await readSse(await chat(base, { message: "hi", locale: "en_us", server: { software: "Paper", version: "26.3" }, tools: ["get_world"] }));
    expect(offered[0]).toContain("get_world");
    const system = JSON.stringify(prompts[0]);
    expect(system).toContain("Player: Steve");
    expect(system).toContain("Paper 26.3");
    expect(system).toContain("Game locale (a fallback for when the message has no clear language): en_us");
  });

  test("operator tools reach the model only for operators", async () => {
    const tools = ["get_world", "give_item"];
    const asOp = scripted([[...text("ok"), finish()]]);
    await readSse(await chat(start(testDeps(asOp.model)), { message: "hi", player: { name: "Admin", op: true }, tools }));
    expect(asOp.offered[0]).toEqual(expect.arrayContaining(["get_world", "give_item"]));
    server?.stop(true);

    const asPlayer = scripted([[toolCall("give_item", { item: "diamond_sword" }), finish("tool-calls")], [...text("Admins only."), finish()]]);
    const events = await readSse(await chat(start(testDeps(asPlayer.model)), { message: "give me a sword", tools }));
    expect(asPlayer.offered[0]).toContain("get_world");
    expect(asPlayer.offered[0]).not.toContain("give_item");
    // A forced call to a tool this player doesn't have never reaches the plugin.
    expect(events.some((e) => e.event === "tool_call")).toBe(false);
  });

  test("a tool the plugin never answers times out and the run still finishes", async () => {
    const { model, prompts } = scripted([[toolCall("look_at", {}), finish("tool-calls")], [...text("I can't see it."), finish()]]);
    const base = start(testDeps(model, { toolTimeoutMs: 100 }));
    const events = await readSse(await chat(base, { message: "what is this?", tools: ["look_at"] }));
    expect(events.find((e) => e.event === "tool_status" && e.data.state === "failed")).toBeDefined();
    expect(events.at(-1)!.event).toBe("done");
    expect(JSON.stringify(prompts[1])).toContain("TOOL_TIMEOUT");
  });

  test("tool results for unknown runs, and repeated ones, are refused", async () => {
    // A second tool call keeps the run open while we post a duplicate for the first one.
    const { model } = scripted([
      [toolCall("get_world", {}, "c1"), finish("tool-calls")],
      [toolCall("get_server", {}, "c2"), finish("tool-calls")],
      [...text("ok"), finish()],
    ]);
    const base = start(testDeps(model));
    let runId = "";
    let first = "";
    await readSse(await chat(base, { message: "time?", tools: ["get_world", "get_server"] }), async (event) => {
      if (event.event === "start") runId = event.data.run_id;
      if (event.event !== "tool_call") return;
      const post = (callId: string, body: object) =>
        fetch(`${base}/api/v2/chat/${runId}/tools/${callId}`, { method: "POST", body: JSON.stringify(body) });
      if (event.data.name === "get_world") {
        first = event.data.call_id;
        expect((await post(first, { result: {} })).status).toBe(400);
        expect((await post(first, { ok: true, result: { time: 1000 } })).status).toBe(200);
      } else {
        expect((await post(first, { ok: true, result: {} })).status).toBe(409);
        expect((await post(event.data.call_id, { ok: true, result: { version: "26.3" } })).status).toBe(200);
      }
    });
    const late = await fetch(`${base}/api/v2/chat/${runId}/tools/${first}`, { method: "POST", body: JSON.stringify({ ok: true, result: 1 }) });
    expect(late.status).toBe(404);
    expect(((await late.json()) as any).error.code).toBe("RUN_NOT_FOUND");
  });

  test("web search runs on the backend and shows up as a server tool", async () => {
    const { model } = scripted([[toolCall("search_web", { query: "26.3 changes" }), finish("tool-calls")], [...text("Copper golems."), finish()]]);
    const search = scripted([[...text("26.3 adds copper golems."), finish()]]);
    const deps = testDeps(model, { search: search.model });
    const base = start(deps);
    const events = await readSse(await chat(base, { message: "what's new?" }));
    const statuses = events.filter((e) => e.event === "tool_status").map((e) => [e.data.name, e.data.kind, e.data.state]);
    expect(statuses).toEqual([["search_web", "server", "started"], ["search_web", "server", "finished"]]);
    expect(events.some((e) => e.event === "tool_call")).toBe(false);
    expect(deps.searchCalls).toBe(1);
  });

  test("with a Perplexity key, web search reads its results, on the run's cost", async () => {
    const { model, prompts } = scripted([
      [toolCall("search_web", { query: "26.3 changes", sites: ["minecraft.wiki"] }), finish("tool-calls")],
      [...text("Copper golems."), finish()],
    ]);
    const requests: { url: string; body: Record<string, unknown>; auth?: string }[] = [];
    const deps = testDeps(model);
    deps.perplexity = {
      apiKey: "pplx-test-key",
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).Authorization });
        return Response.json({ results: [{ title: "Java Edition 26.3", url: "https://minecraft.wiki/w/26.3", snippet: "Adds copper golems." }] });
      }) as typeof globalThis.fetch,
    };
    const events = await readSse(await chat(start(deps), { message: "what's new?" }));
    expect(requests).toEqual([
      { url: "https://api.perplexity.ai/search", body: { query: "26.3 changes", max_results: 5, max_tokens_per_page: 400, search_domain_filter: ["minecraft.wiki"] }, auth: "Bearer pplx-test-key" },
    ]);
    expect(deps.searchCalls).toBe(0);
    expect(JSON.stringify(prompts[1])).toContain("Adds copper golems.");
    // Two model steps at $0.0005 each, plus the search.
    expect(events.at(-2)!.data.cost).toBe(0.006);
  });

  test("askx returns validated commands instead of text", async () => {
    const { model } = scripted([[...text('{"is_sequence":false,"commands":["/give @s diamond_sword"],"error":null}'), finish()]]);
    const base = start(testDeps(model));
    const events = await readSse(await chat(base, { mode: "askx", message: "give me a sword" }));
    expect(events.map((e) => e.event)).toEqual(["start", "usage", "commands", "usage", "done"]);
    expect(events[2].data).toEqual({ is_sequence: false, commands: ["give @s diamond_sword"] });
  });

  test("an askx refusal arrives as an error event", async () => {
    const { model } = scripted([[...text('{"is_sequence":false,"commands":[],"error":"Не буду банить"}'), finish()]]);
    const base = start(testDeps(model));
    const events = await readSse(await chat(base, { mode: "askx", message: "ban everyone" }));
    expect(events.at(-1)).toEqual({ event: "error", data: { code: "AI_ERROR", message: "AI returned an error: Не буду банить" } });
  });

  test("a model failure ends the stream with an error event", async () => {
    const { model } = scripted([[{ type: "error", error: new Error("upstream exploded") }]]);
    const base = start(testDeps(model));
    const events = await readSse(await chat(base, { message: "hi" }));
    expect(events.at(-1)!.event).toBe("error");
    expect(events.at(-1)!.data.code).toBe("AI_REQUEST_FAILED");
  });

  test("bad requests are plain JSON errors before any stream starts", async () => {
    const base = start(testDeps(scripted([[finish()]]).model));
    const bad = await chat(base, { message: "" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe("EMPTY_QUESTION");
    expect((await fetch(`${base}/api/v2/chat`, { method: "POST", body: "{" })).status).toBe(400);
    expect((await fetch(`${base}/api/v2/chat`)).status).toBe(405);
  });

  test("remember saves a fact that the next question sees in its prompt", async () => {
    const { model, prompts } = scripted([
      [toolCall("remember", { text: "Base at 120 64 -300" }), finish("tool-calls")],
      [...text("Got it."), finish()],
      [...text("At 120 64 -300."), finish()],
    ]);
    const deps = testDeps(model);
    const base = start(deps);
    const events = await readSse(await chat(base, { message: "my base is at 120 64 -300, remember it" }));
    expect(events.filter((e) => e.event === "tool_status").map((e) => [e.data.name, e.data.state])).toEqual([
      ["remember", "started"], ["remember", "finished"],
    ]);
    await readSse(await chat(base, { message: "where is my base?" }));
    expect(JSON.stringify(prompts[2])).toContain("Base at 120 64 -300");
    expect((await deps.memories.list(owner("player-1"))).map((m) => m.text)).toEqual(["Base at 120 64 -300"]);
  });

  test("the session summary reaches the prompt, and askx requests land in the session", async () => {
    const { model, prompts } = scripted([
      [...text('{"is_sequence":false,"commands":["give @s bread 16"],"error":null}'), finish()],
      [...text("You got bread."), finish()],
    ]);
    const deps = testDeps(model);
    // Fill the session past the fold point and fold it, as a long chat would.
    for (let i = 0; i <= MAX_EXCHANGES; i++) {
      await deps.history.append(thread("player-1"), { role: "user", content: `q${i}` }, { role: "assistant", content: `a${i}` });
    }
    await deps.history.compact(thread("player-1"), async () => "The player is building a beacon.");
    const base = start(deps);
    await readSse(await chat(base, { mode: "askx", message: "give me bread" }));
    await readSse(await chat(base, { message: "what did you just give me?" }));
    const second = JSON.stringify(prompts[1]);
    expect(second).toContain("/askx give me bread");
    expect(second).toContain("Commands: give @s bread 16");
    expect(second).toContain("The player is building a beacon.");
    expect(second).not.toContain('"q0"');
  });

  test("questions carry the player's real time", async () => {
    const { model, prompts } = scripted([[...text("Late."), finish()]]);
    const base = start(testDeps(model));
    await readSse(await chat(base, { message: "is it late?", timezone: "Asia/Yekaterinburg" }));
    expect(JSON.stringify(prompts[0])).toMatch(/\[\w{3}, \d{1,2} \w{3} \d{4}, \d{2}:\d{2} Asia\/Yekaterinburg\] is it late\?/);
  });

  test("tool calls and their results carry over to the next question", async () => {
    const { model, prompts } = scripted([
      [toolCall("find_item", { item: "diamond" }), finish("tool-calls")],
      [...text("12 diamonds."), finish()],
      [...text("In the chest."), finish()],
    ]);
    const deps = testDeps(model);
    const base = start(deps);
    await readSse(
      await chat(base, { message: "how many diamonds?", tools: ["find_item"] }),
      answerTools(base, { find_item: { total: 12, places: [{ x: 4, y: 64, z: 9, count: 12 }] } }),
    );
    const session = await deps.history.load(thread("player-1"));
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    await readSse(await chat(base, { message: "where exactly?" }));
    // The second question sees the first one's call and what it found, without calling again.
    expect(JSON.stringify(prompts[2])).toContain("find_item");
    expect(JSON.stringify(prompts[2])).toContain("places");
  });

  test("a public thread keeps the answers, not the asker's tool results", async () => {
    const { model } = scripted([[toolCall("inventory", {}), finish("tool-calls")], [...text("Some diamonds."), finish()]]);
    const deps = testDeps(model);
    const base = start(deps);
    await readSse(
      await chat(base, { message: "what do I have?", visibility: "public", server: { id: "srv-1" }, tools: ["get_inventory"] }),
      answerTools(base, { get_inventory: { main: [{ id: "diamond", count: 12 }] } }),
    );
    const kept = await deps.history.load(thread("player-1", { visibility: "public", server: "srv-1" }));
    expect(kept.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(kept.messages)).not.toContain("diamond\"");
  });

  /** An exchange of about this many tokens, most of it a tool's result. */
  const bulky = (i: number, tokens: number): HistoryMessage[] => [
    { role: "user", content: `q${i}` },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "inventory", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "inventory", output: { type: "text", value: "x".repeat(tokens * 3) } }] },
    { role: "assistant", content: `a${i}` },
  ];

  test("a session past the cap folds before the answer", async () => {
    const { model, prompts } = scripted([[...text("The player built a beacon."), finish()], [...text("Yes."), finish()]]);
    const deps = testDeps(model);
    for (let i = 0; i < 6; i++) await deps.history.append(thread("player-1"), ...bulky(i, (maxTokens() + 6_000) / 6));
    await readSse(await chat(start(deps), { message: "still there?" }));
    // The summary came first, and the answer's prompt read it instead of the whole session.
    expect(JSON.stringify(prompts[1])).toContain("The player built a beacon.");
    expect(JSON.stringify(prompts[1])).not.toContain('"q0"');
  });

  test("history carries over between questions", async () => {
    const { model, prompts } = scripted([[...text("Ender pearls."), finish()], [...text("Twelve."), finish()]]);
    const base = start(testDeps(model));
    await readSse(await chat(base, { message: "what do I need for the end?" }));
    await readSse(await chat(base, { message: "how many?" }));
    expect(JSON.stringify(prompts[1])).toContain("Ender pearls.");
  });
});

describe("v1 compatibility", () => {
  test("/api/ask answers in one JSON piece", async () => {
    const { model, prompts } = scripted([[...text("Use a fortune pickaxe."), finish()]]);
    const base = start(testDeps(model));
    const response = await fetch(`${base}/api/ask`, {
      method: "POST",
      body: JSON.stringify({ question: "diamonds?", platform: "telegram", user_id: "42" }),
    });
    const body = await response.json();
    expect(body).toMatchObject({ answer: "Use a fortune pickaxe.", status: "success", platform: "telegram", user_id: "42" });
    // Telegram gets its own prompt, with Markdown allowed.
    expect(JSON.stringify(prompts[0])).toContain("Telegram Markdown is fine");
  });

  test("/api/ask keeps its validation errors", async () => {
    const base = start(testDeps(scripted([[finish()]]).model));
    const post = (body: object) => fetch(`${base}/api/ask`, { method: "POST", body: JSON.stringify(body) });
    expect(((await (await post({})).json()) as any).code).toBe("QUESTION_REQUIRED");
    expect(((await (await post({ question: "x".repeat(1001) })).json()) as any).code).toBe("QUESTION_TOO_LONG");
    expect((await fetch(`${base}/api/ask`)).status).toBe(405);
  });

  test("/api/askx returns isSequence and commands", async () => {
    const { model } = scripted([[...text('{"is_sequence":true,"commands":["time set day","weather clear"],"error":null}'), finish()]]);
    const base = start(testDeps(model));
    const response = await fetch(`${base}/api/askx`, { method: "POST", body: JSON.stringify({ action: "make it sunny day" }) });
    expect((await response.json()) as any).toMatchObject({ isSequence: true, commands: ["time set day", "weather clear"], status: "success" });
  });

  test("/api/askx keeps its errors", async () => {
    const base = start(testDeps(scripted([[finish()]]).model));
    const post = (body: object) => fetch(`${base}/api/askx`, { method: "POST", body: JSON.stringify(body) });
    expect(((await (await post({ action: "x", platform: "telegram" })).json()) as any).code).toBe("PLATFORM_NOT_SUPPORTED");
    expect(((await (await post({})).json()) as any).code).toBe("ACTION_REQUIRED");
    expect(((await (await post({ action: "x".repeat(501) })).json()) as any).code).toBe("ACTION_TOO_LONG");
  });
});

describe("session and memory endpoints", () => {
  test("/ask new clears the session but keeps memories", async () => {
    const { model, prompts } = scripted([[...text("Ender pearls."), finish()], [...text("Hi again."), finish()]]);
    const deps = testDeps(model);
    const base = start(deps);
    await deps.memories.add(owner("player-1"), "base at 120 64 -300");
    await readSse(await chat(base, { message: "what do I need for the end?" }));
    const cleared = await fetch(`${base}/api/v2/users/player-1/session`, { method: "DELETE" });
    expect(await cleared.json()).toEqual({ cleared: true });
    await readSse(await chat(base, { message: "hi" }));
    expect(JSON.stringify(prompts[1])).not.toContain("Ender pearls.");
    expect(JSON.stringify(prompts[1])).toContain("base at 120 64 -300");
  });

  test("memories can be listed and deleted one by one or all at once", async () => {
    const deps = testDeps(scripted([[finish()]]).model);
    const base = start(deps);
    const first = await deps.memories.add(owner("player-1"), "base at 120 64 -300");
    await deps.memories.add(owner("player-1"), "wants an iron farm");
    if (first === "full") throw new Error("unexpected");
    const url = `${base}/api/v2/users/player-1/memories`;
    const listed = (await (await fetch(url)).json()) as any;
    expect(listed.memories.map((m: any) => m.text)).toEqual(["base at 120 64 -300", "wants an iron farm"]);
    expect(listed.memories[0]).toMatchObject({ id: first.id, created_at: expect.any(String) });

    expect(await (await fetch(`${url}/${first.id}`, { method: "DELETE" })).json()).toEqual({ deleted: 1 });
    const again = await fetch(`${url}/${first.id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
    expect(((await again.json()) as any).error.code).toBe("MEMORY_NOT_FOUND");
    expect(await (await fetch(url, { method: "DELETE" })).json()).toEqual({ deleted: 1 });
    expect(await (await fetch(url)).json()).toEqual({ memories: [] });
  });

  test("odd user ids and methods are refused", async () => {
    const base = start(testDeps(scripted([[finish()]]).model));
    expect((await fetch(`${base}/api/v2/users/${encodeURIComponent("a:b")}/memories`)).status).toBe(400);
    expect((await fetch(`${base}/api/v2/users/${"x".repeat(65)}/session`, { method: "DELETE" })).status).toBe(400);
    expect((await fetch(`${base}/api/v2/users/player-1/session`)).status).toBe(405);
    expect((await fetch(`${base}/api/v2/users/player-1/memories`, { method: "PUT" })).status).toBe(405);
  });

  test("a player saves a fact by hand, within the memory's limits", async () => {
    const deps = testDeps(scripted([[finish()]]).model);
    const base = start(deps);
    const url = `${base}/api/v2/users/player-1/memories`;
    const post = (body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const saved = (await (await post({ text: "  wants a beacon  " })).json()) as any;
    expect(saved.memory).toMatchObject({ id: expect.any(String), text: "wants a beacon" });
    expect(((await (await fetch(url)).json()) as any).memories.map((m: any) => m.text)).toEqual(["wants a beacon"]);
    expect((await post({ text: "x" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await fetch(url, { method: "POST", body: "not json" })).status).toBe(400);
    for (let i = 1; i < MAX_MEMORIES; i++) await deps.memories.add(owner("player-1"), `fact ${i}`);
    const full = await post({ text: "one too many" });
    expect(full.status).toBe(409);
    expect(((await full.json()) as any).error.code).toBe("MEMORY_FULL");
  });
});
