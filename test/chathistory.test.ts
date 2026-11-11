import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import mongoose from "mongoose";
import { ChatLineModel } from "../src/entities/chatline/chatline.model";
import { pseudonymsWith } from "../src/infrastructure/privacy/pseudonyms";
import { serve, type Server } from "bun";
import { routes } from "../src/application/routes";
import { handleChat, handleToolResult } from "../src/features/chat/chat.controller";
import { handleChatHistory } from "../src/features/chathistory/chathistory.controller";
import { handleHealth } from "../src/features/health/health.controller";
import { handleConsent, handleMemories, handleMemory, handleSession, handleUser } from "../src/features/users/users.controller";
import { handleAsk } from "../src/features/ask/ask.controller";
import { handleAskX } from "../src/features/askx/askx.controller";
import { handleLicense } from "../src/features/billing/license.controller";
import { handleTelegram } from "../src/features/telegram/telegram.controller";
import { erasePlayer, exportPlayer } from "../src/features/users/privacy";
import { type ChatLine, memoryChatHistory, mongoChatHistory } from "../src/infrastructure/chathistory/chathistory";
import { offeredTools } from "../src/features/tools/game.tools";
import { CHAT_CHUNK, chatHistoryTool, folded } from "../src/features/tools/chat-history.tool";
import { AUTH, finish, owner, readSse, scripted, testDeps, text, toolCall } from "./helpers";

const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) } });

const handlers = { handleAsk, handleAskX, handleChat, handleToolResult, handleHealth, handleUser, handleSession, handleConsent, handleMemories, handleMemory, handleLicense, handleTelegram, handleChatHistory };
let server: Server<undefined> | undefined;
afterEach(() => server?.stop(true));

const start = (deps: ReturnType<typeof testDeps>) => {
  server = serve({ port: 0, routes: routes(deps, handlers) });
  return `http://localhost:${server.port}`;
};

const STEVE = { uuid: "0b1f3a3e-5f6d-4c11-9a52-2b3c4d5e6f70", name: "Steve" };
const ALEX = { uuid: "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5", name: "Alex" };
const NOTCH = { uuid: "2d3e4f5a-6b7c-4d8e-9fa0-b1c2d3e4f5a6", name: "Notch" };

const ago = (minutes: number) => Date.now() - minutes * 60_000;

/** A server's chat: Alex asks everyone, whispers to Steve, Notch whispers to Alex, and Notch talks locally near Alex only. */
const LINES: ChatLine[] = [
  { at: ago(30), channel: "public", from: ALEX, text: "anyone has §bdiamonds§r?" },
  { at: ago(20), channel: "private", from: ALEX, to: STEVE, text: "can you lend me 12 diamonds" },
  { at: ago(15), channel: "private", from: NOTCH, to: ALEX, text: "secret base at 100 64 -200" },
  { at: ago(10), channel: "local", from: NOTCH, audience: [ALEX.uuid], text: "psst, over here" },
  { at: ago(5), channel: "public", from: STEVE, text: "brb" },
];

describe("the chat history store", () => {
  test("a reader gets the public chat, the local lines they saw, and their own private messages, never anyone else's", async () => {
    const store = memoryChatHistory();
    expect(await store.add("self", "moonlands", LINES)).toBe(5);
    // A batch sent again keeps nothing twice.
    expect(await store.add("self", "moonlands", LINES)).toBe(0);
    const steve = await store.read("self", "moonlands", STEVE.uuid.toUpperCase(), { since: 0, scan: 100 });
    expect(steve.map((l) => l.text)).toEqual(["brb", "can you lend me 12 diamonds", "anyone has §bdiamonds§r?"]);
    const alex = await store.read("self", "moonlands", ALEX.uuid, { since: 0, scan: 100 });
    expect(alex).toHaveLength(5);
    const publicOnly = await store.read("self", "moonlands", ALEX.uuid, { since: 0, scan: 100, publicOnly: true });
    expect(publicOnly.map((l) => l.channel)).toEqual(["public", "public"]);
    // Another server and another tenant read nothing of it.
    expect(await store.read("self", "other", ALEX.uuid, { since: 0, scan: 100 })).toEqual([]);
    expect(await store.read("license:x", "moonlands", ALEX.uuid, { since: 0, scan: 100 })).toEqual([]);
  });

  test("lines older than three days or from the future are dropped", async () => {
    const store = memoryChatHistory();
    expect(await store.add("self", "moonlands", [{ ...LINES[0]!, at: ago(73 * 60) }, { ...LINES[0]!, at: Date.now() + 3_600_000 }])).toBe(0);
  });

  test("an erasure takes what the player wrote and leaves what others wrote to them", async () => {
    const deps = testDeps(scripted([[...text("ok"), finish()]]).model);
    await deps.chats!.add("self", "moonlands", LINES);
    const copy = await exportPlayer(deps, owner(ALEX.uuid));
    expect(copy.chat.map((l) => l.text)).toEqual(["can you lend me 12 diamonds", "anyone has §bdiamonds§r?"]);
    await erasePlayer(deps, owner(ALEX.uuid));
    const left = await deps.chats!.read("self", "moonlands", ALEX.uuid, { since: 0, scan: 100 });
    expect(left.map((l) => l.from.name)).toEqual(["Steve", "Notch", "Notch"]);
  });
});

describe("the chat_history tool", () => {
  /** A busy evening: Alex swears, Steve offers a deal, Notch chats, and the page runs past one chunk. */
  const evening = (): ChatLine[] => {
    const lines: ChatLine[] = [];
    for (let k = 0; k < CHAT_CHUNK + 300; k++) lines.push({ at: ago(600) + k * 100, channel: "public", from: NOTCH, text: `line ${k}` });
    lines.push({ at: ago(30), channel: "public", from: ALEX, text: "ты НУБ, блин, нуб!" });
    lines.push({ at: ago(29), channel: "public", from: STEVE, text: "selling a §bDiamond§r pickaxe, pay first, I'll send it later" });
    lines.push({ at: ago(28), channel: "public", from: ALEX, text: "Блин" });
    lines.push({ at: ago(27), channel: "public", from: NOTCH, text: "Steve did that to me yesterday" });
    return lines;
  };
  const tool = async (lines: ChatLine[]) => {
    const store = memoryChatHistory();
    await store.add("self", "moonlands", lines);
    let reads = 0;
    const counted = { ...store, read: (...args: Parameters<typeof store.read>) => (reads++, store.read(...args)) };
    const t = chatHistoryTool(counted, { emit: () => {}, tenant: "self", serverId: "moonlands", viewer: STEVE.uuid, timezone: "Europe/Moscow" });
    return { call: async (args: object) => (await t.execute!(args as never, {} as never)) as any, reads: () => reads };
  };

  test("folding ignores case, colors, accents, and ё", () => {
    expect(folded("§bЁлКа Café")).toBe("елка cafe");
  });

  test("the newest lines come oldest first, and older_than pages back as far as the chat goes", async () => {
    const { call, reads } = await tool(evening());
    const first = await call({ limit: 3 });
    expect(first.lines.map((l: any) => l.text)).toEqual(["selling a &bDiamond&r pickaxe, pay first, I'll send it later", "Блин", "Steve did that to me yesterday"]);
    expect(reads()).toBe(1);
    let page = first;
    let pages = 1;
    while (page.older_than) {
      page = await call({ limit: 100, older_than: page.older_than });
      pages++;
    }
    expect(page.lines[0].text).toBe("line 0");
    expect(pages).toBeGreaterThan(50);
    // The second chunk came once, as paging reached it; the rest came from what the answer had read.
    expect(reads()).toBe(2);
  });

  test("a search matches parts of words in any case and colors, any or all of them", async () => {
    const { call } = await tool(evening());
    expect((await call({ query: ["diamond"] })).lines.map((l: any) => l.from)).toEqual(["Steve"]);
    expect((await call({ query: ["нуб", "scam"] })).lines.map((l: any) => l.from)).toEqual(["Alex"]);
    expect((await call({ query: ["pay first", "later"], match: "all" })).lines).toHaveLength(1);
    expect((await call({ query: ["pay first", "nothing"], match: "all" })).lines).toHaveLength(0);
    expect((await call({ player: "ale", limit: 5 })).lines.map((l: any) => l.text)).toEqual(["ты НУБ, блин, нуб!", "Блин"]);
  });

  test("count_by player counts each word's hits per player over the whole chat", async () => {
    const { call } = await tool(evening());
    const counted = await call({ query: ["блин", "нуб"], count_by: "player" });
    expect(counted.players).toEqual([{ player: "Alex", lines: 2, hits: 4 }]);
    expect(counted.matching_lines).toBe(2);
    expect(counted.searched_lines).toBe(CHAT_CHUNK + 304);
  });

  test("around shows the talk on both sides of a line", async () => {
    const { call } = await tool(evening());
    const offer = (await call({ query: ["selling"] })).lines[0];
    const talk = await call({ around: offer.at, limit: 4 });
    expect(talk.lines.map((l: any) => l.from)).toEqual(["Notch", "Alex", "Steve", "Alex"]);
  });
});

describe("POST /api/v2/chat-history", () => {
  const post = (url: string, body: unknown) => fetch(`${url}/api/v2/chat-history`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  test("keeps a batch and refuses a private line without its addressee", async () => {
    const deps = testDeps(scripted([[...text("ok"), finish()]]).model);
    const url = start(deps);
    expect(await (await post(url, { server_id: "moonlands", lines: LINES })).json()).toEqual({ saved: 5 });
    const bad = await post(url, { server_id: "moonlands", lines: [{ at: ago(1), channel: "private", from: STEVE, text: "hi" }] });
    expect(bad.status).toBe(400);
    expect((await post(url, { server_id: "moon lands", lines: LINES })).status).toBe(400);
    expect((await post(url, { server_id: "moonlands", lines: [] })).status).toBe(400);
  });

  test("DELETE resets one server's chat and nothing else", async () => {
    const deps = testDeps(scripted([[...text("ok"), finish()]]).model);
    const url = start(deps);
    await post(url, { server_id: "moonlands", lines: LINES });
    await post(url, { server_id: "other", lines: LINES });
    const reset = await fetch(`${url}/api/v2/chat-history?server_id=moonlands`, { method: "DELETE" });
    expect(await reset.json()).toEqual({ deleted: 5 });
    expect(await deps.chats!.read("self", "moonlands", ALEX.uuid, { since: 0, scan: 100 })).toEqual([]);
    expect(await deps.chats!.read("self", "other", ALEX.uuid, { since: 0, scan: 100 })).toHaveLength(5);
    expect((await fetch(`${url}/api/v2/chat-history?server_id=no%20pe`, { method: "DELETE" })).status).toBe(400);
  });

  test("answers nobody without credentials", async () => {
    const url = start(testDeps(scripted([[...text("ok"), finish()]]).model));
    const response = await globalThis.fetch(`${url}/api/v2/chat-history`, { method: "POST", body: JSON.stringify({ server_id: "moonlands", lines: LINES }) });
    expect(response.status).toBe(401);
  });
});

describe("chat_history in a run", () => {
  const ask = (url: string, body: object) =>
    fetch(`${url}/api/v2/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ user_id: STEVE.uuid, player: { name: "Steve" }, server: { id: "moonlands" }, message: "что он мне написал? переведи", ...body }),
    });

  test("the model reads the chat as the asker sees it, oldest first, with & codes", async () => {
    const { model, prompts, offered } = scripted([
      [toolCall("chat_history", { player: "alex" }), finish("tool-calls")],
      [...text("Алекс просит одолжить 12 алмазов."), finish()],
    ]);
    const deps = testDeps(model);
    await deps.chats!.add("self", "moonlands", LINES);
    const url = start(deps);
    await readSse(await ask(url, { tools: ["chat_history", "send_message", "get_world"] }));
    expect(offered[0]).toContain("chat_history");
    expect(offered[0]).toContain("send_message");
    expect(JSON.stringify(prompts[0])).toContain("# The server's chat");
    const result = JSON.stringify(prompts[1]);
    expect(result).toContain("can you lend me 12 diamonds");
    expect(result).toContain("anyone has &bdiamonds&r?");
    // Notch's whisper to Alex and his local line near Alex are none of Steve's business.
    expect(result).not.toContain("secret base");
    expect(result).not.toContain("psst");
    expect(result.indexOf("anyone has")).toBeLessThan(result.indexOf("can you lend"));
  });

  test("a public question reads only the public chat and gets no send_message", async () => {
    const { model, prompts, offered } = scripted([
      [toolCall("chat_history", {}), finish("tool-calls")],
      [...text("ok"), finish()],
    ]);
    const deps = testDeps(model);
    await deps.chats!.add("self", "moonlands", LINES);
    const url = start(deps);
    await readSse(await ask(url, { visibility: "public", tools: ["chat_history", "send_message"] }));
    expect(offered[0]).toContain("chat_history");
    expect(offered[0]).not.toContain("send_message");
    const result = JSON.stringify(prompts[1]);
    expect(result).toContain("brb");
    expect(result).not.toContain("lend me");
  });

  test("without chat_history in the plugin's tools the prompt says the chat is out of sight", async () => {
    const { model, prompts, offered } = scripted([[...text("ok"), finish()]]);
    const url = start(testDeps(model));
    await readSse(await ask(url, { tools: ["get_world"] }));
    expect(offered[0]).not.toContain("chat_history");
    expect(JSON.stringify(prompts[0])).toContain("You don't see this server's chat");
  });

  test("send_message is a private chat's tool: never in askx or an agent's wake", () => {
    expect(offeredTools(["send_message"], false, "ask")).toEqual(["send_message"]);
    expect(offeredTools(["send_message"], false, "askx")).toEqual([]);
    expect(offeredTools(["send_message"], false, "task", "private", 1, "chests")).toEqual([]);
  });
});

const MONGODB = process.env.ALLAY_TEST_MONGODB;
if (MONGODB) {
  describe("the chat history in MongoDB", () => {
    const store = mongoChatHistory(pseudonymsWith("test"));
    beforeAll(async () => {
      await mongoose.connect(MONGODB);
      await ChatLineModel.syncIndexes();
    });
    afterAll(async () => {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    });

    test("names and texts are sealed, and each reader gets only their view", async () => {
      expect(await store.add("self", "moonlands", LINES)).toBe(5);
      expect(await store.add("self", "moonlands", LINES)).toBe(0);
      const raw = JSON.stringify(await ChatLineModel.collection.find({}).toArray());
      for (const word of ["Steve", "Alex", "Notch", "diamonds", "secret", STEVE.uuid, ALEX.uuid]) expect(raw).not.toContain(word);
      const steve = await store.read("self", "moonlands", STEVE.uuid.toUpperCase(), { since: 0, scan: 100 });
      expect(steve.map((l) => l.text)).toEqual(["brb", "can you lend me 12 diamonds", "anyone has §bdiamonds§r?"]);
      expect(await store.read("self", "moonlands", ALEX.uuid, { since: 0, scan: 100 })).toHaveLength(5);
      expect((await store.read("self", "moonlands", ALEX.uuid, { since: 0, scan: 100, publicOnly: true })).map((l) => l.from.name)).toEqual(["Steve", "Alex"]);
      expect(await store.read("license:x", "moonlands", ALEX.uuid, { since: 0, scan: 100 })).toEqual([]);
      expect((await store.list(owner(ALEX.uuid))).map((l) => l.text)).toEqual(["can you lend me 12 diamonds", "anyone has §bdiamonds§r?"]);
      expect(await store.clear(owner(ALEX.uuid))).toBe(2);
      expect(await store.read("self", "moonlands", ALEX.uuid, { since: 0, scan: 100 })).toHaveLength(3);
    });
  });
}
