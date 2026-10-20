import { z } from "zod";
import type { GrantRecord, LicenseRecord, PaymentRecord } from "../../infrastructure/billing/licenses";
import { type Billing, quotaFor, serverName } from "../billing/billing";
import { quotaOf } from "../billing/plans";
import { refundPayment } from "../telegram/telegram.bot";
import { allows, record } from "./admin";
import { type Context, type Route, body, error } from "./admin.http";

const DAY = 86_400_000;

/** A self-hosted backend has no billing, so these pages and their API don't exist there. */
const hosted = (handle: (ctx: Context) => Promise<Response>) => async (ctx: Context) =>
  ctx.deps.billing.enabled ? handle(ctx) : error(404, "BILLING_OFF", "Billing is off on this self-hosted backend");

const iso = (date?: Date | null) => (date ? date.toISOString() : null);

const usd = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

/** A license as the owner's panel shows it: in dollars, unlike what operators see. */
/** Telegram ids are personal data: admins and owners see them, viewers don't need them. */
const seesPayers = (ctx: Context) => !!ctx.me && allows(ctx.me.role, "admin");

const licenseView = async (billing: Billing, license: LicenseRecord, grants?: GrantRecord[], payers = true) => {
  const now = billing.now();
  const windows = grants ?? (await billing.licenses.grants(license.id));
  const quota = quotaOf(windows, now);
  const open = windows.filter((g) => g.starts <= now && now < g.ends);
  return {
    id: license.id,
    name: serverName(license),
    created_at: iso(license.created_at),
    plan: license.plan ?? null,
    status: license.blocked_at ? "blocked" : quota.active ? "active" : license.last_payment_at ? "expired" : "unpaid",
    paid_until: iso(quota.paidUntil),
    renews: license.renews && quota.active,
    budget: usd(open.reduce((sum, g) => sum + g.budget, 0)),
    spent: usd(open.reduce((sum, g) => sum + g.spent, 0)),
    used_percent: quota.usedPercent,
    resets_at: iso(quota.resetsAt),
    telegram_user_id: payers ? (license.telegram_user_id ?? null) : null,
    language: license.language ?? null,
    last_payment_at: iso(license.last_payment_at),
    stopped_at: iso(license.stopped_at),
    blocked_at: iso(license.blocked_at),
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

const grantSchema = z.object({ usd: z.number().positive().max(1_000), days: z.number().int().min(1).max(366) });
const extendSchema = z.object({ days: z.number().int().min(1).max(366) });

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
      return Response.json({ total, page, limit, licenses: await Promise.all(licenses.map((l) => licenseView(deps.billing, l, undefined, seesPayers(ctx)))) });
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
        license: await licenseView(billing, license, grants, seesPayers(ctx)),
        grants: grants
          .sort((a, b) => a.starts.getTime() - b.starts.getTime())
          .map((g) => ({ id: g.id, payment: g.payment ?? null, budget: usd(g.budget), spent: usd(g.spent), starts: iso(g.starts), ends: iso(g.ends) })),
        payments: payments.map((p) => paymentView(p, seesPayers(ctx))),
        servers: servers.map((s) => ({ ...s, last_seen: s.last_seen.toISOString() })),
      });
    }),
  },
  {
    method: "POST",
    path: "/licenses/:id/grant",
    access: "admin",
    handle: hosted(async (ctx) => {
      const license = await licenseOr404(ctx);
      if (!license) return error(404, "NOT_FOUND", "No such license");
      const input = grantSchema.safeParse(await body(ctx.req));
      if (!input.success) return error(400, "BAD_REQUEST", "Give usd (up to 1000) and days (1–366)");
      const now = ctx.deps.billing.now();
      // The budget is there at once and lasts the given days, or to the end of what's paid, whichever is later.
      const quota = await quotaFor(ctx.deps.billing, license);
      const ends = new Date(Math.max(now.getTime() + input.data.days * DAY, quota.active && quota.paidUntil ? quota.paidUntil.getTime() : 0));
      const grant = await ctx.deps.billing.licenses.grant(license.id, { budget: input.data.usd, starts: now, ends });
      await record(ctx.admin, {
        actor: ctx.me!.username,
        action: "license.grant",
        target: license.id,
        changes: [{ field: "budget", old: "", new: `+$${input.data.usd} until ${ends.toISOString()}` }],
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
        const at = action === "block" ? ctx.deps.billing.now() : undefined;
        await ctx.deps.billing.licenses.update(license.id, { blocked_at: at });
        await record(ctx.admin, {
          actor: ctx.me!.username,
          action: `license.${action}`,
          target: license.id,
          changes: [{ field: "blocked", old: license.blocked_at ? "yes" : "no", new: at ? "yes" : "no" }],
          ip: ctx.ip,
        });
        return Response.json({ license: await licenseView(ctx.deps.billing, (await ctx.deps.billing.licenses.get(license.id))!) });
      }),
    }),
  ),
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
