import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { serve, type Server } from "bun";
import { APICallError } from "ai";
import { routes } from "../src/application/routes";
import { handleAsk } from "../src/features/ask/ask.controller";
import { handleAskX } from "../src/features/askx/askx.controller";
import { type Billing, createLicense } from "../src/features/billing/billing";
import { isPrivateAddress, resetChecks } from "../src/features/billing/byok";
import { handleLicense } from "../src/features/billing/license.controller";
import { Limiter } from "../src/features/billing/limits";
import { allocate, planOf, quotaOf, windowsFor } from "../src/features/billing/plans";
import { handleChat, handleToolResult } from "../src/features/chat/chat.controller";
import { handleHealth } from "../src/features/health/health.controller";
import { handleUpdate, refundLicense } from "../src/features/telegram/telegram.bot";
import type { TelegramApi } from "../src/features/telegram/telegram.client";
import { handleTelegram } from "../src/features/telegram/telegram.controller";
import { handleConsent, handleMemories, handleMemory, handleSession, handleUser } from "../src/features/users/users.controller";
import type { GrantRecord } from "../src/infrastructure/billing/licenses";
import { AUTH, fakeNet, finish, readSse, scripted, testBilling, testDeps, text, toolCall } from "./helpers";

const handlers = {
  handleAsk, handleAskX, handleChat, handleToolResult, handleHealth, handleUser, handleSession, handleConsent, handleMemories, handleMemory, handleLicense, handleTelegram,
};
let server: Server<undefined> | undefined;

/** Response bodies as the tests read them. */
const body = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

beforeEach(() => resetChecks());
afterEach(() => server?.stop(true));

const start = (deps: ReturnType<typeof testDeps>) => {
  server = serve({ port: 0, routes: routes(deps, handlers) });
  return `http://localhost:${server.port}`;
};

/** A license made straight in the store, as `POST /api/v2/license` would: what a BYOK plugin sends as its identity. */
const licensed = async (billing: Billing) => ({ Authorization: `Bearer ${(await createLicense(billing)).license}` });

/** A question; without headers, from a self-hosted backend's own plugin. */
const chat = (base: string, body: object, headers: Record<string, string> = AUTH) =>
  fetch(`${base}/api/v2/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...headers },
    body: JSON.stringify({ user_id: "player-1", player: { name: "Steve" }, message: "hi", server: { id: "srv-1" }, ...body }),
  });

const DAY = 86_400_000;
const T0 = new Date("2026-10-14T10:00:00Z");

/** A fake Bot API: records every call and answers what the bot needs. */
const fakeTelegram = () => {
  const calls: Array<{ method: string; params: any }> = [];
  const api: TelegramApi = {
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      if (method === "createInvoiceLink") return `https://t.me/$invoice-${calls.length}` as T;
      return true as T;
    },
  };
  return { api, calls, last: (method: string) => calls.filter((c) => c.method === method).at(-1)?.params };
};

const user = (id = 7, language_code = "en") => ({ id, language_code });
const dm = (id = 7) => ({ id, type: "private" });
const message = (text: string, from = user()) => ({ update_id: 1, message: { message_id: 1, from, chat: dm(from.id), text } });

const payment = (plan: string, license: string, charge: string, extra: object = {}) => ({
  update_id: 2,
  message: {
    message_id: 2,
    from: user(),
    chat: dm(),
    successful_payment: {
      currency: "XTR",
      total_amount: planOf(plan)!.stars,
      invoice_payload: `${plan}:${license}`,
      telegram_payment_charge_id: charge,
      ...extra,
    },
  },
});

/** A billing backend with a clock the test moves, a license made through the API, and a fake bot. */
const hosted = async (model = scripted([[...text("Hello."), finish()]]).model) => {
  let now = T0;
  const billing: Billing = testBilling({ enabled: true, now: () => now });
  const telegram = fakeTelegram();
  billing.bot.api = telegram.api;
  billing.bot.secret = "s3cret";
  const deps = testDeps(model, { billing });
  const base = start(deps);
  const created = await body(fetch(`${base}/api/v2/license`, { method: "POST", body: JSON.stringify({ name: "§aMoon§rlands  SMP" }) }));
  const code = new URL(created.pay_url).searchParams.get("start")!;
  return {
    billing, telegram, deps, base, created, code,
    auth: { Authorization: `Bearer ${created.license}` },
    tick: (ms: number) => (now = new Date(now.getTime() + ms)),
    pay: async (plan: string, charge: string, extra: object = {}) => {
      await handleUpdate(billing, telegram.api, payment(plan, created.license_id, charge, extra) as any);
    },
  };
};

describe("plans and quotas", () => {
  const grants = (windows: ReturnType<typeof windowsFor>): GrantRecord[] =>
    windows.map((w, i) => ({ ...w, id: `g${i}`, license: "l", spent: 0 }));

  test("a payment during a period adds its money at once and moves the end", () => {
    const month = windowsFor(planOf("month")!, T0, null);
    expect(month).toEqual([{ budget: 3, starts: T0, ends: new Date(T0.getTime() + 30 * DAY) }]);
    const later = new Date(T0.getTime() + 10 * DAY);
    const week = windowsFor(planOf("week")!, later, month[0].ends);
    expect(week[0]).toEqual({ budget: 0.75, starts: later, ends: new Date(T0.getTime() + 37 * DAY) });
    const quota = quotaOf(grants([...month, ...week]), later);
    expect(quota.remaining).toBe(3.75);
    expect(quota.paidUntil).toEqual(new Date(T0.getTime() + 37 * DAY));
  });

  test("a year refills monthly: twelve windows, one open at a time", () => {
    const year = grants(windowsFor(planOf("year")!, T0, null));
    expect(year).toHaveLength(12);
    expect(year.at(-1)!.ends).toEqual(new Date(T0.getTime() + 365 * DAY));
    const spent = year.map((g, i) => (i === 0 ? { ...g, spent: 6.2 } : g));
    const quota = quotaOf(spent, new Date(T0.getTime() + DAY));
    expect(quota).toMatchObject({ active: true, remaining: 0, usedPercent: 100 });
    // Used up: it refills when the next window opens.
    expect(quota.resetsAt).toEqual(year[1].starts);
  });

  test("costs go to the window that ends first, and an overshoot still lands", () => {
    const g: GrantRecord[] = [
      { id: "late", license: "l", budget: 3, spent: 0, starts: T0, ends: new Date(T0.getTime() + 30 * DAY) },
      { id: "soon", license: "l", budget: 0.75, spent: 0.7, starts: T0, ends: new Date(T0.getTime() + 7 * DAY) },
    ];
    expect(allocate(g, 0.1, T0)).toEqual([{ grant: "soon", usd: expect.closeTo(0.05, 6) }, { grant: "late", usd: expect.closeTo(0.05, 6) }]);
    const spent = g.map((x) => ({ ...x, spent: x.budget }));
    expect(allocate(spent, 0.01, T0)).toEqual([{ grant: "soon", usd: 0.01 }]);
  });

  test("the limiter counts per window, frees slots, and says when to come back", () => {
    const limiter = new Limiter([{ ms: 60_000, max: 2 }], 1);
    const first = limiter.take("a", 0);
    expect(first.ok).toBe(true);
    expect(limiter.take("a", 1)).toEqual({ ok: false, retryAfter: 5 });
    if (first.ok) first.release();
    expect(limiter.take("a", 2).ok).toBe(true);
    expect(limiter.take("a", 3)).toEqual({ ok: false, retryAfter: 60 });
    expect(limiter.take("b", 3).ok).toBe(true);
  });

  test("private addresses are refused, public ones pass", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("licenses", () => {
  test("a self-hosted backend needs no license and says so", async () => {
    const deps = testDeps(scripted([[...text("Hi."), finish()]]).model);
    const base = start(deps);
    expect(await body(fetch(`${base}/api/v2/license`, { method: "POST" }))).toEqual({ billing: false });
    expect((await body(fetch(`${base}/api/health`))).billing).toBe(false);
    const events = await readSse(await chat(base, {}));
    expect(events.at(-1)!.event).toBe("done");
  });

  test("a new license has a secret, a one-time claim code, and a payment link; its status shows nothing paid", async () => {
    const h = await hosted();
    expect(h.created.license).toMatch(/^[A-Za-z0-9]+\.[A-Za-z0-9_-]{40,}$/);
    expect(h.created.pay_url).toStartWith("https://t.me/allay_test_bot?start=");
    expect((await h.billing.licenses.get(h.created.license_id))!.name).toBe("Moonlands SMP");
    // Only a digest of the secret is kept.
    expect(JSON.stringify(await h.billing.licenses.get(h.created.license_id))).not.toContain(h.created.license.split(".")[1]);
    const status = await body(fetch(`${h.base}/api/v2/license`, { headers: h.auth }));
    expect(status).toMatchObject({ billing: true, linked: false, active: false, plan: null, paid_until: null, renews: false, quota: { used_percent: 0, resets_at: null } });

    const again = await body(fetch(`${h.base}/api/v2/license`, { method: "POST", headers: h.auth }));
    expect(again.license).toBeUndefined();
    expect(again.claim_code).not.toBe(h.code);
    const wrong = await fetch(`${h.base}/api/v2/license`, { headers: { Authorization: `Bearer ${h.created.license_id}.nope` } });
    expect(wrong.status).toBe(401);
    expect((await body(wrong)).error.code).toBe("LICENSE_INVALID");
  });

  test("new licenses count per client address, read from a trusted proxy only", async () => {
    const billing = testBilling({ enabled: true });
    const base = start(testDeps(scripted([]).model, { billing }));
    const make = (forwarded: string) => fetch(`${base}/api/v2/license`, { method: "POST", headers: { "X-Forwarded-For": forwarded } });
    // Nobody is trusted: the header is the client's own word, and every request counts against the peer.
    for (let i = 0; i < 10; i++) expect((await make(`203.0.113.${i}`)).status).toBe(200);
    expect((await make("203.0.113.99")).status).toBe(429);

    process.env.TRUSTED_PROXIES = "127.0.0.1, ::1";
    try {
      const behind = start(testDeps(scripted([]).model, { billing: testBilling({ enabled: true }) }));
      const via = (forwarded: string) => fetch(`${behind}/api/v2/license`, { method: "POST", headers: { "X-Forwarded-For": forwarded } });
      for (let i = 0; i < 10; i++) expect((await via("198.51.100.7")).status).toBe(200);
      expect((await via("198.51.100.7")).status).toBe(429);
      // Behind the proxy, another client has its own count; a value the client put first doesn't fool it.
      expect((await via("198.51.100.8")).status).toBe(200);
      expect((await via("198.51.100.7, 198.51.100.9")).status).toBe(200);
      expect((await via("198.51.100.9, 198.51.100.7")).status).toBe(429);
    } finally {
      delete process.env.TRUSTED_PROXIES;
    }
  });

  test("without a bot there are no payment links", async () => {
    const billing = testBilling({ enabled: true });
    billing.bot.username = undefined;
    const base = start(testDeps(scripted([]).model, { billing }));
    const response = await fetch(`${base}/api/v2/license`, { method: "POST" });
    expect(response.status).toBe(503);
    expect((await body(response)).error.code).toBe("BILLING_UNAVAILABLE");
  });
});

describe("the subscription gate", () => {
  test("no license, an unpaid one, then a paid one: each gets its answer", async () => {
    const h = await hosted();
    const none = await chat(h.base, {}, {});
    expect(none.status).toBe(401);
    expect((await body(none)).error.code).toBe("LICENSE_REQUIRED");
    const unpaid = await chat(h.base, {}, h.auth);
    expect((await body(unpaid)).error.code).toBe("SUBSCRIPTION_INACTIVE");

    await h.pay("week", "charge-1");
    const events = await readSse(await chat(h.base, {}, h.auth));
    expect(events.at(-1)!.event).toBe("done");
    const status = await body(fetch(`${h.base}/api/v2/license`, { headers: h.auth }));
    expect(status).toMatchObject({ active: true, plan: "week", paid_until: new Date(T0.getTime() + 7 * DAY).toISOString() });
    expect(status.last_payment_at).toBe(T0.toISOString());
  });

  test("hosted runs ignore the plugin's model and charge what the run cost, search included", async () => {
    const { model } = scripted([
      [toolCall("search_web", { query: "26.3" }), finish("tool-calls")],
      [...text("Copper golems."), finish()],
    ]);
    const h = await hosted(model);
    await h.pay("week", "charge-1");
    await readSse(await chat(h.base, { provider: { model: "gpt-ultra", base_url: "https://example.com" } }, h.auth));
    expect(h.deps.lastProvider).toBeUndefined();
    expect(h.deps.lastModel).toBeUndefined();
    await Bun.sleep(20);
    const [grant] = await h.billing.licenses.grants(h.created.license_id);
    // Two model steps at $0.0005 and a search at $0.002.
    expect(grant.spent).toBeCloseTo(0.003, 6);
  });

  test("a used-up week waits for a payment; a used-up year month says when it refills", async () => {
    const h = await hosted();
    await h.pay("week", "charge-1");
    const [week] = await h.billing.licenses.grants(h.created.license_id);
    await h.billing.licenses.charge(week.id, 0.75);
    const spent = await chat(h.base, {}, h.auth);
    expect(spent.status).toBe(402);
    const refusal = await body(spent);
    expect(refusal.error.code).toBe("QUOTA_EXCEEDED");
    expect(refusal.error.resets_at).toBeUndefined();

    await h.pay("year", "charge-2");
    const year = (await h.billing.licenses.grants(h.created.license_id)).filter((g) => g.payment === "charge-2");
    await h.billing.licenses.charge(year[0].id, 6);
    const waiting = await body(chat(h.base, {}, h.auth));
    expect(waiting.error.code).toBe("QUOTA_EXCEEDED");
    expect(waiting.error.resets_at).toBe(year[1].starts.toISOString());
    h.tick(31 * DAY);
    expect((await readSse(await chat(h.base, {}, h.auth))).at(-1)!.event).toBe("done");
  });

  test("the period ends", async () => {
    const h = await hosted();
    await h.pay("week", "charge-1");
    h.tick(8 * DAY);
    expect((await body(chat(h.base, {}, h.auth))).error.code).toBe("SUBSCRIPTION_INACTIVE");
  });

  test("v1 endpoints need a license or a key too", async () => {
    const h = await hosted();
    const response = await fetch(`${h.base}/api/ask`, { method: "POST", body: JSON.stringify({ question: "hi" }) });
    expect(response.status).toBe(401);
    expect((await body(response)).code).toBe("LICENSE_REQUIRED");
  });
});

describe("bring your own key", () => {
  const catalog = {
    "https://openrouter.ai/api/v1/models": () =>
      Response.json({
        data: [
          { id: "openai/gpt-6-luna", supported_parameters: ["tools", "reasoning"] },
          { id: "~anthropic/claude-haiku-latest", supported_parameters: ["tools", "reasoning"] },
          { id: "perplexity/sonar", supported_parameters: ["web_search_options"] },
          { id: "some/no-tools", supported_parameters: ["temperature"] },
        ],
      }),
  };

  test("the run uses the server's key, base URL, and model, and offers no search without a search model", async () => {
    const { model, offered } = scripted([[...text("Hi."), finish()]]);
    const deps = testDeps(model, { billing: testBilling({ enabled: true, net: fakeNet(catalog) }) });
    const base = start(deps);
    const events = await readSse(
      await chat(base, { provider: { base_url: "https://api.example.com/v1", model: "llama-4" }, tools: ["get_world"] }, { ...(await licensed(deps.billing)), "X-Provider-Key": "sk-own-key-123456" }),
    );
    expect(events.at(-1)!.event).toBe("done");
    expect(deps.lastProvider).toMatchObject({ baseURL: "https://api.example.com/v1", apiKey: "sk-own-key-123456", model: "llama-4", searchModel: undefined });
    // Its requests go through the guard that checks every address and refuses redirects.
    expect(typeof (deps.lastProvider as { fetch?: unknown }).fetch).toBe("function");
    expect(offered[0]).not.toContain("search_web");
    expect(offered[0]).toContain("get_world");
  });

  test("the v1 header still works, as OpenRouter with the backend's models and search", async () => {
    const { model, offered } = scripted([[...text("Hi."), finish()]]);
    const deps = testDeps(model, { billing: testBilling({ enabled: true, net: fakeNet(catalog) }) });
    const base = start(deps);
    await readSse(await chat(base, {}, { ...(await licensed(deps.billing)), "X-OpenRouter-Token": "sk-or-old-header-1" }));
    expect(deps.lastProvider).toMatchObject({ baseURL: "https://openrouter.ai/api/v1", apiKey: "sk-or-old-header-1", model: "~anthropic/claude-haiku-latest" });
    expect(offered[0]).toContain("search_web");
  });

  const refusedWith = async (block: object, net = fakeNet(catalog), key = "sk-or-v1-abcdef123456") => {
    const deps = testDeps(scripted([[...text("Hi."), finish()]]).model, { billing: testBilling({ enabled: true, net }) });
    const response = await chat(start(deps), { provider: block }, { ...(await licensed(deps.billing)), "X-Provider-Key": key });
    return { status: response.status, error: (await body(response)).error };
  };

  test("a backend with billing on refuses http and private addresses", async () => {
    expect((await refusedWith({ base_url: "http://api.example.com/v1", model: "m" })).error.code).toBe("PROVIDER_URL_REJECTED");
    expect((await refusedWith({ base_url: "https://redis.internal/v1", model: "m" })).error.code).toBe("PROVIDER_URL_REJECTED");
    expect((await refusedWith({ base_url: "https://169.254.169.254/v1", model: "m" })).error.code).toBe("PROVIDER_URL_REJECTED");
  });

  test("OpenRouter: a refused key, an unknown model, and a model without tools each get their code", async () => {
    const net = fakeNet({ ...catalog, "https://openrouter.ai/api/v1/key": () => new Response("{}", { status: 401 }) });
    expect(await refusedWith({ model: "openai/gpt-6-luna" }, net)).toMatchObject({ status: 401, error: { code: "PROVIDER_AUTH_FAILED" } });
    resetChecks();
    expect((await refusedWith({ model: "nobody/nothing" })).error.code).toBe("MODEL_NOT_FOUND");
    expect((await refusedWith({ model: "some/no-tools" })).error.code).toBe("MODEL_NO_TOOLS");
    expect((await refusedWith({ model: "openai/gpt-6-luna", search_model: "perplexity/nope" })).error.code).toBe("MODEL_NOT_FOUND");
  });

  test("another API: its /models answers for the key and the model", async () => {
    const net = fakeNet({ "https://api.example.com/v1/models": () => Response.json({ data: [{ id: "llama-4" }] }) });
    expect((await refusedWith({ base_url: "https://api.example.com/v1", model: "gpt-9" }, net)).error.code).toBe("MODEL_NOT_FOUND");
    expect((await refusedWith({ base_url: "https://api.example.com/v1" }, net)).error.code).toBe("MODEL_NOT_FOUND");
  });

  test("a provider's error mid-run gets a clear code and never shows the key", async () => {
    const key = "sk-secret-key-0123456789";
    const failing = scripted([]).model;
    failing.doStream = async () => {
      throw new APICallError({
        message: `Incorrect API key provided: ${key}`,
        url: "https://api.example.com/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 401,
        isRetryable: false,
      });
    };
    const deps = testDeps(failing, { billing: testBilling({ enabled: true }) });
    const base = start(deps);
    const events = await readSse(await chat(base, { provider: { base_url: "https://api.example.com/v1", model: "m" } }, { ...(await licensed(deps.billing)), "X-Provider-Key": key }));
    const error = events.find((e) => e.event === "error")!;
    expect(error.data.code).toBe("PROVIDER_AUTH_FAILED");
    expect(JSON.stringify(events)).not.toContain(key);
  });

  test("a server gets 20 questions a minute, counted by its license, not by what the body claims", async () => {
    const deps = testDeps(scripted([[...text("Hi."), finish()]]).model, { billing: testBilling({ enabled: true, net: fakeNet(catalog) }) });
    const base = start(deps);
    const headers = { ...(await licensed(deps.billing)), "X-Provider-Key": "sk-or-v1-abcdef123456" };
    for (let i = 0; i < 20; i++) await readSse(await chat(base, {}, headers));
    const response = await chat(base, {}, headers);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    expect((await body(response)).error).toMatchObject({ code: "RATE_LIMITED", retry_after: expect.any(Number) });
    // Another server id in the body changes nothing: before 6.0 it was a fresh count for the asking.
    expect((await chat(base, { server: { id: "srv-2" } }, headers)).status).toBe(429);
    // Another license is another server, with its own count.
    expect((await chat(base, {}, { ...(await licensed(deps.billing)), "X-Provider-Key": "sk-or-v1-abcdef123456" })).status).toBe(200);
  });

  test("a key alone identifies nobody: without a license a hosted backend refuses it", async () => {
    const deps = testDeps(scripted([[...text("Hi."), finish()]]).model, { billing: testBilling({ enabled: true, net: fakeNet(catalog) }) });
    const response = await chat(start(deps), {}, { "X-Provider-Key": "sk-or-v1-abcdef123456" });
    expect(response.status).toBe(401);
    expect((await body(response)).error.code).toBe("LICENSE_REQUIRED");
  });

  test("a blocked server can't ask with its own key either", async () => {
    const deps = testDeps(scripted([[...text("Hi."), finish()]]).model, { billing: testBilling({ enabled: true, net: fakeNet(catalog) }) });
    const made = await createLicense(deps.billing);
    await deps.billing.licenses.update(made.license_id, { blocked_at: new Date() });
    const response = await chat(start(deps), {}, { Authorization: `Bearer ${made.license}`, "X-Provider-Key": "sk-or-v1-abcdef123456" });
    expect((await body(response)).error.code).toBe("SUBSCRIPTION_INACTIVE");
  });

  test("free servers together never take more than BYOK_ACTIVE_RUNS slots", () => {
    const deps = testDeps(scripted([]).model, { billing: testBilling({ enabled: true }) });
    const total = deps.billing.limits.byokTotal;
    const taken = Array.from({ length: 100 }, () => total.take("all"));
    expect(taken.every((t) => t.ok)).toBe(true);
    expect(total.take("all").ok).toBe(false);
    if (taken[0].ok) taken[0].release();
    expect(total.take("all").ok).toBe(true);
  });

  test("a self-hosted backend takes any URL and has no limits", async () => {
    const deps = testDeps(scripted([[...text("Hi."), finish()]]).model, { billing: testBilling({ enabled: false }) });
    const base = start(deps);
    const events = await readSse(await chat(base, { provider: { base_url: "http://localhost:11434/v1", model: "qwen3" } }, { ...AUTH, "X-Provider-Key": "ollama-local-key" }));
    expect(events.at(-1)!.event).toBe("done");
    expect(deps.lastProvider).toMatchObject({ baseURL: "http://localhost:11434/v1" });
    expect(deps.lastModel).toBeUndefined();
  });

  test("a self-hosted backend without a key runs the plugin's model on its own key", async () => {
    const { model } = scripted([[...text("Hi."), finish()]]);
    const deps = testDeps(model, { billing: testBilling({ enabled: false }) });
    const base = start(deps);
    await readSse(await chat(base, { provider: { model: "anthropic/claude-vip", base_url: "https://example.com" } }));
    expect(deps.lastProvider).toBeUndefined();
    expect(deps.lastModel).toBe("anthropic/claude-vip");
    await readSse(await chat(base, {}));
    expect(deps.lastModel).toBeUndefined();
  });
});

describe("Solo licenses", () => {
  /** A hosted backend whose license came from a player's own game, while Solo plans are on. */
  const solo = async () => {
    process.env.SOLO_PLANS = "true";
    const h = await hosted();
    const made = await body(fetch(`${h.base}/api/v2/license`, { method: "POST", body: JSON.stringify({ name: "Steve", loader: "fabric", side: "client" }) }));
    return { ...h, made, soloAuth: { Authorization: `Bearer ${made.license}` } };
  };
  afterEach(() => delete process.env.SOLO_PLANS);

  test("a license from a player's game is Solo only while Solo plans are on; one from a server never", async () => {
    const h = await solo();
    expect((await h.billing.licenses.get(h.made.license_id))!.kind).toBe("solo");
    expect((await h.billing.licenses.get(h.created.license_id))!.kind).toBeUndefined();
    expect(await body(fetch(`${h.base}/api/v2/license`, { headers: h.soloAuth }))).toMatchObject({ kind: "solo", bound: false });
    expect(await body(fetch(`${h.base}/api/v2/license`, { headers: h.auth }))).toMatchObject({ kind: "server" });
    delete process.env.SOLO_PLANS;
    const later = await body(fetch(`${h.base}/api/v2/license`, { method: "POST", body: JSON.stringify({ side: "integrated" }) }));
    expect((await h.billing.licenses.get(later.license_id))!.kind).toBeUndefined();
  });

  test("the first player takes a Solo license; anyone else is refused before anything runs", async () => {
    const h = await solo();
    await h.billing.licenses.grant(h.made.license_id, { budget: 1, starts: T0, ends: new Date(T0.getTime() + 7 * DAY) });
    const first = await readSse(await chat(h.base, { user_id: "player-1" }, h.soloAuth));
    expect(first.at(-1)!.event).toBe("done");
    const license = (await h.billing.licenses.get(h.made.license_id))!;
    // The license keeps the player by pseudonym, never by id.
    expect(license.player).toMatch(/^p_[0-9a-f]{20}$/);
    expect(license.player_bound_at).toEqual(T0);
    const other = await chat(h.base, { user_id: "player-2" }, h.soloAuth);
    expect(other.status).toBe(403);
    expect((await body(other)).error.code).toBe("SOLO_PLAYER_TAKEN");
    const v1 = await fetch(`${h.base}/api/ask`, { method: "POST", headers: h.soloAuth, body: JSON.stringify({ question: "hi", user_id: "player-3" }) });
    expect((await body(v1)).code).toBe("SOLO_PLAYER_TAKEN");
    expect((await readSse(await chat(h.base, { user_id: "player-1" }, h.soloAuth))).at(-1)!.event).toBe("done");
    // A server's license answers everyone, as before.
    await h.pay("week", "charge-1");
    expect((await readSse(await chat(h.base, { user_id: "player-2" }, h.auth))).at(-1)!.event).toBe("done");
  });

  test("the bot sells a Solo license Solo plans only, and hands it to another player once a while", async () => {
    const h = await solo();
    const code = new URL(h.made.pay_url).searchParams.get("start")!;
    await handleUpdate(h.billing, h.telegram.api, message(`/start ${code}`) as any);
    const id = h.made.license_id;
    expect(h.telegram.last("sendMessage").reply_markup.inline_keyboard.map((row: any) => row[0].callback_data)).toEqual([
      `buy:solo_week:${id}`, `buy:solo_month:${id}`, `buy:solo_year:${id}`,
    ]);
    const callback = (data: string) =>
      handleUpdate(h.billing, h.telegram.api, { update_id: 3, callback_query: { id: "cb", from: user(), message: { chat: { id: 7 } }, data } } as any);
    // A server's plan isn't for sale to it, and the pre-checkout refuses one too.
    const invoices = h.telegram.calls.filter((c) => c.method === "createInvoiceLink").length;
    await callback(`buy:week:${id}`);
    expect(h.telegram.calls.filter((c) => c.method === "createInvoiceLink")).toHaveLength(invoices);
    await handleUpdate(h.billing, h.telegram.api, {
      update_id: 4,
      pre_checkout_query: { id: "pc", from: user(), currency: "XTR", total_amount: planOf("week")!.stars, invoice_payload: `week:${id}` },
    } as any);
    expect(h.telegram.last("answerPreCheckoutQuery")).toMatchObject({ ok: false });
    await callback(`buy:solo_month:${id}`);
    expect(h.telegram.last("createInvoiceLink")).toMatchObject({ prices: [{ amount: planOf("solo_month")!.stars }], subscription_period: 2592000 });

    await h.billing.licenses.bind(id, "p_00000000000000000000", T0);
    await handleUpdate(h.billing, h.telegram.api, message("/status") as any);
    const buttons = h.telegram.last("sendMessage").reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(buttons).toContain(`release:${id}`);
    await callback(`release:${id}`);
    expect((await h.billing.licenses.get(id))!.player).toBeUndefined();
    await h.billing.licenses.bind(id, "p_11111111111111111111", T0);
    // Within SOLO_RELEASE_DAYS the bot says when it may again, and keeps the player.
    await callback(`release:${id}`);
    expect((await h.billing.licenses.get(id))!.player).toBe("p_11111111111111111111");
    h.tick(31 * DAY);
    await callback(`release:${id}`);
    expect((await h.billing.licenses.get(id))!.player).toBeUndefined();

    // With Solo plans off again, a Solo license has nothing to buy.
    delete process.env.SOLO_PLANS;
    await callback(`plans:${id}`);
    expect(h.telegram.last("sendMessage").reply_markup).toBeUndefined();
  });
});

describe("the Telegram bot", () => {
  test("a claim code ties the server to the account once and offers the plans", async () => {
    const h = await hosted();
    await handleUpdate(h.billing, h.telegram.api, message(`/start ${h.code}`) as any);
    const license = (await h.billing.licenses.get(h.created.license_id))!;
    expect(license).toMatchObject({ telegram_user_id: 7, telegram_chat_id: 7, language: "en" });
    const sent = h.telegram.calls.filter((c) => c.method === "sendMessage");
    expect(sent[0].params.text).toContain("Moonlands SMP");
    expect(sent[1].params.reply_markup.inline_keyboard.map((row: any) => row[0].callback_data)).toEqual([
      `buy:week:${license.id}`, `buy:month:${license.id}`, `buy:year:${license.id}`,
    ]);
    // The code works once.
    await handleUpdate(h.billing, h.telegram.api, message(`/start ${h.code}`, user(8, "ru")) as any);
    expect(h.telegram.last("sendMessage").text).toContain("устарела");
    expect((await body(fetch(`${h.base}/api/v2/license`, { headers: h.auth }))).linked).toBe(true);
  });

  test("buying: a Stars invoice, a subscription for the month, a pre-checkout check, and the credit", async () => {
    const h = await hosted();
    await handleUpdate(h.billing, h.telegram.api, message(`/start ${h.code}`) as any);
    const callback = (data: string, from = user()) =>
      handleUpdate(h.billing, h.telegram.api, { update_id: 3, callback_query: { id: "cb", from, message: { chat: { id: from.id } }, data } } as any);

    await callback(`buy:month:${h.created.license_id}`);
    const invoice = h.telegram.last("createInvoiceLink");
    expect(invoice).toMatchObject({ currency: "XTR", prices: [{ amount: 500 }], payload: `month:${h.created.license_id}`, subscription_period: 2592000 });
    expect(h.telegram.last("sendMessage").reply_markup.inline_keyboard[0][0].url).toStartWith("https://t.me/$invoice");
    await callback(`buy:week:${h.created.license_id}`);
    expect(h.telegram.last("createInvoiceLink").subscription_period).toBeUndefined();

    // Someone else's button does nothing.
    await callback(`buy:week:${h.created.license_id}`, user(9));
    expect(h.telegram.last("answerCallbackQuery")).toMatchObject({ show_alert: true });

    const preCheckout = (amount: number) =>
      handleUpdate(h.billing, h.telegram.api, {
        update_id: 4,
        pre_checkout_query: { id: "pc", from: user(), currency: "XTR", total_amount: amount, invoice_payload: `month:${h.created.license_id}` },
      } as any);
    await preCheckout(500);
    expect(h.telegram.last("answerPreCheckoutQuery")).toMatchObject({ ok: true });
    await preCheckout(1);
    expect(h.telegram.last("answerPreCheckoutQuery")).toMatchObject({ ok: false });

    await h.pay("month", "charge-1", { is_recurring: true, is_first_recurring: true });
    await h.pay("month", "charge-1", { is_recurring: true, is_first_recurring: true });
    expect(await h.billing.licenses.grants(h.created.license_id)).toHaveLength(1);
    expect(h.telegram.last("sendMessage").text).toContain("Thank you");
    const status = await body(fetch(`${h.base}/api/v2/license`, { headers: h.auth }));
    expect(status).toMatchObject({ active: true, plan: "month", renews: true, quota: { used_percent: 0 } });

    // A renewal adds a month.
    h.tick(29 * DAY);
    await h.pay("month", "charge-2", { is_recurring: true });
    expect(h.telegram.last("sendMessage").text).toContain("renewed");
    const renewed = await body(fetch(`${h.base}/api/v2/license`, { headers: h.auth }));
    expect(renewed.paid_until).toBe(new Date(T0.getTime() + 60 * DAY).toISOString());

    // Stopping renewal goes to Telegram with the first charge of the subscription.
    await callback(`stop:${h.created.license_id}`);
    expect(h.telegram.last("editUserStarSubscription")).toEqual({ user_id: 7, telegram_payment_charge_id: "charge-1", is_canceled: true });
    expect((await body(fetch(`${h.base}/api/v2/license`, { headers: h.auth }))).renews).toBe(false);
  });

  test("/status lists the servers; /refund works for admins only and closes what was paid", async () => {
    const h = await hosted();
    await handleUpdate(h.billing, h.telegram.api, message(`/start ${h.code}`) as any);
    await h.pay("week", "charge-1");
    await handleUpdate(h.billing, h.telegram.api, message("/status") as any);
    // One server opens as its card.
    expect(h.telegram.last("sendMessage").text).toContain("🖥 Moonlands SMP");
    expect(h.telegram.last("sendMessage").text).toContain("🟢 Active until");

    await handleUpdate(h.billing, h.telegram.api, message("/refund charge-1") as any);
    expect(h.telegram.last("refundStarPayment")).toBeUndefined();
    await handleUpdate(h.billing, h.telegram.api, message("/refund charge-1", user(42)) as any);
    expect(h.telegram.last("refundStarPayment")).toEqual({ user_id: 7, telegram_payment_charge_id: "charge-1" });
    expect(await h.billing.licenses.grants(h.created.license_id)).toHaveLength(0);
    expect((await body(chat(h.base, {}, h.auth))).error.code).toBe("SUBSCRIPTION_INACTIVE");
  });

  test("a revoked license's key, claim code, status line, and invoices stop working", async () => {
    const h = await hosted();
    await handleUpdate(h.billing, h.telegram.api, message(`/start ${h.code}`) as any);
    await h.pay("week", "charge-1");
    const license = (await h.billing.licenses.get(h.created.license_id))!;
    const done = await refundLicense(h.billing, h.telegram.api, license);
    expect(done).toEqual({ stars: planOf("week")!.stars, payments: 1 });
    expect(h.telegram.last("sendMessage").text).toContain("revoked");

    expect((await body(fetch(`${h.base}/api/v2/license`, { headers: h.auth }))).error.code).toBe("LICENSE_INVALID");
    expect((await body(chat(h.base, {}, h.auth))).error.code).toBe("LICENSE_INVALID");
    await handleUpdate(h.billing, h.telegram.api, message("/status") as any);
    expect(h.telegram.last("sendMessage").text).not.toContain("Moonlands SMP");
    await handleUpdate(h.billing, h.telegram.api, {
      update_id: 5,
      pre_checkout_query: { id: "pc", from: user(), currency: "XTR", total_amount: planOf("week")!.stars, invoice_payload: `week:${license.id}` },
    } as any);
    expect(h.telegram.last("answerPreCheckoutQuery")).toMatchObject({ ok: false });
  });

  test("a payment that didn't reach the books comes again and counts once", async () => {
    const h = await hosted();
    await handleUpdate(h.billing, h.telegram.api, message(`/start ${h.code}`) as any);
    // The payment is written, then the database goes away before its windows.
    const pay = h.billing.licenses.pay.bind(h.billing.licenses);
    let broken = true;
    h.billing.licenses.pay = async (record, windows) => {
      if (!broken) return pay(record, windows);
      broken = false;
      await pay(record, []);
      throw new Error("MongoDB went away");
    };
    const deliver = () =>
      fetch(`${h.base}/api/telegram/webhook`, {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "s3cret" },
        body: JSON.stringify(payment("week", h.created.license_id, "charge-1")),
      });
    // Telegram hears a failure, so it delivers the payment again.
    expect((await deliver()).status).toBe(500);
    expect(await h.billing.licenses.grants(h.created.license_id)).toHaveLength(0);
    expect((await deliver()).status).toBe(200);
    expect(await h.billing.licenses.grants(h.created.license_id)).toHaveLength(1);
    expect(h.telegram.last("sendMessage").text).toContain("Thank you");
    expect((await deliver()).status).toBe(200);
    expect(await h.billing.licenses.grants(h.created.license_id)).toHaveLength(1);
  });

  test("no second subscription while one renews: Telegram would charge both", async () => {
    const h = await hosted();
    await handleUpdate(h.billing, h.telegram.api, message(`/start ${h.code}`) as any);
    const press = (data: string) =>
      handleUpdate(h.billing, h.telegram.api, { update_id: 3, callback_query: { id: "cb", from: user(), message: { chat: { id: 7 } }, data } } as any);
    const offered = () => h.telegram.last("sendMessage").reply_markup?.inline_keyboard.map((row: any) => row[0].callback_data);
    const id = h.created.license_id;

    await h.pay("month", "charge-1", { is_recurring: true, is_first_recurring: true });
    await press(`plans:${id}`);
    expect(offered()).toEqual([`buy:week:${id}`, `buy:year:${id}`]);
    const invoices = h.telegram.calls.filter((c) => c.method === "createInvoiceLink").length;
    await press(`buy:month:${id}`);
    expect(h.telegram.calls.filter((c) => c.method === "createInvoiceLink")).toHaveLength(invoices);
    expect(h.telegram.last("sendMessage").text).toContain("can't be paid");

    // Once renewal stops, a new subscription is for sale again.
    await press(`stop:${id}`);
    await press(`plans:${id}`);
    expect(offered()).toEqual([`buy:week:${id}`, `buy:month:${id}`, `buy:year:${id}`]);
  });

  test("another account claims the server: the previous payer's renewal stops, and they hear it", async () => {
    const h = await hosted();
    await handleUpdate(h.billing, h.telegram.api, message(`/start ${h.code}`) as any);
    await h.pay("month", "charge-1", { is_recurring: true, is_first_recurring: true });
    const again = await body(fetch(`${h.base}/api/v2/license`, { method: "POST", headers: h.auth }));
    const code = new URL(again.pay_url).searchParams.get("start")!;

    await handleUpdate(h.billing, h.telegram.api, message(`/start ${code}`, user(8)) as any);
    expect(h.telegram.last("editUserStarSubscription")).toEqual({ user_id: 7, telegram_payment_charge_id: "charge-1", is_canceled: true });
    const told = h.telegram.calls.find((c) => c.method === "sendMessage" && c.params.chat_id === 7 && c.params.text.includes("another Telegram account"));
    expect(told?.params.text).toContain("active there until");
    const license = (await h.billing.licenses.get(h.created.license_id))!;
    expect(license).toMatchObject({ telegram_user_id: 8, renews: false });
    expect(license.subscription_charge_id).toBeUndefined();

    // The new account can't resume someone else's subscription, and may start its own.
    await handleUpdate(h.billing, h.telegram.api, message("/status", user(8)) as any);
    const buttons = h.telegram.last("sendMessage").reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(buttons).not.toContain(`resume:${license.id}`);
    expect(h.telegram.calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === 8).at(0)).toBeDefined();
  });

  test("a renewal for a license that's gone goes back with its subscription", async () => {
    const h = await hosted();
    await handleUpdate(h.billing, h.telegram.api, message(`/start ${h.code}`) as any);
    await h.pay("month", "charge-1", { is_recurring: true, is_first_recurring: true });
    await h.billing.licenses.remove(h.created.license_id);
    h.tick(30 * DAY);
    await h.pay("month", "charge-2", { is_recurring: true });
    expect(h.telegram.last("refundStarPayment")).toEqual({ user_id: 7, telegram_payment_charge_id: "charge-2" });
    expect(h.telegram.last("editUserStarSubscription")).toEqual({ user_id: 7, telegram_payment_charge_id: "charge-2", is_canceled: true });
    expect(h.telegram.last("sendMessage").text).toContain("500 ⭐ are back");
    expect(await h.billing.licenses.payment("charge-2")).toBeNull();
  });

  test("the webhook wants Telegram's secret token", async () => {
    const h = await hosted();
    const post = (secret: string) =>
      fetch(`${h.base}/api/telegram/webhook`, {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
        body: JSON.stringify(message("/help")),
      });
    expect((await post("wrong")).status).toBe(401);
    expect((await post("s3cret")).status).toBe(200);
    expect(h.telegram.last("sendMessage").text).toContain("/allay link");
  });

  test("someone who comes to the bot first gets the steps and the download, and any message gets an answer", async () => {
    const h = await hosted();
    await handleUpdate(h.billing, h.telegram.api, message("/start") as any);
    const welcome = h.telegram.last("sendMessage");
    expect(welcome.text).toContain("1️⃣");
    expect(welcome.reply_markup.inline_keyboard[0].map((b: any) => b.url)).toEqual(["https://allay.chat/#install", "https://allay.chat/wiki/plugin/installation/"]);
    await handleUpdate(h.billing, h.telegram.api, message("hello?", user(7, "ru")) as any);
    expect(h.telegram.last("sendMessage").text).toContain("Как начать");
    expect(h.telegram.last("sendMessage").reply_markup.inline_keyboard[0][0].url).toBe("https://allay.chat/ru/#install");

    // With a server, a stray message points to it instead.
    await handleUpdate(h.billing, h.telegram.api, message(`/start ${h.code}`) as any);
    await handleUpdate(h.billing, h.telegram.api, message("hello?") as any);
    expect(h.telegram.last("sendMessage").text).toContain("/ask");
    expect(h.telegram.last("sendMessage").reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data)).toEqual(["list", "howto"]);
  });

  test("several servers are a list; each opens as a card in the same message and goes back", async () => {
    const h = await hosted();
    await handleUpdate(h.billing, h.telegram.api, message(`/start ${h.code}`) as any);
    await h.pay("week", "charge-1");
    const second = await body(fetch(`${h.base}/api/v2/license`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Creative" }) }));
    const code = new URL(second.pay_url).searchParams.get("start")!;
    await handleUpdate(h.billing, h.telegram.api, message(`/start ${code}`) as any);

    await handleUpdate(h.billing, h.telegram.api, message("/status") as any);
    const list = h.telegram.last("sendMessage");
    expect(list.text).toContain("🟢 Moonlands SMP");
    expect(list.text).toContain("⚪️ Creative");
    const buttons = list.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(buttons).toEqual([`server:${h.created.license_id}`, `server:${second.license_id}`, "howto"]);

    const press = (data: string) =>
      handleUpdate(h.billing, h.telegram.api, { update_id: 3, callback_query: { id: "cb", from: user(), message: { message_id: 50, chat: { id: 7 } }, data } } as any);
    await press(`server:${second.license_id}`);
    const card = h.telegram.last("editMessageText");
    expect(card).toMatchObject({ chat_id: 7, message_id: 50 });
    expect(card.text).toContain("⚪️ Not paid");
    expect(card.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data)).toEqual([`plans:${second.license_id}`, "list"]);
    await press("list");
    expect(h.telegram.last("editMessageText").text).toContain("Your servers");
  });
});
