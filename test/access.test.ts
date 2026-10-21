import { afterEach, describe, expect, test } from "bun:test";
import { serve, type Server } from "bun";
import { routes } from "../src/application/routes";
import { ADMIN_ROUTES, handleAdmin } from "../src/features/admin/admin.controller";
import { handleAdminInit } from "../src/features/admin/init.controller";
import { handleAsk } from "../src/features/ask/ask.controller";
import { handleAskX } from "../src/features/askx/askx.controller";
import { createLicense } from "../src/features/billing/billing";
import { handleLicense } from "../src/features/billing/license.controller";
import { handleChat, handleToolResult } from "../src/features/chat/chat.controller";
import { handleHealth } from "../src/features/health/health.controller";
import { handleTelegram } from "../src/features/telegram/telegram.controller";
import { handleConsent, handleMemories, handleMemory, handlePrivacy, handleSession, handleUser } from "../src/features/users/users.controller";
import { AUTH, finish, owner, readSse, scripted, testAdmin, testBilling, testDeps, text, thread, toolCall } from "./helpers";

const handlers = {
  handleAsk, handleAskX, handleChat, handleToolResult, handleHealth, handleUser, handleSession, handleConsent, handlePrivacy, handleMemories, handleMemory, handleLicense, handleTelegram,
  handleAdminInit, handleAdmin,
};
let servers: Array<Server<undefined>> = [];

afterEach(() => {
  for (const server of servers) server.stop(true);
  servers = [];
});

const start = (deps: ReturnType<typeof testDeps>) => {
  const server = serve({ port: 0, routes: routes(deps, handlers) });
  servers.push(server);
  return { base: `http://localhost:${server.port}`, table: routes(deps, handlers) };
};

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Routes anyone may call, each with what protects it instead. */
const PUBLIC = new Set([
  // Up or not, the version, and whether billing is on.
  "GET /api/health",
  // Telegram's own secret token, checked in its test.
  ...METHODS.map((m) => `${m} /api/telegram/webhook`),
  // A new license is free and only identifies; it's limited per client address.
  "POST /api/v2/license",
  // The panel's sign-in, setup, and recovery: a password or a one-time code, behind the login limiter.
  ...ADMIN_ROUTES.filter((r) => r.access === "public").map((r) => `${r.method} /api/admin${r.path}`),
]);

/** Every concrete path the table serves, with its parameters filled in. */
const pathsOf = (table: Record<string, unknown>) =>
  Object.keys(table).flatMap((path) => {
    if (path === "/api/admin/*") return [...new Set(ADMIN_ROUTES.map((r) => `/api/admin${r.path.replace(/:[a-zA-Z]+/g, "x1")}`))];
    if (path.startsWith("/admin")) return [];
    return [path.replace(":userId", "player-1").replace(":runId", crypto.randomUUID()).replace(":callId", "call-1").replace(":memoryId", "abcde")];
  });

const routeOf = (method: string, path: string): (typeof ADMIN_ROUTES)[number] | undefined =>
  ADMIN_ROUTES.find((r) => r.method === method && new RegExp(`^/api/admin${r.path.replace(/:[a-zA-Z]+/g, "[^/]+")}$`).test(path));

describe("every route identifies its caller", () => {
  for (const billing of [false, true]) {
    test(`without credentials nothing but the public routes answers (${billing ? "hosted" : "self-hosted"})`, async () => {
      const { admin } = testAdmin({ selfHosted: !billing });
      const deps = { ...testDeps(scripted([[...text("secret"), finish()]]).model, { billing: testBilling({ enabled: billing }) }), admin };
      await deps.memories.add(owner("player-1", billing ? "license:abc" : "self"), "base at 120 64 -300");
      const { base, table } = start(deps);
      const answered: string[] = [];
      for (const path of pathsOf(table)) {
        for (const method of METHODS) {
          const key = `${method} ${path.startsWith("/api/admin/") ? `/api/admin${routeOf(method, path)?.path ?? "?"}` : path}`;
          if (PUBLIC.has(key) || (!billing && path === "/api/v2/license")) continue;
          // The panel's own origin, so the origin check passes and the session check is what refuses.
          const response = await fetch(`${base}${path}`, { method, headers: { Origin: base, "Content-Type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
          const body = await response.text();
          expect(body).not.toContain("120 64 -300");
          if (response.status === 401 || response.status === 405 || (path.startsWith("/api/admin/") && response.status === 404 && !routeOf(method, path))) continue;
          answered.push(`${method} ${path} → ${response.status}`);
        }
      }
      expect(answered).toEqual([]);
    });
  }

  test("health says up, the version, and billing, and nothing about the process", async () => {
    const { base } = start(testDeps(scripted([]).model));
    const response = await fetch(`${base}/api/health`);
    expect(Object.keys((await response.json()) as object).sort()).toEqual(["billing", "name", "status", "version"]);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("tenants never meet", () => {
  /** Two servers on a hosted backend, each with its own license, and one player who plays on both. */
  const twoServers = async (steps = [[...text("ok"), finish()]]) => {
    const { model, prompts } = scripted(steps);
    const deps = testDeps(model, { billing: testBilling({ enabled: true }) });
    const a = await createLicense(deps.billing);
    const b = await createLicense(deps.billing);
    // Both have paid for a day.
    for (const made of [a, b]) {
      await deps.billing.licenses.grant(made.license_id, { budget: 10, starts: new Date(Date.now() - 1000), ends: new Date(Date.now() + 86_400_000) });
    }
    const { base } = start(deps);
    return {
      deps, base, prompts,
      A: { Authorization: `Bearer ${a.license}` }, B: { Authorization: `Bearer ${b.license}` },
      tenantA: `license:${a.license_id}`, tenantB: `license:${b.license_id}`,
    };
  };

  test("B can't read, add to, or wipe A's memories through /users, even with A's player id", async () => {
    const t = await twoServers();
    await t.deps.memories.add(owner("player-1", t.tenantA), "A's secret base at 120 64 -300");
    const url = `${t.base}/api/v2/users/player-1/memories`;
    expect(await (await fetch(url, { headers: t.B })).json()).toEqual({ memories: [] });
    expect(await (await fetch(url, { method: "DELETE", headers: t.B })).json()).toEqual({ deleted: 0 });
    expect(await (await fetch(`${t.base}/api/v2/users/player-1`, { method: "DELETE", headers: t.B })).json()).toMatchObject({ memories: 0 });
    const copy = (await (await fetch(`${t.base}/api/v2/users/player-1`, { headers: t.B })).json()) as any;
    expect(JSON.stringify(copy)).not.toContain("120 64 -300");
    // A still has it.
    expect(((await (await fetch(url, { headers: t.A })).json()) as any).memories.map((m: any) => m.text)).toEqual(["A's secret base at 120 64 -300"]);
  });

  test("B can't read, give, or withdraw A's consent, even with A's player id", async () => {
    const t = await twoServers();
    const url = `${t.base}/api/v2/users/player-1/consent`;
    const given = (await (await fetch(url, { method: "PUT", headers: t.A, body: JSON.stringify({ version: 1 }) })).json()) as any;
    expect(given.consent.version).toBe(1);
    expect(await (await fetch(url, { headers: t.B })).json()).toEqual({ consent: null });
    expect(await (await fetch(url, { method: "DELETE", headers: t.B })).json()).toEqual({ withdrawn: false });
    expect(((await (await fetch(url, { headers: t.A })).json()) as any).consent).toEqual(given.consent);
  });

  test("B's question with A's player id loads none of A's memories, session, or outcomes", async () => {
    const t = await twoServers();
    await t.deps.memories.add(owner("player-1", t.tenantA), "A's secret base at 120 64 -300");
    await t.deps.history.append(thread("player-1", { tenant: t.tenantA }), { role: "user", content: "my stash is under the oak" }, { role: "assistant", content: "Noted." });
    await t.deps.history.noteOutcome(owner("player-1", t.tenantA), "[Automation «xyzzy» finished]");
    const events = await readSse(
      await fetch(`${t.base}/api/v2/chat`, { method: "POST", headers: { ...t.B, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: "player-1", message: "what do you remember about me?" }) }),
    );
    expect(events.at(-1)!.event).toBe("done");
    const prompt = JSON.stringify(t.prompts[0]);
    expect(prompt).not.toContain("120 64 -300");
    expect(prompt).not.toContain("under the oak");
    expect(prompt).not.toContain("xyzzy");
    // A's outcome is still waiting for A.
    expect(await t.deps.history.takeOutcomes(owner("player-1", t.tenantA))).toEqual(["[Automation «xyzzy» finished]"]);
  });

  test("B's agent can't remember into or forget from A's memories", async () => {
    const t = await twoServers([[toolCall("remember", { text: "B was here" }), finish("tool-calls")], [...text("ok"), finish()]]);
    const mine = await t.deps.memories.add(owner("player-1", t.tenantA), "A's own fact");
    if (mine === "full") throw new Error("unexpected");
    await readSse(await fetch(`${t.base}/api/v2/chat`, { method: "POST", headers: t.B, body: JSON.stringify({ user_id: "player-1", message: "remember me" }) }));
    expect((await t.deps.memories.list(owner("player-1", t.tenantA))).map((m) => m.text)).toEqual(["A's own fact"]);
    expect((await t.deps.memories.list(owner("player-1", t.tenantB))).map((m) => m.text)).toEqual(["B was here"]);
  });

  test("a server id names a public thread only within its own tenant", async () => {
    const t = await twoServers([[...text("Mine at y -58."), finish()], [...text("No idea."), finish()]]);
    const ask = (headers: Record<string, string>, message: string) =>
      fetch(`${t.base}/api/v2/chat`, { method: "POST", headers, body: JSON.stringify({ user_id: "player-1", message, visibility: "public", server: { id: "moonlands" }, player: { name: "Steve" } }) });
    await readSse(await ask(t.A, "where is the plugh vault on A?"));
    await readSse(await ask(t.B, "what did people ask here?"));
    expect(JSON.stringify(t.prompts[1])).not.toContain("plugh");
  });

  test("tool results from another tenant are refused, and the run gets its own", async () => {
    const t = await twoServers([[toolCall("inventory", {}), finish("tool-calls")], [...text("You hold a stick."), finish()]]);
    let runId = "";
    const statuses: number[] = [];
    const events = await readSse(
      await fetch(`${t.base}/api/v2/chat`, { method: "POST", headers: t.A, body: JSON.stringify({ user_id: "player-1", message: "what do I hold?", tools: ["get_inventory"] }) }),
      async (event) => {
        if (event.event === "start") runId = event.data.run_id;
        if (event.event !== "tool_call") return;
        const url = `${t.base}/api/v2/chat/${runId}/tools/${event.data.call_id}`;
        const answer = (headers: Record<string, string>, result: unknown) => fetch(url, { method: "POST", headers, body: JSON.stringify({ ok: true, result }) });
        statuses.push((await answer({}, { main: ["nothing"] })).status);
        statuses.push((await answer(t.B, { main: ["a diamond block"] })).status);
        statuses.push((await answer(t.A, { main: ["stick"] })).status);
      },
    );
    expect(statuses).toEqual([401, 404, 200]);
    expect(JSON.stringify(t.prompts[1])).toContain("stick");
    expect(JSON.stringify(t.prompts[1])).not.toContain("diamond block");
    expect(events.at(-1)!.event).toBe("done");
  });
});

describe("a player's data on request", () => {
  test("export holds everything kept about the player; erase leaves only anonymous numbers", async () => {
    const { model } = scripted([[...text("Noted."), finish()]]);
    const deps = { ...testDeps(model), runs: (await import("../src/infrastructure/runs/runs")).memoryRuns() };
    const { base } = start(deps);
    await deps.memories.add(owner("player-1"), "base at 120 64 -300");
    await readSse(await fetch(`${base}/api/v2/chat`, { method: "POST", headers: AUTH, body: JSON.stringify({ user_id: "player-1", message: "hi there" }) }));
    await readSse(await fetch(`${base}/api/v2/chat`, { method: "POST", headers: AUTH, body: JSON.stringify({ user_id: "player-2", message: "hello" }) }));

    await fetch(`${base}/api/v2/users/player-1/consent`, { method: "PUT", headers: AUTH, body: JSON.stringify({ version: 2 }) });
    await fetch(`${base}/api/v2/users/player-2/consent`, { method: "PUT", headers: AUTH, body: JSON.stringify({ version: 2 }) });

    const copy = (await (await fetch(`${base}/api/v2/users/player-1`, { headers: AUTH })).json()) as any;
    expect(copy.memories.map((m: any) => m.text)).toEqual(["base at 120 64 -300"]);
    expect(JSON.stringify(copy.session)).toContain("hi there");
    expect(copy.runs).toHaveLength(1);
    expect(copy.pseudonym).toMatch(/^p_[0-9a-f]{20}$/);
    expect(copy.retention).toBeDefined();
    expect(copy.consent).toMatchObject({ version: 2 });

    const erased = (await (await fetch(`${base}/api/v2/users/player-1`, { method: "DELETE", headers: AUTH })).json()) as any;
    expect(erased).toMatchObject({ erased: true, memories: 1, runs: 1 });
    const after = (await (await fetch(`${base}/api/v2/users/player-1`, { headers: AUTH })).json()) as any;
    expect(after).toMatchObject({ memories: [], consent: null, session: { messages: [] }, outcomes: [], tasks: {}, runs: [] });
    expect(await deps.consents.get(owner("player-2"))).toMatchObject({ version: 2 });
    // The run still counts, as nobody's; the other player is untouched.
    expect(deps.runs.all.map((r) => r.user_id)).toEqual(["erased", deps.pseudonyms.of("player-2")]);
    expect((await deps.history.load(thread("player-2"))).messages).not.toEqual([]);
  });
});
