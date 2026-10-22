import { z } from "zod";
import type { GrantRecord, LicenseRecord, PaymentRecord } from "../../infrastructure/billing/licenses";
import { type Billing, licenseName, quotaFor, serverName } from "../billing/billing";
import { INFINITY_DAYS, infinityBudget, quotaOf } from "../billing/plans";
import { LicenseRefundFailure, refundLicense, refundPayment } from "../telegram/telegram.bot";
import { allows, record } from "./admin";
import { type Context, type Route, body, error } from "./admin.http";
import { serversView } from "./insight.routes";
import type { KnownServer } from "../../infrastructure/servers/servers";

const DAY = 86_400_000;

/** A self-hosted backend has no billing, so these pages and their API don't exist there. */
const hosted = (handle: (ctx: Context) => Promise<Response>) => async (ctx: Context) =>
  ctx.deps.billing.enabled ? handle(ctx) : error(404, "BILLING_OFF", "Billing is off on this self-hosted backend");

const iso = (date?: Date | null) => (date ? date.toISOString() : null);

const usd = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

/** A license as the owner's panel shows it: in dollars, unlike what operators see. */
/** Telegram ids are personal data: admins and owners see them, viewers don't need them. */
const seesPayers = (ctx: Context) => !!ctx.me && allows(ctx.me.role, "admin");

/** The license's server as the panel heads it: the newest one with a name, else the newest one. Never its MOTD. */
const headOf = (license: LicenseRecord, known: KnownServer[]) => {
  const own = known.filter((s) => s.tenant === `license:${license.id}`);
  const server = own.find((s) => s.name) ?? own[0];
  return server ? { name: server.name ?? null, address: server.address ?? null } : null;
};

const licenseView = async (billing: Billing, license: LicenseRecord, grants?: GrantRecord[], payers = true, known: KnownServer[] = []) => {
  const now = billing.now();
  const windows = grants ?? (await billing.licenses.grants(license.id));
  const quota = quotaOf(windows, now);
  const open = windows.filter((g) => g.starts <= now && now < g.ends);
  // A license that never paid may still run on a budget an admin gave; the newest such grant stands in for a payment.
  const granted = windows.filter((g) => !g.payment).sort((a, b) => b.starts.getTime() - a.starts.getTime())[0];
  return {
    id: license.id,
    name: licenseName(license, known),
    // The name an owner can edit; the panel shows the server's own name over it.
    own_name: license.name ?? null,
    server: headOf(license, known),
    created_at: iso(license.created_at),
    plan: license.plan ?? null,
    status: license.revoked_at ? "revoked" : license.blocked_at ? "blocked" : quota.active ? "active" : license.last_payment_at ? "expired" : "unpaid",
    paid_until: iso(quota.paidUntil),
    renews: license.renews && quota.active,
    budget: usd(open.reduce((sum, g) => sum + g.budget, 0)),
    spent: usd(open.reduce((sum, g) => sum + g.spent, 0)),
    used_percent: quota.usedPercent,
    resets_at: iso(quota.resetsAt),
    telegram_user_id: payers ? (license.telegram_user_id ?? null) : null,
    language: license.language ?? null,
    last_payment_at: iso(license.last_payment_at),
    granted_at: iso(granted?.starts),
    stopped_at: iso(license.stopped_at),
    blocked_at: iso(license.blocked_at),
    revoked_at: iso(license.revoked_at),
  };
};

const paymentView = (payment: PaymentRecord, payers = true) => ({
  charge_id: payment.charge_id,
  license: payment.license,
  plan: payment.plan,
  stars: payment.stars,
  telegram_user_id: payers ? payment.telegram_user_id : null,
  at: payment.at.toISOString(),
  recurring: payment.recurring,
  refunded_at: iso(payment.refunded_at),
});

const RANGES = { "30d": 30, "90d": 90, "1y": 365 } as const;

/** Payments over a range, by week or month, with what the licenses' runs cost us. */
const revenue = async (ctx: Context, range: keyof typeof RANGES, by: "week" | "month") => {
  const { billing } = ctx.deps;
  const now = billing.now();
  const from = new Date(now.getTime() - RANGES[range] * DAY);
  const payments = await billing.licenses.payments({ from, limit: 100_000 });
  const starUsd = ctx.admin.settings.get("STAR_USD");
  const keyOf = (at: Date) => {
    if (by === "month") return at.toISOString().slice(0, 7);
    // Weeks start on Monday, in UTC.
    const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    return day.toISOString().slice(0, 10);
  };
  const periods = new Map<string, { period: string; stars: number; refunded: number; payments: number; renewals: number; refunds: number }>();
  const seen = new Set<string>();
  // Oldest first, so a license's first payment in the range counts as new.
  for (const payment of [...payments].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const key = keyOf(payment.at);
    const period = periods.get(key) ?? { period: key, stars: 0, refunded: 0, payments: 0, renewals: 0, refunds: 0 };
    period.payments++;
    period.stars += payment.stars;
    if (payment.recurring && seen.has(payment.license)) period.renewals++;
    if (payment.refunded_at) {
      period.refunds++;
      period.refunded += payment.stars;
    }
    seen.add(payment.license);
    periods.set(key, period);
  }
  const series = [...periods.values()].sort((a, b) => a.period.localeCompare(b.period)).map((p) => ({ ...p, usd: usd((p.stars - p.refunded) * starUsd) }));
  const stars = payments.reduce((sum, p) => sum + p.stars, 0);
  const refunded = payments.filter((p) => p.refunded_at).reduce((sum, p) => sum + p.stars, 0);
  const servers = ctx.deps.runs ? await ctx.deps.runs.servers({ limit: 100_000 }) : [];
  return {
    range,
    by,
    star_usd: starUsd,
    series,
    totals: {
      payments: payments.length,
      stars,
      refunded,
      net_stars: stars - refunded,
      usd: usd((stars - refunded) * starUsd),
      renewals: series.reduce((sum, p) => sum + p.renewals, 0),
      refunds: series.reduce((sum, p) => sum + p.refunds, 0),
      cancellations: await billing.licenses.stoppedSince(from),
      // What runs on licenses have cost since they started; the panel compares it with revenue.
      license_cost: usd(servers.filter((s) => s.payer === "license").reduce((sum, s) => sum + s.cost, 0)),
    },
  };
};

const licenseOr404 = async (ctx: Context) => {
  const license = await ctx.deps.billing.licenses.get(ctx.params.id);
  return license ?? null;
};

/** A revoked license is history: nothing changes it any more. */
const revoked = () => error(409, "REVOKED", "This license is revoked");

// Infinity takes no numbers: its budget is PLAN_INFINITY_BUDGET for INFINITY_DAYS.
/** A date as people read it in the audit log: “23 October 2027”, in UTC like the budget's windows. */
const day = (at: Date) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(at);

// What every license holder, or the listed ones, gets through the bot: a breach notice (GDPR art. 33(2)) or news.
const notifySchema = z.object({ text: z.string().trim().min(1).max(3_000), licenses: z.array(z.string().min(1).max(64)).max(1_000).optional() });

/** Telegram takes about 30 messages a second from a bot; this stays well under it. */
export const NOTIFY_GAP_MS = 50;

/** How long Telegram asks to wait after a 429, from its description (“retry after 5”); a second when it doesn't say. */
const retryAfter = (failure: unknown) => Number(/retry after (\d+)/i.exec(String(failure))?.[1] ?? 1) * 1_000;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const grantSchema = z.union([z.object({ plan: z.literal("infinity") }), z.object({ usd: z.number().positive().max(1_000), days: z.number().int().min(1).max(366) })]);
const extendSchema = z.object({ days: z.number().int().min(1).max(366) });
const deleteSchema = z.object({ force: z.boolean().optional() });
// The license's own name for the panel, and the language the bot writes in: Telegram's code, like ru or pt-br.
const editSchema = z
  .object({ name: z.string().trim().min(1).max(64).optional(), language: z.string().trim().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i).nullable().optional() })
  .refine((v) => v.name !== undefined || v.language !== undefined);

export const billingRoutes: Route[] = [
  {
    method: "GET",
    path: "/billing/revenue",
    access: "viewer",
    handle: hosted(async (ctx) => {
      const range = (ctx.url.searchParams.get("range") ?? "90d") as keyof typeof RANGES;
      const by = ctx.url.searchParams.get("by") === "month" ? "month" : "week";
      if (!(range in RANGES)) return error(400, "BAD_REQUEST", `range is one of ${Object.keys(RANGES).join(", ")}`);
      return Response.json(await revenue(ctx, range, by));
    }),
  },
  {
    method: "GET",
    path: "/licenses",
    access: "viewer",
    handle: hosted(async (ctx) => {
      const { deps, url } = ctx;
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const page = Math.max(0, Number(url.searchParams.get("page")) || 0);
      const search = url.searchParams.get("search")?.trim().slice(0, 64) || undefined;
      const { licenses, total } = await deps.billing.licenses.list({ search, limit, skip: page * limit });
      const known = (await deps.servers?.list()) ?? [];
      return Response.json({ total, page, limit, licenses: await Promise.all(licenses.map((l) => licenseView(deps.billing, l, undefined, seesPayers(ctx), known))) });
    }),
  },
  {
    method: "GET",
    path: "/licenses/:id",
    access: "viewer",
    handle: hosted(async (ctx) => {
      const license = await licenseOr404(ctx);
      if (!license) return error(404, "NOT_FOUND", "No such license");
      const { billing } = ctx.deps;
      const grants = await billing.licenses.grants(license.id);
      const [payments, servers] = await Promise.all([
        billing.licenses.payments({ license: license.id, limit: 200 }),
        ctx.deps.runs?.servers({ server: `license:${license.id}`, limit: 100 }) ?? [],
      ]);
      return Response.json({
        license: await licenseView(billing, license, grants, seesPayers(ctx), (await ctx.deps.servers?.list(`license:${license.id}`)) ?? []),
        grants: grants
          .sort((a, b) => a.starts.getTime() - b.starts.getTime())
          .map((g) => ({ id: g.id, payment: g.payment ?? null, budget: usd(g.budget), spent: usd(g.spent), starts: iso(g.starts), ends: iso(g.ends) })),
        payments: payments.map((p) => paymentView(p, seesPayers(ctx))),
        servers: await serversView(ctx, servers, `license:${license.id}`),
      });
    }),
  },
  {
    method: "PATCH",
    path: "/licenses/:id",
    access: "owner",
    handle: hosted(async (ctx) => {
      const license = await licenseOr404(ctx);
      if (!license) return error(404, "NOT_FOUND", "No such license");
      const input = editSchema.safeParse(await body(ctx.req));
      if (!input.success) return error(400, "BAD_REQUEST", "Give a name (1–64 characters) or a language code like ru, or null to clear it");
      const patch: Partial<LicenseRecord> = {};
      const changes: Array<{ field: string; old: string; new: string }> = [];
      if (input.data.name !== undefined && input.data.name !== license.name) {
        patch.name = input.data.name;
        changes.push({ field: "name", old: license.name ?? "", new: input.data.name });
      }
      if (input.data.language !== undefined) {
        const language = input.data.language?.toLowerCase() ?? undefined;
        if (language !== license.language) {
          patch.language = language;
          changes.push({ field: "language", old: license.language ?? "", new: language ?? "" });
        }
      }
      if (changes.length) {
        await ctx.deps.billing.licenses.update(license.id, patch);
        await record(ctx.admin, { actor: ctx.me!.username, action: "license.edit", target: license.id, changes, ip: ctx.ip });
      }
      const known = (await ctx.deps.servers?.list(`license:${license.id}`)) ?? [];
      return Response.json({ license: await licenseView(ctx.deps.billing, (await ctx.deps.billing.licenses.get(license.id))!, undefined, seesPayers(ctx), known) });
    }),
  },
  {
    method: "POST",
    path: "/licenses/:id/grant",
    access: "admin",
    handle: hosted(async (ctx) => {
      const license = await licenseOr404(ctx);
      if (!license) return error(404, "NOT_FOUND", "No such license");
      if (license.revoked_at) return revoked();
      const input = grantSchema.safeParse(await body(ctx.req));
      if (!input.success) return error(400, "BAD_REQUEST", "Give usd (up to 1000) and days (1–366), or plan infinity");
      const infinity = "plan" in input.data;
      if (infinity && !allows(ctx.me!.role, "owner")) return error(403, "FORBIDDEN", "Only an owner grants Infinity");
      const usd = "plan" in input.data ? infinityBudget() : input.data.usd;
      const days = "plan" in input.data ? INFINITY_DAYS : input.data.days;
      const now = ctx.deps.billing.now();
      // The budget is there at once and lasts the given days, or to the end of what's paid, whichever is later.
      const quota = await quotaFor(ctx.deps.billing, license);
      const ends = new Date(Math.max(now.getTime() + days * DAY, quota.active && quota.paidUntil ? quota.paidUntil.getTime() : 0));
      const grant = await ctx.deps.billing.licenses.grant(license.id, { budget: usd, starts: now, ends });
      if (infinity) await ctx.deps.billing.licenses.update(license.id, { plan: "infinity" });
      await record(ctx.admin, {
        actor: ctx.me!.username,
        action: "license.grant",
        target: license.id,
        changes: [
          ...(infinity ? [{ field: "plan", old: license.plan ?? "", new: "infinity" }] : []),
          { field: "budget", old: "", new: `+$${usd} until ${day(ends)}` },
        ],
        ip: ctx.ip,
      });
      return Response.json({ grant: { ...grant, starts: iso(grant.starts), ends: iso(grant.ends) } });
    }),
  },
  {
    method: "POST",
    path: "/licenses/:id/extend",
    access: "admin",
    handle: hosted(async (ctx) => {
      const license = await licenseOr404(ctx);
      if (!license) return error(404, "NOT_FOUND", "No such license");
      if (license.revoked_at) return revoked();
      const input = extendSchema.safeParse(await body(ctx.req));
      if (!input.success) return error(400, "BAD_REQUEST", "Give days (1–366)");
      const now = ctx.deps.billing.now();
      const grants = await ctx.deps.billing.licenses.grants(license.id);
      const last = grants.filter((g) => g.ends > now).sort((a, b) => b.ends.getTime() - a.ends.getTime())[0];
      if (!last) return error(409, "NOT_ACTIVE", "Nothing is paid now; grant a budget instead");
      const ends = new Date(last.ends.getTime() + input.data.days * DAY);
      await ctx.deps.billing.licenses.moveEnd(last.id, ends);
      await record(ctx.admin, {
        actor: ctx.me!.username,
        action: "license.extend",
        target: license.id,
        changes: [{ field: "paid_until", old: last.ends.toISOString(), new: ends.toISOString() }],
        ip: ctx.ip,
      });
      return Response.json({ paid_until: ends.toISOString() });
    }),
  },
  ...(["block", "unblock"] as const).map(
    (action): Route => ({
      method: "POST",
      path: `/licenses/:id/${action}`,
      access: "admin",
      handle: hosted(async (ctx) => {
        const license = await licenseOr404(ctx);
        if (!license) return error(404, "NOT_FOUND", "No such license");
        if (license.revoked_at) return revoked();
        const at = action === "block" ? ctx.deps.billing.now() : undefined;
        await ctx.deps.billing.licenses.update(license.id, { blocked_at: at });
        await record(ctx.admin, {
          actor: ctx.me!.username,
          action: `license.${action}`,
          target: license.id,
          changes: [{ field: "blocked", old: license.blocked_at ? "yes" : "no", new: at ? "yes" : "no" }],
          ip: ctx.ip,
        });
        const known = (await ctx.deps.servers?.list(`license:${license.id}`)) ?? [];
        return Response.json({ license: await licenseView(ctx.deps.billing, (await ctx.deps.billing.licenses.get(license.id))!, undefined, true, known) });
      }),
    }),
  ),
  {
    // Owners only: the text goes to every license's claimed Telegram chat, or the listed licenses' only, one by one.
    method: "POST",
    path: "/licenses/notify",
    access: "owner",
    handle: hosted(async (ctx) => {
      const input = notifySchema.safeParse(await body(ctx.req));
      if (!input.success) return error(400, "BAD_REQUEST", "Write the text, up to 3000 characters, and optionally the licenses' ids");
      const { billing } = ctx.deps;
      const api = billing.bot.api;
      if (!api) return error(503, "BOT_OFF", "The bot isn't running, so it can't write to anyone");
      const wanted = input.data.licenses ? new Set(input.data.licenses) : null;
      const licenses = [];
      for (let skip = 0; ; skip += 200) {
        const page = (await billing.licenses.list({ limit: 200, skip })).licenses;
        licenses.push(...page.filter((l) => !wanted || wanted.has(l.id)));
        if (page.length < 200) break;
      }
      let sent = 0;
      let failed = 0;
      let unclaimed = 0;
      for (const license of licenses) {
        const chat = license.telegram_chat_id ?? license.telegram_user_id;
        if (!chat) {
          unclaimed++;
          continue;
        }
        const send = () => api.call("sendMessage", { chat_id: chat, text: input.data.text, disable_web_page_preview: true });
        try {
          await send().catch(async (failure) => {
            // Too many at once: wait as long as Telegram says, then once more.
            if (!/too many requests|429/i.test(String(failure))) throw failure;
            await pause(retryAfter(failure));
            await send();
          });
          sent++;
        } catch {
          failed++;
        }
        await pause(NOTIFY_GAP_MS);
      }
      // The count, never the text: it may describe a breach in more detail than the log should keep.
      await record(ctx.admin, {
        actor: ctx.me!.username,
        action: "licenses.notify",
        target: wanted ? `${wanted.size} licenses` : "every license",
        changes: [
          { field: "sent", old: "", new: String(sent) },
          { field: "failed", old: "", new: String(failed) },
          { field: "unclaimed", old: "", new: String(unclaimed) },
        ],
        ip: ctx.ip,
      });
      return Response.json({ sent, failed, unclaimed });
    }),
  },
  {
    method: "POST",
    path: "/licenses/:id/refund",
    access: "admin",
    handle: hosted(async (ctx) => {
      const license = await licenseOr404(ctx);
      if (!license) return error(404, "NOT_FOUND", "No such license");
      if (license.revoked_at) return revoked();
      const { billing } = ctx.deps;
      if (!(await billing.licenses.payments({ license: license.id, limit: 1 })).length) return error(409, "NOT_PAID", "Nobody paid for this license, so there's nothing to refund");
      const api = billing.bot.api;
      if (!api) return error(503, "BOT_OFF", "The payment bot isn't running, so Telegram can't return the Stars");
      const done = await refundLicense(billing, api, license).catch((failure) => failure as Error);
      if (done instanceof LicenseRefundFailure) {
        return error(502, "TELEGRAM_FAILED", `Refunded ${done.refunded} payments, ${done.left} left; the license stays until all are back. Telegram: ${done.message}`);
      }
      if (done instanceof Error) throw done;
      await record(ctx.admin, {
        actor: ctx.me!.username,
        action: "license.refund",
        target: license.id,
        changes: [
          { field: "stars", old: String(done.stars), new: "refunded" },
          { field: "revoked", old: "no", new: "yes" },
        ],
        ip: ctx.ip,
      });
      return Response.json({ revoked: true, stars: done.stars, payments: done.payments });
    }),
  },
  {
    method: "DELETE",
    path: "/licenses/:id",
    access: "admin",
    handle: hosted(async (ctx) => {
      const license = await licenseOr404(ctx);
      if (!license) return error(404, "NOT_FOUND", "No such license");
      const input = deleteSchema.safeParse((await body(ctx.req)) ?? {});
      if (!input.success) return error(400, "BAD_REQUEST", "force is true or false");
      const { billing } = ctx.deps;
      const unrefunded = (await billing.licenses.payments({ license: license.id, limit: 1_000 })).filter((p) => !p.refunded_at);
      const stars = unrefunded.reduce((sum, p) => sum + p.stars, 0);
      // Someone paid and hasn't got the Stars back: refund first, or an owner deletes it anyway and owns the consequences.
      if (unrefunded.length && !input.data.force) {
        return error(409, "PAID", "Someone paid for this license; refund it first, or delete it anyway", { stars, payments: unrefunded.length });
      }
      if (unrefunded.length && !allows(ctx.me!.role, "owner")) return error(403, "FORBIDDEN", "Only an owner can delete a paid license without a refund");
      await billing.licenses.remove(license.id);
      await record(ctx.admin, {
        actor: ctx.me!.username,
        action: "license.delete",
        target: license.id,
        changes: [
          { field: "name", old: serverName(license), new: "" },
          ...(unrefunded.length ? [{ field: "unrefunded", old: `${stars} Stars in ${unrefunded.length} payments`, new: "kept by us" }] : []),
        ],
        ip: ctx.ip,
      });
      return Response.json({ deleted: true, forced: unrefunded.length > 0 });
    }),
  },
  {
    method: "GET",
    path: "/payments",
    access: "viewer",
    handle: hosted(async (ctx) => {
      const { deps, url } = ctx;
      const before = url.searchParams.get("before");
      const payments = await deps.billing.licenses.payments({
        license: url.searchParams.get("license") ?? undefined,
        before: before ? new Date(before) : undefined,
        limit: Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100)),
      });
      return Response.json({ payments: payments.map((p) => paymentView(p, seesPayers(ctx))) });
    }),
  },
  {
    method: "POST",
    path: "/payments/:id/refund",
    access: "admin",
    handle: hosted(async (ctx) => {
      const api = ctx.deps.billing.bot.api;
      if (!api) return error(503, "BOT_OFF", "The payment bot isn't running, so Telegram can't return the Stars");
      const done = await refundPayment(ctx.deps.billing, api, ctx.params.id).catch((failure) => failure as Error);
      if (done instanceof Error) return error(502, "TELEGRAM_FAILED", done.message);
      if (!done) return error(404, "NOT_FOUND", "No such payment, or it's refunded already");
      await record(ctx.admin, {
        actor: ctx.me!.username,
        action: "payment.refund",
        target: ctx.params.id,
        changes: [{ field: "stars", old: String(done.payment.stars), new: "refunded" }],
        ip: ctx.ip,
      });
      return Response.json({ refunded: true, stars: done.payment.stars });
    }),
  },
];
