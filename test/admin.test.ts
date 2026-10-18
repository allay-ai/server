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
import { handleMemories, handleMemory, handleSession } from "../src/features/users/users.controller";
import { scripted, testAdmin, testBilling, testDeps, text, finish } from "./helpers";

const handlers = {
  handleAsk, handleAskX, handleChat, handleToolResult, handleHealth, handleSession, handleMemories, handleMemory, handleLicense, handleTelegram,
  handleAdminInit, handleAdmin,
};
let server: Server | undefined;

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
  const init = () => fetch(`${base}/api/v2/admin/init`, { method: "POST" }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  const codeOf = (url: string) => new URL(url).searchParams.get("code")!;
  return { admin, audit, advance, call, init, codeOf, signOut: () => (cookie = ""), deps };
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

    // The code is spent, and the backend now only points to the panel.
    expect((await call("POST", "/api/admin/setup", { code, username: "other", password: PASSWORD })).status).toBe(409);
    expect(await init()).toEqual({ status: 409, body: { error: { code: "ADMIN_EXISTS", message: expect.any(String) }, url: "https://mc.example/allay/admin" } });
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

  test("a hosted backend refuses /allay init and takes the log's code", async () => {
    const { init, call, admin } = start({ selfHosted: false, billing: true });
    expect(await init()).toMatchObject({ status: 404, body: { error: { code: "NOT_SELFHOSTED" } } });
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
  const code = ctx.codeOf((await ctx.init()).body.url);
  await ctx.call("POST", "/api/admin/setup", { code, username: "owner", password: PASSWORD });
  return ctx;
};

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
  });
});
