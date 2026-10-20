import { RUN_KINDS, type RunKind, type RunRecord } from "../../infrastructure/runs/runs";
import { z } from "zod";
import { PSEUDONYM } from "../../infrastructure/privacy/pseudonyms";
import { USER_ID } from "../../shared/types/owner";
import { TENANT } from "../auth/caller";
import { erasePlayer, findPlayer } from "../users/privacy";
import { record } from "./admin";
import { type Route, type Context, body, error } from "./admin.http";
import { RANGES, type Range, statsFor } from "./stats";

const eraseSchema = z.object({ server: z.string().regex(TENANT), user_id: z.string().regex(USER_ID) });
const serverSchema = z.object({ server: z.string().regex(TENANT) });

/** A player of the panel's page and one tenant they asked on, from the path and the body; a response when there's none. */
const playerOn = async ({ deps, params, req }: Context) => {
  const input = serverSchema.safeParse(await body(req));
  if (!PSEUDONYM.test(params.id) || !input.success) return error(400, "BAD_REQUEST", "Name the server (self or license:<id>)");
  // An erased player's runs no longer name them, but their ban still does, so it can be lifted.
  const tenants = [...((await deps.runs?.tenantsOf(params.id)) ?? []), ...((await deps.bans.of([params.id])).get(params.id) ?? []).map((b) => b.tenant)];
  if (!tenants.includes(input.data.server)) return error(404, "NOT_FOUND", "This player never asked on that server");
  return { tenant: input.data.server, pseudonym: params.id };
};

/** The same, with the player's id the backend finds for it; only the backend ever sees that id. */
const ownerOn = async (ctx: Context) => {
  const player = await playerOn(ctx);
  if (player instanceof Response) return player;
  const userId = await findPlayer(ctx.deps, player.tenant, player.pseudonym);
  if (!userId) return error(404, "UNKNOWN_PLAYER", "Nothing kept on that server tells who this player is; erase by their id instead");
  return { ...player, owner: { tenant: player.tenant, userId } };
};

/** A player's id typed into the search finds their pseudonym; anything else searches pseudonyms by prefix. */
const searchOf = (deps: { pseudonyms: { of(id: string): string } }, text?: string) => {
  if (!text) return undefined;
  if (PSEUDONYM.test(text) || /^p_[0-9a-f]{0,20}$/.test(text)) return text;
  return USER_ID.test(text) ? deps.pseudonyms.of(text) : undefined;
};

const runView = (run: RunRecord) => ({ ...run, at: run.at.toISOString() });

const limitOf = (url: URL, max = 100) => Math.min(max, Math.max(1, Number(url.searchParams.get("limit")) || 50));

const beforeOf = (url: URL) => {
  const before = url.searchParams.get("before");
  const date = before ? new Date(before) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
};

/** Statistics, players, runs, and traces: numbers and shapes, never what anyone wrote. */
export const insightRoutes: Route[] = [
  {
    method: "GET",
    path: "/stats",
    access: "viewer",
    async handle({ deps, admin, url }) {
      if (!deps.runs) return error(503, "NO_RUNS", "This backend keeps no statistics");
      const range = (url.searchParams.get("range") ?? "7d") as Range;
      if (!RANGES.includes(range)) return error(400, "BAD_REQUEST", `range is one of ${RANGES.join(", ")}`);
      return Response.json(await statsFor(deps.runs, range, admin.now()));
    },
  },
  {
    method: "GET",
    path: "/players",
    access: "viewer",
    async handle({ deps, url }) {
      if (!deps.runs) return error(503, "NO_RUNS", "This backend keeps no statistics");
      const limit = limitOf(url);
      const page = Math.max(0, Number(url.searchParams.get("page")) || 0);
      const given = url.searchParams.get("search")?.trim().slice(0, 64) || undefined;
      const search = searchOf(deps, given);
      if (given && !search) return Response.json({ total: 0, page, limit, players: [] });
      const { players, total } = await deps.runs.players({ search, limit, skip: page * limit });
      const bans = await deps.bans.of(players.map((p) => p.user_id));
      return Response.json({
        total,
        page,
        limit,
        players: players.map((p) => ({ ...p, blocked: bans.has(p.user_id), first_seen: p.first_seen.toISOString(), last_seen: p.last_seen.toISOString() })),
      });
    },
  },
  {
    method: "GET",
    path: "/players/blocked",
    access: "viewer",
    async handle({ deps }) {
      return Response.json({ bans: (await deps.bans.list(200)).map(({ pseudonym, tenant, blocked_at }) => ({ user_id: pseudonym, server: tenant, blocked_at })) });
    },
  },
  {
    method: "GET",
    path: "/players/:id",
    access: "viewer",
    async handle({ deps, params }) {
      if (!PSEUDONYM.test(params.id)) return error(404, "NOT_FOUND", "No such player");
      const [summary, runs, tenants, bans] = await Promise.all([
        deps.runs?.players({ search: params.id, limit: 1, skip: 0 }),
        deps.runs?.list({ user_id: params.id, limit: 50 }) ?? [],
        deps.runs?.tenantsOf(params.id) ?? [],
        deps.bans.of([params.id]),
      ]);
      const banned = bans.get(params.id) ?? [];
      // A player erased while blocked has no runs left, only the ban.
      const player = summary?.players.find((p) => p.user_id === params.id) ?? (banned.length ? { questions: 0, cost: 0, language: undefined, first_seen: null, last_seen: null } : null);
      if (!player) return error(404, "NOT_FOUND", "No such player");
      // Per server: whether they're blocked there, and whether the backend can tell who they are, to reset or erase them.
      const servers = await Promise.all(
        [...new Set([...tenants, ...banned.map((b) => b.tenant)])].map(async (tenant) => ({
          server: tenant,
          blocked_at: banned.find((b) => b.tenant === tenant)?.blocked_at ?? null,
          known: (await findPlayer(deps, tenant, params.id)) !== null,
        })),
      );
      // Numbers only: the panel knows players by pseudonym, and never what they asked or what Allay remembers.
      return Response.json({
        user_id: params.id,
        language: player.language ?? null,
        questions: player.questions,
        cost: player.cost,
        first_seen: player.first_seen?.toISOString() ?? null,
        last_seen: player.last_seen?.toISOString() ?? null,
        servers,
        runs: runs.map(runView),
      });
    },
  },
  {
    method: "POST",
    path: "/players/erase",
    access: "admin",
    async handle(ctx) {
      const { deps, admin, me, ip } = ctx;
      const input = eraseSchema.safeParse(await body(ctx.req));
      if (!input.success) return error(400, "BAD_REQUEST", "Name the server (self or license:<id>) and the player's id");
      const owner = { tenant: input.data.server, userId: input.data.user_id };
      const erased = await erasePlayer(deps, owner);
      // The audit log keeps the pseudonym, not the id: it outlives the erasure by a year.
      await record(admin, {
        actor: me!.username,
        action: "player.erase",
        target: `${owner.tenant} ${deps.pseudonyms.of(owner.userId)}`,
        changes: [
          { field: "memories", old: String(erased.memories), new: "0" },
          { field: "runs", old: String(erased.runs), new: "erased" },
        ],
        ip,
      });
      return Response.json({ erased: true, ...erased });
    },
  },
  {
    method: "POST",
    path: "/players/:id/reset",
    access: "admin",
    async handle(ctx) {
      const found = await ownerOn(ctx);
      if (found instanceof Response) return found;
      // The same as the player's own /allay new: the session goes, memories stay.
      await ctx.deps.history.clear(found.owner);
      await record(ctx.admin, { actor: ctx.me!.username, action: "player.reset", target: `${found.tenant} ${found.pseudonym}`, ip: ctx.ip });
      return Response.json({ cleared: true });
    },
  },
  {
    method: "POST",
    path: "/players/:id/erase",
    access: "admin",
    async handle(ctx) {
      const found = await ownerOn(ctx);
      if (found instanceof Response) return found;
      const erased = await erasePlayer(ctx.deps, found.owner);
      await record(ctx.admin, {
        actor: ctx.me!.username,
        action: "player.erase",
        target: `${found.tenant} ${found.pseudonym}`,
        changes: [
          { field: "memories", old: String(erased.memories), new: "0" },
          { field: "runs", old: String(erased.runs), new: "erased" },
        ],
        ip: ctx.ip,
      });
      return Response.json({ erased: true, ...erased });
    },
  },
  ...(["block", "unblock"] as const).map(
    (action): Route => ({
      method: "POST",
      path: `/players/:id/${action}`,
      access: "admin",
      async handle(ctx) {
        const player = await playerOn(ctx);
        if (player instanceof Response) return player;
        const changed =
          action === "block" ? await ctx.deps.bans.block(player.tenant, player.pseudonym, ctx.me!.username) : await ctx.deps.bans.unblock(player.tenant, player.pseudonym);
        if (changed) {
          await record(ctx.admin, {
            actor: ctx.me!.username,
            action: `player.${action}`,
            target: `${player.tenant} ${player.pseudonym}`,
            changes: [{ field: "blocked", old: action === "block" ? "no" : "yes", new: action === "block" ? "yes" : "no" }],
            ip: ctx.ip,
          });
        }
        return Response.json({ blocked: action === "block" });
      },
    }),
  ),
  {
    method: "GET",
    path: "/servers",
    access: "viewer",
    async handle({ deps, url }) {
      if (!deps.runs) return error(503, "NO_RUNS", "This backend keeps no statistics");
      const servers = await deps.runs.servers({ server: url.searchParams.get("server") ?? undefined, limit: limitOf(url, 500) });
      return Response.json({ servers: servers.map((s) => ({ ...s, last_seen: s.last_seen.toISOString() })) });
    },
  },
  {
    method: "GET",
    path: "/runs",
    access: "viewer",
    async handle({ deps, url }) {
      if (!deps.runs) return error(503, "NO_RUNS", "This backend keeps no statistics");
      const kind = url.searchParams.get("kind") as RunKind | null;
      const result = url.searchParams.get("result") as RunRecord["result"] | null;
      const runs = await deps.runs.list({
        user_id: url.searchParams.get("player") ?? undefined,
        server: url.searchParams.get("server") ?? undefined,
        server_id: url.searchParams.get("server_id") ?? undefined,
        kind: kind && RUN_KINDS.includes(kind) ? kind : undefined,
        result: result && ["ok", "error", "cancelled"].includes(result) ? result : undefined,
        before: beforeOf(url),
        limit: limitOf(url),
      });
      return Response.json({ runs: runs.map(runView) });
    },
  },
  {
    method: "GET",
    path: "/runs/:id",
    access: "viewer",
    async handle({ deps, admin, params }) {
      const run = await deps.runs?.get(params.id);
      if (!run) return error(404, "NOT_FOUND", "No such run");
      const trace = await admin.traces?.get(run.id).catch(() => null);
      return Response.json({ run: runView(run), trace_id: trace?.trace.trace_id ?? null });
    },
  },
  {
    method: "GET",
    path: "/traces",
    access: "viewer",
    async handle({ admin, url }) {
      if (!admin.traces) return Response.json({ traces: [] });
      return Response.json({ traces: await admin.traces.list({ before: beforeOf(url), limit: limitOf(url) }) });
    },
  },
  {
    method: "GET",
    path: "/traces/:id",
    access: "viewer",
    async handle({ deps, admin, params }) {
      const found = await admin.traces?.get(params.id);
      if (!found) return error(404, "NOT_FOUND", "No such trace; traces live a few days and only for sampled runs");
      const run = found.trace.run_id ? await deps.runs?.get(found.trace.run_id) : null;
      return Response.json({ ...found, run: run ? runView(run) : null });
    },
  },
];
