import { afterEach, describe, expect, test } from "bun:test";
import { serve, type Server } from "bun";
import { routes } from "../src/application/routes";
import { envAdminOf } from "../src/features/admin/admin";
import { handleAdmin } from "../src/features/admin/admin.controller";
import { handleAdminInit } from "../src/features/admin/init.controller";
import { handleAsk } from "../src/features/ask/ask.controller";
import { handleAskX } from "../src/features/askx/askx.controller";
import { handleLicense } from "../src/features/billing/license.controller";
import { handleChat, handleToolResult } from "../src/features/chat/chat.controller";
import { handleHealth } from "../src/features/health/health.controller";
import { handleTelegram } from "../src/features/telegram/telegram.controller";
import { handleMemories, handleMemory, handleSession, handleUser } from "../src/features/users/users.controller";
import { AUTH, scripted, testAdmin, testBilling, testDeps, text, finish } from "./helpers";

const handlers = {
  handleAsk, handleAskX, handleChat, handleToolResult, handleHealth, handleUser, handleSession, handleMemories, handleMemory, handleLicense, handleTelegram,
  handleAdminInit, handleAdmin,
};
let server: Server<undefined> | undefined;

afterEach(() => server?.stop(true));

const PASSWORD = "correct horse battery";

const start = (options: Parameters<typeof testAdmin>[0] & { billing?: boolean } = {}) => {
  const { admin, audit, advance } = testAdmin(options);
  const deps = { ...testDeps(scripted([[...text("ok"), finish()]]).model, { billing: testBilling({ enabled: options.billing }) }), admin };
  server = serve({ port: 0, routes: routes(deps, handlers) });
  const base = `http://localhost:${server.port}`;
  let cookie = "";
  /** A browser on the panel's page: same origin, and it keeps the session cookie. */
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { Origin: base, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = response.headers.get("Set-Cookie");
    if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    return { status: response.status, body: (await response.json().catch(() => null)) as any, headers: response.headers };
  };
  /** `/allay init` from the backend's own plugin, or from whoever sends [headers]. */
  const init = (headers: Record<string, string> = AUTH) =>
    fetch(`${base}/api/v2/admin/init`, { method: "POST", headers }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  const codeOf = (url: string) => new URL(url).searchParams.get("code")!;
  return { admin, audit, advance, call, init, codeOf, signOut: () => (cookie = ""), session: () => cookie, deps };
};

describe("setup", () => {
  test("/allay init gives a single-use link that makes the first owner", async () => {
    const { call, init, codeOf, audit } = start({ env: { PUBLIC_URL: "https://mc.example/allay" } });
    expect((await call("GET", "/api/admin/state")).body).toMatchObject({ setup: "init", me: null, selfhosted: true });

    const link = await init();
    expect(link.status).toBe(200);
    expect(link.body.url).toStartWith("https://mc.example/allay/admin/setup?code=");
    const code = codeOf(link.body.url);

    const made = await call("POST", "/api/admin/setup", { code, username: "Mairwunnx", password: PASSWORD });
    expect(made.status).toBe(201);
    expect(made.body.me).toEqual({ username: "mairwunnx", role: "owner", env: false });
    expect(made.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(made.headers.get("Set-Cookie")).toContain("SameSite=Strict");
    expect((await call("GET", "/api/admin/me")).body.me.username).toBe("mairwunnx");

    // The code is spent, and /allay init now hands out recovery links instead.
    expect((await call("POST", "/api/admin/setup", { code, username: "other", password: PASSWORD })).status).toBe(409);
    expect(link.body.mode).toBe("setup");
    expect(await init()).toMatchObject({ status: 200, body: { url: expect.stringMatching(/^https:\/\/mc\.example\/allay\/admin\/recover\?code=/), mode: "recover" } });
    expect(audit.entries.map((e) => e.action)).toContain("setup");
    expect(JSON.stringify(audit.entries)).not.toContain(code);
  });

  test("a code dies after 30 minutes, and a new one replaces the old", async () => {
    const { call, init, codeOf, advance } = start();
    const first = codeOf((await init()).body.url);
    const second = codeOf((await init()).body.url);
    expect((await call("POST", "/api/admin/setup", { code: first, username: "owner", password: PASSWORD })).body.error.code).toBe("BAD_CODE");
    advance(31 * 60_000);
    expect((await call("POST", "/api/admin/setup", { code: second, username: "owner", password: PASSWORD })).body.error.code).toBe("BAD_CODE");
  });

  test("only the backend's own plugin gets a code from /allay init", async () => {
    const { init, admin } = start();
    expect(await init({})).toMatchObject({ status: 401, body: { error: { code: "TOKEN_REQUIRED" } } });
    expect(await init({ Authorization: "Bearer guessed-token-guessed-token-123" })).toMatchObject({ status: 401, body: { error: { code: "TOKEN_INVALID" } } });
    // Nothing was issued for them: a code someone else got would still work otherwise.
    expect(admin.setup.check("anything")).toBe(false);
    expect((await init()).status).toBe(200);
  });

  test("a self-hosted backend without PLUGIN_TOKEN answers no plugin at all", async () => {
    const { init } = start();
    const token = process.env.PLUGIN_TOKEN;
    try {
      delete process.env.PLUGIN_TOKEN;
      expect(await init()).toMatchObject({ status: 503, body: { error: { code: "TOKEN_NOT_SET" } } });
      process.env.PLUGIN_TOKEN = "too-short";
      expect(await init({ Authorization: "Bearer too-short" })).toMatchObject({ status: 503, body: { error: { code: "TOKEN_NOT_SET" } } });
    } finally {
      process.env.PLUGIN_TOKEN = token;
    }
  });

  test("a hosted backend refuses /allay init and takes the log's code", async () => {
    const { init, call, admin } = start({ selfHosted: false, billing: true });
    expect(await init({})).toMatchObject({ status: 401, body: { error: { code: "LICENSE_REQUIRED" } } });
    expect((await call("GET", "/api/admin/state")).body.setup).toBe("log");
    const { code } = admin.setup.issue(null);
    expect((await call("POST", "/api/admin/setup", { code, username: "owner", password: PASSWORD })).status).toBe(201);
  });

  test("an admin from the environment skips setup", async () => {
    const envAdmin = envAdminOf({ ADMIN_USERNAME: "Root", ADMIN_PASSWORD: PASSWORD });
    const { init, call } = start({ envAdmin });
    expect(await init()).toMatchObject({ status: 409, body: { error: { code: "ADMIN_EXISTS" } } });
    expect((await call("GET", "/api/admin/state")).body.setup).toBeNull();
    expect((await call("POST", "/api/admin/login", { username: "root", password: PASSWORD })).body.me).toEqual({ username: "root", role: "owner", env: true });
    expect((await call("DELETE", "/api/admin/accounts/root")).body.error.code).toBe("ENV_ADMIN");
  });

  test("ADMIN_PASSWORD_HASH works instead of the password", async () => {
    const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });
    const envAdmin = envAdminOf({ ADMIN_USERNAME: "root", ADMIN_PASSWORD_HASH: hash })!;
    expect(await envAdmin.verify(PASSWORD)).toBe(true);
    expect(await envAdmin.verify("wrong password")).toBe(false);
  });

  test("a weak password or a bad name is refused", async () => {
    const { call, init, codeOf } = start();
    const code = codeOf((await init()).body.url);
    expect((await call("POST", "/api/admin/setup", { code, username: "owner", password: "short" })).body.fields.password).toBeDefined();
    expect((await call("POST", "/api/admin/setup", { code, username: "a b", password: PASSWORD })).body.fields.username).toBeDefined();
  });
});

const withOwner = async (options: Parameters<typeof start>[0] = {}) => {
  const ctx = start(options);
  // A hosted backend's code comes from its log, not from /allay init.
  const code = options.selfHosted === false ? ctx.admin.setup.issue(null).code : ctx.codeOf((await ctx.init()).body.url);
  await ctx.call("POST", "/api/admin/setup", { code, username: "owner", password: PASSWORD });
  return ctx;
};

describe("recovery", () => {
  const NEW = "a brand new password";

  test("/allay init gives a single-use link that sets a new password and signs in", async () => {
    const { call, init, codeOf, audit, signOut, admin } = await withOwner({ env: { PUBLIC_URL: "https://mc.example/allay" } });
    const link = await init();
    expect(link).toMatchObject({ status: 200, body: { mode: "recover", expires_at: "2026-10-18T12:30:00.000Z" } });
    expect(link.body.url).toStartWith("https://mc.example/allay/admin/recover?code=");
    const code = codeOf(link.body.url);
    // Recovery and setup codes are apart: this one makes no account.
    expect((await call("POST", "/api/admin/setup", { code, username: "intruder", password: NEW })).status).toBe(409);

    signOut();
    const done = await call("POST", "/api/admin/recover", { code, username: "Owner", password: NEW });
    expect(done.status).toBe(200);
    expect(done.body.me).toEqual({ username: "owner", role: "owner", env: false });
    expect(done.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect((await call("GET", "/api/admin/me")).body.me.username).toBe("owner");

    signOut();
    expect((await call("POST", "/api/admin/login", { username: "owner", password: PASSWORD })).status).toBe(401);
    expect((await call("POST", "/api/admin/login", { username: "owner", password: NEW })).status).toBe(200);

    // Spent: the same code doesn't work twice.
    expect((await call("POST", "/api/admin/recover", { code, username: "owner", password: PASSWORD })).body.error.code).toBe("BAD_CODE");
    expect(audit.entries.find((e) => e.action === "recover")).toMatchObject({ actor: "owner", target: "owner" });
    expect(JSON.stringify(audit.entries)).not.toContain(code);
    expect(admin.setup.check(code)).toBe(false);
  });

  test("a new password ends every session of the account", async () => {
    const { call, init, codeOf, signOut, session } = await withOwner();
    const old = session();
    expect((await call("GET", "/api/admin/me")).status).toBe(200);
    const code = codeOf((await init()).body.url);
    // Recover from another browser, then come back with the first one's cookie.
    signOut();
    expect((await call("POST", "/api/admin/recover", { code, username: "owner", password: NEW })).status).toBe(200);
    const fresh = session();
    signOut();
    expect((await call("GET", "/api/admin/me", undefined, { Cookie: old })).status).toBe(401);
    expect((await call("GET", "/api/admin/me", undefined, { Cookie: fresh })).status).toBe(200);
  });

  test("a wrong code is refused, and five lock recovery for a while", async () => {
    const { call, init, codeOf, advance } = await withOwner();
    const code = codeOf((await init()).body.url);
    for (let i = 0; i < 5; i++) {
      const wrong = await call("POST", "/api/admin/recover", { code: `x${i}`, username: "owner", password: NEW });
      expect(wrong).toMatchObject({ status: 400, body: { error: { code: "BAD_CODE" } } });
    }
    // Locked now, even with the right code.
    const locked = await call("POST", "/api/admin/recover", { code, username: "owner", password: NEW });
    expect(locked.status).toBe(429);
    expect(locked.body.retry_after).toBeGreaterThan(0);
    advance(16 * 60_000);
    const fresh = codeOf((await init()).body.url);
    expect((await call("POST", "/api/admin/recover", { code: fresh, username: "owner", password: NEW })).status).toBe(200);
  });

  test("a code dies after 30 minutes, and a new one replaces the old", async () => {
    const { call, init, codeOf, advance } = await withOwner();
    const first = codeOf((await init()).body.url);
    const second = codeOf((await init()).body.url);
    expect((await call("POST", "/api/admin/recover", { code: first, username: "owner", password: NEW })).body.error.code).toBe("BAD_CODE");
    advance(31 * 60_000);
    expect((await call("POST", "/api/admin/recover", { code: second, username: "owner", password: NEW })).body.error.code).toBe("BAD_CODE");
  });

  test("an unknown name keeps the code alive", async () => {
    const { call, init, codeOf } = await withOwner();
    const code = codeOf((await init()).body.url);
    expect((await call("POST", "/api/admin/recover", { code, username: "nobody", password: NEW })).body.error.code).toBe("NO_ACCOUNT");
    expect((await call("POST", "/api/admin/recover", { code, username: "owner", password: NEW })).status).toBe(200);
  });

  test("the environment's admin isn't recovered here, and a weak password is refused", async () => {
    const envAdmin = envAdminOf({ ADMIN_USERNAME: "root", ADMIN_PASSWORD: PASSWORD });
    const { call, init, codeOf } = start({ envAdmin });
    // Only the environment's admin: nothing to recover from the game.
    expect(await init()).toMatchObject({ status: 409, body: { error: { code: "ADMIN_EXISTS" } } });
    await call("POST", "/api/admin/login", { username: "root", password: PASSWORD });
    await call("POST", "/api/admin/accounts", { username: "helper", password: PASSWORD, role: "admin" });
    const code = codeOf((await init()).body.url);
    expect((await call("POST", "/api/admin/recover", { code, username: "root", password: NEW })).body.error.code).toBe("ENV_ADMIN");
    expect((await call("POST", "/api/admin/recover", { code, username: "helper", password: "short" })).body.fields.password).toBeDefined();
    expect((await call("POST", "/api/admin/login", { username: "root", password: PASSWORD })).status).toBe(200);
  });

  test("a hosted backend has no recovery from the game", async () => {
    const { call, init, admin } = await withOwner({ selfHosted: false, billing: true });
    expect(await init({})).toMatchObject({ status: 401, body: { error: { code: "LICENSE_REQUIRED" } } });
    const { code } = admin.recovery.issue();
    expect((await call("POST", "/api/admin/recover", { code, username: "owner", password: NEW })).body.error.code).toBe("NOT_SELFHOSTED");
  });
});

describe("sign-in", () => {
  test("wrong passwords lock the name for a while", async () => {
    const { call, signOut, advance } = await withOwner();
    signOut();
    for (let i = 0; i < 5; i++) expect((await call("POST", "/api/admin/login", { username: "owner", password: "wrong password!" })).status).toBe(401);
    const locked = await call("POST", "/api/admin/login", { username: "owner", password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.retry_after).toBeGreaterThan(0);
    advance(16 * 60_000);
    expect((await call("POST", "/api/admin/login", { username: "owner", password: PASSWORD })).status).toBe(200);
  });

  test("a request from another site is refused", async () => {
    const { call } = await withOwner();
    expect((await call("PUT", "/api/admin/settings", { version: 0, values: {} }, { Origin: "https://evil.example" })).status).toBe(403);
  });

  test("signing out ends the session", async () => {
    const { call } = await withOwner();
    expect((await call("POST", "/api/admin/logout")).status).toBe(200);
    expect((await call("GET", "/api/admin/me")).status).toBe(401);
  });

  test("a session lasts seven days from its last use", async () => {
    const { call, advance } = await withOwner();
    advance(6 * 86_400_000);
    expect((await call("GET", "/api/admin/me")).status).toBe(200);
    advance(6 * 86_400_000);
    expect((await call("GET", "/api/admin/me")).status).toBe(200);
    advance(8 * 86_400_000);
    expect((await call("GET", "/api/admin/me")).status).toBe(401);
  });
});

describe("roles", () => {
  test("a viewer reads, an admin changes settings, only an owner manages accounts", async () => {
    const { call, signOut } = await withOwner();
    expect((await call("POST", "/api/admin/accounts", { username: "viewer", password: PASSWORD, role: "viewer" })).status).toBe(201);
    expect((await call("POST", "/api/admin/accounts", { username: "helper", password: PASSWORD, role: "admin" })).status).toBe(201);

    signOut();
    await call("POST", "/api/admin/login", { username: "viewer", password: PASSWORD });
    expect((await call("GET", "/api/admin/settings")).status).toBe(200);
    expect((await call("PUT", "/api/admin/settings", { version: 0, values: { MAX_AGENT_STEPS: 9 } })).status).toBe(403);
    expect((await call("GET", "/api/admin/accounts")).status).toBe(403);

    signOut();
    await call("POST", "/api/admin/login", { username: "helper", password: PASSWORD });
    expect((await call("PUT", "/api/admin/settings", { version: 0, values: { MAX_AGENT_STEPS: 9 } })).status).toBe(200);
    expect((await call("GET", "/api/admin/accounts")).status).toBe(403);
  });

  test("a new role or password signs the account out everywhere", async () => {
    const { call, signOut } = await withOwner();
    await call("POST", "/api/admin/accounts", { username: "helper", password: PASSWORD, role: "admin" });
    signOut();
    await call("POST", "/api/admin/login", { username: "helper", password: PASSWORD });
    const helper = await call("GET", "/api/admin/me");
    expect(helper.status).toBe(200);
    signOut();
    await call("POST", "/api/admin/login", { username: "owner", password: PASSWORD });
    await call("PATCH", "/api/admin/accounts/helper", { role: "viewer" });
    signOut();
    // The helper's old cookie is gone; signing in again gives the new role.
    expect((await call("POST", "/api/admin/login", { username: "helper", password: PASSWORD })).body.me.role).toBe("viewer");
  });

  test("the last owner can't be removed or demoted", async () => {
    const { call } = await withOwner();
    expect((await call("PATCH", "/api/admin/accounts/owner", { role: "admin" })).body.error.code).toBe("LAST_OWNER");
    expect((await call("DELETE", "/api/admin/accounts/owner")).body.error.code).toBe("LAST_OWNER");
  });
});

describe("settings in the panel", () => {
  test("a change applies to the next read and lands in the audit log, secrets masked", async () => {
    const { call, admin, audit } = await withOwner();
    const before = (await call("GET", "/api/admin/settings")).body;
    expect(before.fields.find((f: any) => f.key === "MAX_AGENT_STEPS")).toMatchObject({ value: 8, source: "default" });
    // A self-hosted backend has no billing or bot fields.
    expect(before.fields.some((f: any) => f.group === "billing" || f.group === "telegram")).toBe(false);

    const saved = await call("PUT", "/api/admin/settings", { version: before.version, values: { MAX_AGENT_STEPS: 11, PERPLEXITY_API_KEY: "pplx-0123456789abcdefWXYZ" } });
    expect(saved.body).toEqual({ version: 1, changed: ["MAX_AGENT_STEPS", "PERPLEXITY_API_KEY"] });
    expect(admin.settings.get("MAX_AGENT_STEPS")).toBe(11);

    const after = (await call("GET", "/api/admin/settings")).body;
    expect(JSON.stringify(after)).not.toContain("0123456789abcdef");
    const entry = audit.entries.find((e) => e.action === "settings.update")!;
    expect(entry.changes).toEqual([
      { field: "MAX_AGENT_STEPS", old: "unset", new: "11" },
      { field: "PERPLEXITY_API_KEY", old: "unset", new: "set …WXYZ" },
    ]);

    expect((await call("PUT", "/api/admin/settings", { version: 0, values: { MAX_AGENT_STEPS: 12 } })).status).toBe(409);
  });

  test("a field the environment sets is locked", async () => {
    const { call } = await withOwner({ env: { MAX_AGENT_STEPS: "6" } });
    const field = (await call("GET", "/api/admin/settings")).body.fields.find((f: any) => f.key === "MAX_AGENT_STEPS");
    expect(field).toMatchObject({ value: 6, source: "env" });
    expect((await call("PUT", "/api/admin/settings", { version: 0, values: { MAX_AGENT_STEPS: 9 } })).body.error.code).toBe("LOCKED");
  });

  test("a model OpenRouter doesn't know, or one without tools, is refused", async () => {
    const { call, deps } = await withOwner();
    deps.billing.net.fetch = async () => Response.json({ data: [{ id: "good/model", supported_parameters: ["tools"] }, { id: "chat/only", supported_parameters: ["temperature"] }] });
    expect((await call("PUT", "/api/admin/settings", { version: 0, values: { OPENROUTER_API_MODEL: "made/up" } })).body.fields.OPENROUTER_API_MODEL).toContain("doesn't know");
    expect((await call("PUT", "/api/admin/settings", { version: 0, values: { OPENROUTER_API_MODEL: "chat/only" } })).body.fields.OPENROUTER_API_MODEL).toContain("tools");
    expect((await call("PUT", "/api/admin/settings", { version: 0, values: { OPENROUTER_API_MODEL: "good/model" } })).status).toBe(200);
    // An alias that follows a line of models isn't in the catalog, and passes.
    expect((await call("PUT", "/api/admin/settings", { version: 1, values: { OPENROUTER_API_MODEL: "~openai/gpt-luna-latest" } })).status).toBe(200);
  });
});

describe("billing in the panel", () => {
  const paid = async (ctx: Awaited<ReturnType<typeof withOwner>>) => {
    const { billing } = ctx.deps;
    const now = billing.now();
    await billing.licenses.create({ id: "lic1", secret_hash: "x", name: "Moonlands", created_at: now, renews: true, telegram_user_id: 7 });
    await billing.licenses.pay(
      { charge_id: "ch1", license: "lic1", plan: "month", stars: 500, telegram_user_id: 7, at: now, recurring: true },
      [{ budget: 3, starts: new Date(now.getTime() - 1000), ends: new Date(now.getTime() + 30 * 86_400_000) }],
    );
    await billing.licenses.update("lic1", { plan: "month", last_payment_at: now, subscription_charge_id: "ch1" });
  };

  test("a self-hosted backend has no billing pages", async () => {
    const { call } = await withOwner();
    expect((await call("GET", "/api/admin/licenses")).body.error.code).toBe("BILLING_OFF");
  });

  test("licenses show in dollars, and admins grant, extend, and block", async () => {
    const ctx = await withOwner({ selfHosted: false, billing: true });
    await paid(ctx);
    const { call, audit } = ctx;
    const list = (await call("GET", "/api/admin/licenses")).body;
    expect(list.licenses[0]).toMatchObject({ id: "lic1", name: "Moonlands", status: "active", plan: "month", budget: 3, spent: 0, renews: true });

    expect((await call("POST", "/api/admin/licenses/lic1/grant", { usd: 2, days: 10 })).status).toBe(200);
    expect((await call("GET", "/api/admin/licenses/lic1")).body.license.budget).toBe(5);

    const before = (await call("GET", "/api/admin/licenses/lic1")).body.license.paid_until;
    const extended = await call("POST", "/api/admin/licenses/lic1/extend", { days: 7 });
    expect(Date.parse(extended.body.paid_until) - Date.parse(before)).toBe(7 * 86_400_000);

    expect((await call("POST", "/api/admin/licenses/lic1/block")).body.license.status).toBe("blocked");
    expect(audit.entries.map((e) => e.action)).toEqual(expect.arrayContaining(["license.grant", "license.extend", "license.block"]));
  });

  test("a refund goes through the bot and closes the period", async () => {
    const ctx = await withOwner({ selfHosted: false, billing: true });
    await paid(ctx);
    const calls: string[] = [];
    ctx.deps.billing.bot.api = { call: async <T>(method: string) => (calls.push(method), true as T) };
    const refunded = await ctx.call("POST", "/api/admin/payments/ch1/refund");
    expect(refunded.body).toEqual({ refunded: true, stars: 500 });
    expect(calls).toEqual(["refundStarPayment", "editUserStarSubscription"]);
    expect((await ctx.call("GET", "/api/admin/licenses/lic1")).body.license.status).toBe("expired");
    expect((await ctx.call("POST", "/api/admin/payments/ch1/refund")).status).toBe(404);
  });

  test("revenue sums payments by week", async () => {
    const ctx = await withOwner({ selfHosted: false, billing: true });
    await paid(ctx);
    const revenue = (await ctx.call("GET", "/api/admin/billing/revenue?range=30d")).body;
    expect(revenue.totals).toMatchObject({ payments: 1, stars: 500, net_stars: 500, usd: 6.5 });
    expect(revenue.series).toHaveLength(1);
  });
});

describe("players in the panel", () => {
  test("the panel knows players by pseudonym, finds one by id, and an admin erases one on request", async () => {
    const ctx = await withOwner();
    const runs = (await import("../src/infrastructure/runs/runs")).memoryRuns();
    Object.assign(ctx.deps, { runs });
    const { call, deps, audit } = ctx;
    await deps.memories.add({ tenant: "self", userId: "uuid-steve" }, "base at 120 64 -300");
    const pseudonym = deps.pseudonyms.of("uuid-steve");
    await runs.add({
      id: "r1", at: new Date(), kind: "ask", payer: "self", server: "self", user_id: pseudonym, model: "m",
      input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, cost: 0.001, steps: 1, tools: [], searches: 0, duration_ms: 10, result: "ok",
    });
    const list = (await call("GET", "/api/admin/players")).body;
    expect(list.players.map((p: any) => p.user_id)).toEqual([pseudonym]);
    expect(JSON.stringify(list)).not.toContain("uuid-steve");
    // An operator with a player's id finds them; the id itself never shows.
    expect((await call("GET", "/api/admin/players?search=uuid-steve")).body.players.map((p: any) => p.user_id)).toEqual([pseudonym]);
    const detail = (await call("GET", `/api/admin/players/${pseudonym}`)).body;
    expect(detail).toMatchObject({ user_id: pseudonym, questions: 1 });
    expect(detail.memories).toBeUndefined();

    const erased = await call("POST", "/api/admin/players/erase", { server: "self", user_id: "uuid-steve" });
    expect(erased.body).toMatchObject({ erased: true, memories: 1, runs: 1 });
    expect(await deps.memories.list({ tenant: "self", userId: "uuid-steve" })).toEqual([]);
    expect(runs.all[0].user_id).toBe("erased");
    const entry = audit.entries.find((e) => e.action === "player.erase")!;
    expect(entry.target).toBe(`self ${pseudonym}`);
    expect(JSON.stringify(audit.entries)).not.toContain("uuid-steve");
    expect((await call("POST", "/api/admin/players/erase", { server: "anything", user_id: "x" })).status).toBe(400);
  });

  test("a viewer can't erase players or see who paid", async () => {
    const ctx = await withOwner({ selfHosted: false, billing: true });
    const { call, deps } = ctx;
    const now = deps.billing.now();
    await deps.billing.licenses.create({ id: "lic1", secret_hash: "x", name: "Moonlands", created_at: now, renews: false, telegram_user_id: 7 });
    expect((await call("GET", "/api/admin/licenses/lic1")).body.license.telegram_user_id).toBe(7);
    await call("POST", "/api/admin/accounts", { username: "viewer", password: PASSWORD, role: "viewer" });
    await call("POST", "/api/admin/logout");
    await call("POST", "/api/admin/login", { username: "viewer", password: PASSWORD });
    expect((await call("GET", "/api/admin/licenses/lic1")).body.license.telegram_user_id).toBeNull();
    expect((await call("POST", "/api/admin/players/erase", { server: "self", user_id: "uuid-steve" })).status).toBe(403);
  });
});
