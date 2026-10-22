import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { serve, type Server } from "bun";
import mongoose from "mongoose";
import { routes } from "../src/application/routes";
import { handleAsk } from "../src/features/ask/ask.controller";
import { handleAskX } from "../src/features/askx/askx.controller";
import { handleChat, handleToolResult } from "../src/features/chat/chat.controller";
import { handleHealth } from "../src/features/health/health.controller";
import {
  handleConsent, handleDeaths, handleExport, handleExportDownload, handleMemories, handleMemory, handleSession, handleState, handleUser,
} from "../src/features/users/users.controller";
import { handleLicense } from "../src/features/billing/license.controller";
import { handleTelegram } from "../src/features/telegram/telegram.controller";
import { MemoryModel } from "../src/entities/memory/memory.model";
import { DeathModel } from "../src/entities/death/death.model";
import { StateModel } from "../src/entities/state/state.model";
import { mongoMemories } from "../src/infrastructure/memory/memory";
import { mongoDeaths } from "../src/infrastructure/playerdata/deaths";
import { mongoStates } from "../src/infrastructure/playerdata/state";
import { POLICY_REVISION } from "../src/shared/policy";
import { AUTH, finish, owner, readSse, scripted, testDeps, text, toolCall } from "./helpers";

const fetch = (url: string, init: RequestInit = {}): Promise<Response> => globalThis.fetch(url, { ...init, headers: { ...AUTH, "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) } });

const handlers = {
  handleAsk, handleAskX, handleChat, handleToolResult, handleHealth, handleUser, handleSession, handleConsent, handleMemories, handleMemory, handleLicense, handleTelegram,
  handleDeaths, handleState, handleExport, handleExportDownload,
};
let server: Server<undefined> | undefined;
afterEach(() => server?.stop(true));

const start = (deps: ReturnType<typeof testDeps>) => {
  server = serve({ port: 0, routes: routes(deps, handlers) });
  return `http://localhost:${server.port}`;
};

const death = (at: number, extra: object = {}) => ({ at, world: "world", dimension: "overworld", x: 100, y: 64, z: 0, level: 12, ...extra });
const DAY = 86_400_000;

describe("deaths", () => {
  test("the plugin reports them; get_locations pages them newest first with the way there", async () => {
    const { model, prompts } = scripted([
      [toolCall("get_locations", { deaths_page: 1 }), finish("tool-calls")],
      [...text("Lava, an hour ago."), finish()],
    ]);
    const deps = testDeps(model);
    const base = start(deps);
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      const response = await fetch(`${base}/api/v2/users/player-1/deaths`, { method: "POST", body: JSON.stringify(death(now - (12 - i) * DAY, { cause: `minecraft:cause_${i}` })) });
      expect(await response.json()).toEqual({ saved: true });
    }
    await fetch(`${base}/api/v2/users/player-1/deaths`, { method: "POST", body: JSON.stringify(death(now - 3_600_000, { cause: "minecraft:lava", drops: { cobblestone: 64 }, killer_name: "Notch" })) });
    let runId = "";
    await readSse(
      await fetch(`${base}/api/v2/chat`, {
        method: "POST",
        body: JSON.stringify({
          user_id: "player-1", message: "when did I die?", timezone: "Europe/Moscow",
          player: { name: "Steve", position: { x: 100, y: 64, z: 50, dimension: "overworld" } },
          tools: ["get_locations", "get_death_info"],
        }),
      }),
      async (event) => {
        if (event.event === "start") runId = event.data.run_id;
        if (event.event === "tool_call") {
          // Plugin 6.7 answers the live facts only.
          const result = event.data.name === "get_locations" ? { respawn_point: null, world_spawn: null, last_death: { x: 100, y: 64, z: 0, dimension: "overworld" } } : { minutes_ago: 60, area_loaded: true };
          await fetch(`${base}/api/v2/chat/${runId}/tools/${event.data.call_id}`, { method: "POST", body: JSON.stringify({ ok: true, result }) });
        }
      },
    );
    const seen = JSON.stringify(prompts[1]);
    expect(seen).toContain('"total":13');
    expect(seen).toContain('"pages":2');
    expect(seen).toContain('"cause":"minecraft:lava"');
    expect(seen).toContain('"minutes_ago":60');
    expect(seen).toContain('"area_loaded":true');
    // 50 blocks north of where the player stands, in their time zone.
    expect(seen).toContain('"direction":"north"');
    expect(seen).toMatch(/"at":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+03:00"/);
  });

  test("odd bodies are refused, and a clock far ahead too", async () => {
    const base = start(testDeps(scripted([[finish()]]).model));
    const post = (body: unknown) => fetch(`${base}/api/v2/users/player-1/deaths`, { method: "POST", body: JSON.stringify(body) });
    expect((await post({})).status).toBe(400);
    expect((await post(death(Date.now(), { x: 1.5 }))).status).toBe(400);
    expect((await post(death(Date.now() + 2 * DAY))).status).toBe(400);
    expect((await post(death(Date.now(), { drops: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`item_${i}`, 1])) }))).status).toBe(400);
    expect((await fetch(`${base}/api/v2/users/player-1/deaths`)).status).toBe(405);
  });
});

describe("player state", () => {
  test("is replaced whole and read back; too big or odd is refused", async () => {
    const base = start(testDeps(scripted([[finish()]]).model));
    const url = `${base}/api/v2/users/player-1/state`;
    expect(await (await fetch(url)).json()).toEqual({ state: null, updated_at: null });
    const state = { timezone: "Asia/Yekaterinburg", settings: { chat_mode: true, hints: false }, goals: [{ id: "x2yz", kind: "level", target: 30 }] };
    const put = (await (await fetch(url, { method: "PUT", body: JSON.stringify(state) })).json()) as any;
    expect(put.state).toEqual(state);
    expect(((await (await fetch(url)).json()) as any).state).toEqual(state);
    expect((await fetch(url, { method: "PUT", body: JSON.stringify({ settings: { big: "x".repeat(40_000) } }) })).status).toBe(400);
    expect((await fetch(url, { method: "PUT", body: JSON.stringify({ goals: "nope" }) })).status).toBe(400);
    expect((await fetch(url, { method: "PUT", body: "{" })).status).toBe(400);
  });
});

describe("a player's copy by link", () => {
  test("opens for a day without credentials, holds everything, and dies with an erasure", async () => {
    const deps = testDeps(scripted([[finish()]]).model);
    const base = start(deps);
    await deps.memories.add(owner("player-1"), "a librarian with mending", { x: 1, y: 2, z: 3, dimension: "overworld" });
    await deps.deaths.add(owner("player-1"), death(Date.now()));
    await deps.states.put(owner("player-1"), { timezone: "Europe/Madrid" });
    const link = (await (await fetch(`${base}/api/v2/users/player-1/export`, { method: "POST" })).json()) as any;
    expect(link.url).toMatch(/\/api\/v2\/exports\/[A-Za-z0-9_-]{43}$/);
    expect(new Date(link.expires_at).getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    const path = new URL(link.url).pathname;
    const copy = await globalThis.fetch(`${base}${path}`);
    expect(copy.headers.get("content-disposition")).toContain("attachment");
    const body = (await copy.json()) as any;
    expect(body.memories[0].place).toEqual({ x: 1, y: 2, z: 3, dimension: "overworld" });
    expect(body.deaths).toHaveLength(1);
    expect(body.state.state).toEqual({ timezone: "Europe/Madrid" });
    // Twice is fine within the day.
    expect((await globalThis.fetch(`${base}${path}`)).status).toBe(200);
    expect((await globalThis.fetch(`${base}/api/v2/exports/${"a".repeat(43)}`)).status).toBe(404);
    expect((await globalThis.fetch(`${base}/api/v2/exports/short`)).status).toBe(404);
    const erased = (await (await fetch(`${base}/api/v2/users/player-1`, { method: "DELETE" })).json()) as any;
    expect(erased).toMatchObject({ erased: true, memories: 1, deaths: 1 });
    expect((await globalThis.fetch(`${base}${path}`)).status).toBe(404);
    expect(await deps.states.get(owner("player-1"))).toBeNull();
  });
});

describe("consent", () => {
  test("keeps the notice's hash and the policy's revision, and says the current revision", async () => {
    const base = start(testDeps(scripted([[finish()]]).model));
    const url = `${base}/api/v2/users/player-1/consent`;
    expect(await (await fetch(url)).json()).toEqual({ consent: null, revision: POLICY_REVISION });
    const hash = "ab".repeat(32);
    const given = (await (await fetch(url, { method: "PUT", body: JSON.stringify({ version: 2, hash, age_confirmed: true }) })).json()) as any;
    expect(given.consent).toMatchObject({ version: 2, hash, revision: POLICY_REVISION, age_confirmed: true });
    expect(((await (await fetch(url)).json()) as any).consent).toMatchObject({ version: 2, hash, revision: POLICY_REVISION });
    expect((await fetch(url, { method: "PUT", body: JSON.stringify({ version: 2, hash: "nothex" }) })).status).toBe(400);
    expect((await fetch(url, { method: "PUT", body: JSON.stringify({ version: 2, age_confirmed: "yes" }) })).status).toBe(400);
    // A new agreement without the answer doesn't keep the old one.
    await fetch(url, { method: "PUT", body: JSON.stringify({ version: 3 }) });
    expect(((await (await fetch(url)).json()) as any).consent.age_confirmed).toBeUndefined();
  });
});

const MONGODB = process.env.ALLAY_TEST_MONGODB;
if (MONGODB) {
  describe("in MongoDB", () => {
    beforeAll(async () => {
      await mongoose.connect(MONGODB);
      await Promise.all([MemoryModel.syncIndexes(), DeathModel.syncIndexes(), StateModel.syncIndexes()]);
    });
    afterAll(async () => {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    });

    test("memories, deaths, and state are sealed: no word of them in the clear", async () => {
      const me = owner("sealed-1");
      await mongoMemories.add(me, "diamond stash behind the waterfall", { x: 4242, y: 12, z: -77, dimension: "overworld" });
      await mongoDeaths.add(me, death(Date.now(), { killer_name: "Herobrine", x: 4242 }));
      await mongoStates.put(me, { timezone: "Pacific/Chatham" });
      const raw = JSON.stringify([
        await MemoryModel.collection.find({ user_id: "sealed-1" }).toArray(),
        await DeathModel.collection.find({ user_id: "sealed-1" }).toArray(),
        await StateModel.collection.find({ user_id: "sealed-1" }).toArray(),
      ]);
      for (const word of ["diamond", "4242", "Herobrine", "Chatham"]) expect(raw).not.toContain(word);
      expect((await mongoMemories.list(me))[0]).toMatchObject({ text: "diamond stash behind the waterfall", place: { x: 4242 } });
      expect((await mongoDeaths.page(me, 1, 10)).deaths[0]).toMatchObject({ killer_name: "Herobrine" });
      expect((await mongoStates.get(me))?.state).toEqual({ timezone: "Pacific/Chatham" });
    });

    test("memories written in the clear before 6.9 still read", async () => {
      await MemoryModel.collection.insertOne({ id: "old01", tenant: "self", user_id: "old-1", text: "an old fact", created_at: new Date(), seen_at: new Date() } as never);
      expect((await mongoMemories.list(owner("old-1"))).map((m) => m.text)).toEqual(["an old fact"]);
    });

    test("only the newest DEATHS_MAX stay", async () => {
      const me = owner("many-1");
      for (let i = 0; i < 105; i++) await mongoDeaths.add(me, death(Date.UTC(2026, 0, 1) + i * DAY));
      const first = await mongoDeaths.page(me, 1, 10);
      expect(first.total).toBe(100);
      expect(first.deaths[0].at).toBe(Date.UTC(2026, 0, 1) + 104 * DAY);
    });
  });
}
