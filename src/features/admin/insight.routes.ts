import { RUN_KINDS, type RunKind, type RunRecord } from "../../infrastructure/runs/runs";
import { z } from "zod";
import { PSEUDONYM } from "../../infrastructure/privacy/pseudonyms";
import { NAME_SEARCH } from "../../infrastructure/privacy/players";
import type { AllayDeps } from "../../agent/allay";
import { USER_ID } from "../../shared/types/owner";
import { TENANT } from "../auth/caller";
import { type Erased, erasePlayer, erasePseudonym, findPlayer } from "../users/privacy";
import { licenseName } from "../billing/billing";
import { allows, record } from "./admin";
import { type Route, type Context, body, error } from "./admin.http";
import { RANGES, type Range, statsFor } from "./stats";
import type { ServerSummary } from "../../infrastructure/runs/runs";
import type { KnownServer } from "../../infrastructure/servers/servers";
import { inRanges, rangesOf } from "../../shared/lib/address";
import { headKey, headOf } from "./heads";
import { PROFILE_RUNS, profileOf } from "./profile";

// A pseudonym from the list, a player's name, or the id a player sent with their request.
const eraseSchema = z.object({ server: z.string().regex(TENANT), user_id: z.string().max(64).refine((id) => PSEUDONYM.test(id) || USER_ID.test(id) || NAME_SEARCH.test(id)) });
const serverSchema = z.object({ server: z.string().regex(TENANT) });
// Why an owner opens a run: kept in the audit log with the look.
const revealSchema = z.object({ reason: z.string().trim().min(10).max(500) });

/** A player of the panel's page and one tenant they asked on, from the path and the body; a response when there's none. */
const playerOn = async ({ deps, params, req }: Context) => {
  const input = serverSchema.safeParse(await body(req));
  if (!PSEUDONYM.test(params.id) || !input.success) return error(400, "BAD_REQUEST", "Name the server (self or license:<id>)");
  // An erased player's runs no longer name them, but their ban still does, so it can be lifted.
  const tenants = [...((await deps.runs?.tenantsOf(params.id)) ?? []), ...((await deps.bans.of([params.id])).get(params.id) ?? []).map((b) => b.tenant)];
  if (!tenants.includes(input.data.server)) return error(404, "NOT_FOUND", "This player never asked on that server");
  return { tenant: input.data.server, pseudonym: params.id };
};

/** The audit log keeps the pseudonym, not the name or the id: it outlives the erasure by a year. */
const erasedReply = async ({ admin, me, ip }: Context, tenant: string, pseudonym: string, erased: Erased) => {
  await record(admin, {
    actor: me!.username,
    action: "player.erase",
    target: `${tenant} ${pseudonym}`,
    changes: [
      { field: "memories", old: String(erased.memories), new: "0" },
      { field: "deaths", old: String(erased.deaths), new: "0" },
      { field: "runs", old: String(erased.runs), new: "erased" },
    ],
    ip,
  });
  return Response.json({ erased: true, ...erased });
};

const ownerOn = async (ctx: Context) => {
  const player = await playerOn(ctx);
  if (player instanceof Response) return player;
  const userId = await findPlayer(ctx.deps, player.tenant, player.pseudonym);
  if (!userId) return error(404, "UNKNOWN_PLAYER", "Nothing kept on that server tells who this player is; they have nothing but runs to erase");
  return { ...player, owner: { tenant: player.tenant, userId } };
};

/** A pseudonym's start searches pseudonyms; anything else finds players by the start of their name, or by their id. */
const searchOf = async (deps: AllayDeps, text: string | undefined, me: Me): Promise<{ search?: string; ids?: string[] }> => {
  if (!text) return {};
  if (PSEUDONYM.test(text) || /^p_[0-9a-f]{0,20}$/.test(text)) return { search: text };
  // A viewer may not find a player by name or id: that would tell them who a pseudonym is.
  if (!named(me)) return { ids: [] };
  const ids = new Set(NAME_SEARCH.test(text) ? ((await deps.players?.search(text, { limit: 500 })) ?? []).map((p) => p.pseudonym) : []);
  // An id has a pseudonym of its own on every server it asked on.
  if (USER_ID.test(text)) for (const tenant of (await deps.runs?.tenants()) ?? []) ids.add(deps.pseudonyms.of(tenant, text));
  return { ids: [...ids] };
};

type Who = { name: string; uuid: string } | null;

type Me = Context["me"];

/** Names and faces are for admins and owners; a viewer sees pseudonyms and numbers only. */
const named = (me: Me) => !!me && allows(me.role, "admin");

/** Who each pseudonym is, by the newest name the directory has for it; nobody for a viewer. */
const whoOf = async (deps: AllayDeps, pseudonyms: string[], me: Me): Promise<(id: string) => Who> => {
  if (!named(me)) return () => null;
  const known = (await deps.players?.of(pseudonyms.filter((p) => PSEUDONYM.test(p)))) ?? new Map();
  return (id) => {
    const player = known.get(id)?.[0];
    return player ? { name: player.name, uuid: player.user_id } : null;
  };
};

/** Private, loopback, and link-local ranges: a server there shares a network with the backend, like Moonlands with allay.chat. */
const INTERNAL = rangesOf("10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16, ::1/128, fc00::/7, fe80::/10");

/** The licenses' names by tenant, for the servers and runs that name a license: their servers' own names, not MOTDs. */
const licenseNames = async (deps: AllayDeps, tenants: string[], known?: KnownServer[]) => {
  const names = new Map<string, string>();
  const licensed = [...new Set(tenants.filter((t) => t.startsWith("license:")))];
  if (!deps.billing.enabled || !licensed.length) return names;
  const servers = known ?? (await deps.servers?.list()) ?? [];
  for (const tenant of licensed) {
    const license = await deps.billing.licenses.get(tenant.slice("license:".length)).catch(() => null);
    if (license) names.set(tenant, licenseName(license, servers));
  }
  return names;
};

/**
 * Servers from the runs with what the directory knows: the name its owner gave it, the address players join with,
 * the game and plugin versions, and the license behind it. The address a server connects from may be someone's home,
 * so only admins see it. With [player], the counts are that player's on each server, and only their servers show.
 */
export const serversView = async (ctx: Context, asked: ServerSummary[], tenant?: string, player?: string) => {
  const { deps } = ctx;
  const known = (await deps.servers?.list(tenant)) ?? [];
  // A server that registered but hasn't asked yet shows too, with nothing counted; not on a player's page.
  const quiet = player
    ? []
    : known
        .filter((k) => !asked.some((s) => s.server === k.tenant && (s.server_id ?? "") === k.server_id))
        .map(
          (k): ServerSummary => ({
            server: k.tenant,
            ...(k.server_id ? { server_id: k.server_id } : {}),
            payer: k.tenant === "self" ? "self" : "license",
            questions: 0,
            players: 0,
            cost: 0,
            first_seen: k.first_seen,
            last_seen: k.last_seen,
          }),
        );
  const servers = [...asked, ...quiet];
  const admins = !!ctx.me && allows(ctx.me.role, "admin");
  const licenses = await licenseNames(deps, servers.map((s) => s.server), tenant ? undefined : known);
  return servers.map((s) => {
    const entry = known.find((k) => k.tenant === s.server && k.server_id === (s.server_id ?? ""));
    return {
      ...s,
      server_id: s.server_id ?? null,
      first_asked: s.questions ? s.first_seen.toISOString() : null,
      last_seen: s.last_seen.toISOString(),
      name: entry?.name ?? null,
      motd: entry?.motd ?? null,
      address: entry?.address ?? null,
      port: entry?.port ?? null,
      software: entry?.software ?? null,
      version: entry?.version ?? null,
      plugin_version: entry?.plugin_version ?? null,
      loader: entry?.loader ?? null,
      side: entry?.side ?? null,
      ip: admins ? (entry?.ip ?? null) : null,
      internal: entry ? inRanges(entry.ip, INTERNAL) : null,
      // When the server first registered or asked, as the directory knows it.
      first_seen: entry?.first_seen.toISOString() ?? null,
      license: s.server.startsWith("license:") ? { id: s.server.slice("license:".length), name: licenses.get(s.server) ?? null } : null,
    };
  });
};

/** The name each server of these runs has in the directory, by tenant and server id. */
const serverNamesOf = async (deps: AllayDeps, runs: RunRecord[]) => {
  const known = runs.length ? ((await deps.servers?.list()) ?? []) : [];
  return (run: RunRecord) => known.find((k) => k.tenant === run.server && k.server_id === (run.server_id ?? ""))?.name ?? null;
};

const runView = (run: RunRecord, who: (id: string) => Who = () => null, server: (run: RunRecord) => string | null = () => null) => ({
  ...run,
  at: run.at.toISOString(),
  player: who(run.user_id),
  server_name: server(run),
});

const runsView = async (deps: AllayDeps, runs: RunRecord[], me: Me) => {
  const [who, server] = await Promise.all([whoOf(deps, runs.map((r) => r.user_id), me), serverNamesOf(deps, runs)]);
  return runs.map((run) => runView(run, who, server));
};

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
    async handle({ deps, admin, url, me }) {
      if (!deps.runs) return error(503, "NO_RUNS", "This backend keeps no statistics");
      const range = (url.searchParams.get("range") ?? "7d") as Range;
      if (!RANGES.includes(range)) return error(400, "BAD_REQUEST", `range is one of ${RANGES.join(", ")}`);
      const now = admin.now();
      const stats = await statsFor(deps.runs, range, now);
      // The busiest players of the range, by name where the directory knows them.
      const from = range === "24h" ? new Date(now.getTime() - 86_400_000) : new Date(stats.series[0]?.t ?? now);
      const { players } = await deps.runs.players({ from, sort: "questions", limit: 8, skip: 0 });
      const who = await whoOf(deps, players.map((p) => p.user_id), me);
      return Response.json({ ...stats, top_players: players.map((p) => ({ user_id: p.user_id, player: who(p.user_id), questions: p.questions, cost: p.cost })) });
    },
  },
  {
    method: "GET",
    path: "/players",
    access: "viewer",
    async handle({ deps, url, me }) {
      if (!deps.runs) return error(503, "NO_RUNS", "This backend keeps no statistics");
      const limit = limitOf(url);
      const page = Math.max(0, Number(url.searchParams.get("page")) || 0);
      const given = url.searchParams.get("search")?.trim().slice(0, 64) || undefined;
      const search = await searchOf(deps, given, me);
      if (search.ids?.length === 0) return Response.json({ total: 0, page, limit, players: [] });
      const { players, total } = await deps.runs.players({ ...search, limit, skip: page * limit });
      const [bans, who] = await Promise.all([deps.bans.of(players.map((p) => p.user_id)), whoOf(deps, players.map((p) => p.user_id), me)]);
      return Response.json({
        total,
        page,
        limit,
        players: players.map((p) => ({
          ...p,
          player: who(p.user_id),
          blocked: bans.has(p.user_id),
          first_seen: p.first_seen.toISOString(),
          last_seen: p.last_seen.toISOString(),
        })),
      });
    },
  },
  {
    method: "GET",
    path: "/players/blocked",
    access: "viewer",
    async handle({ deps, me }) {
      const bans = await deps.bans.list(200);
      const who = await whoOf(deps, bans.map((b) => b.pseudonym), me);
      return Response.json({ bans: bans.map(({ pseudonym, tenant, blocked_at }) => ({ user_id: pseudonym, player: who(pseudonym), server: tenant, blocked_at })) });
    },
  },
  {
    method: "GET",
    path: "/players/lookup",
    access: "admin",
    async handle({ deps, url }) {
      // The erase form's picker: players of one server by the start of their name, or the newest ones.
      const server = url.searchParams.get("server") ?? undefined;
      const text = url.searchParams.get("q")?.trim().slice(0, 32) ?? "";
      if ((server && !TENANT.test(server)) || (text && !NAME_SEARCH.test(text) && !USER_ID.test(text) && !PSEUDONYM.test(text))) return Response.json({ players: [] });
      const found = (await deps.players?.search(text, { tenant: server, limit: 10 })) ?? [];
      const known = found.length ? ((await deps.servers?.list()) ?? []) : [];
      const names = await licenseNames(deps, found.map((p) => p.tenant), known);
      // The names of the servers each player asked on, as their owners named them; the license's name for the rest.
      const servers = await Promise.all(
        found.map(async (p) => {
          const asked = (await deps.runs?.servers({ server: p.tenant, user_id: p.pseudonym, limit: 20 })) ?? [];
          const named = asked.map((s) => known.find((k) => k.tenant === p.tenant && k.server_id === (s.server_id ?? ""))?.name).filter((n): n is string => !!n);
          return [...new Set(named)];
        }),
      );
      return Response.json({
        players: found.map((p, i) => ({
          user_id: p.pseudonym,
          name: p.name,
          uuid: p.user_id,
          server: p.tenant,
          server_name: names.get(p.tenant) ?? null,
          servers: servers[i],
          last_seen: p.last_seen.toISOString(),
        })),
      });
    },
  },
  {
    method: "GET",
    path: "/players/:id",
    access: "viewer",
    async handle(ctx) {
      const { deps, admin, params } = ctx;
      if (!PSEUDONYM.test(params.id)) return error(404, "NOT_FOUND", "No such player");
      const [summary, runs, tenants, bans, known] = await Promise.all([
        deps.runs?.players({ search: params.id, limit: 1, skip: 0 }),
        deps.runs?.list({ user_id: params.id, limit: PROFILE_RUNS }) ?? [],
        deps.runs?.tenantsOf(params.id) ?? [],
        deps.bans.of([params.id]),
        deps.players?.of([params.id]),
      ]);
      const banned = bans.get(params.id) ?? [];
      // A viewer gets the pseudonym's numbers, never the name, UUID, or operator status behind it.
      const entries = named(ctx.me) ? (known?.get(params.id) ?? []) : [];
      // A player erased while blocked has no runs left, only the ban.
      const player = summary?.players.find((p) => p.user_id === params.id) ?? (banned.length ? { questions: 0, cost: 0, language: undefined, first_seen: null, last_seen: null } : null);
      if (!player) return error(404, "NOT_FOUND", "No such player");
      // Per server: the name there, whether they're blocked there, and whether the backend can tell who they are, to reset or erase them.
      const servers = await Promise.all(
        [...new Set([...tenants, ...banned.map((b) => b.tenant)])].map(async (tenant) => {
          const entry = entries.find((e) => e.tenant === tenant);
          return {
            server: tenant,
            name: entry?.name ?? null,
            op: entry?.op ?? null,
            first_seen: entry?.first_seen.toISOString() ?? null,
            blocked_at: banned.find((b) => b.tenant === tenant)?.blocked_at ?? null,
            known: (await findPlayer(deps, tenant, params.id)) !== null,
          };
        }),
      );
      const newest = entries[0];
      const who = () => (newest ? { name: newest.name, uuid: newest.user_id } : null);
      // Every server they asked on, with their own numbers there.
      const seenOn = await serversView(ctx, (await deps.runs?.servers({ user_id: params.id, limit: 100 })) ?? [], undefined, params.id);
      const serverOf = await serverNamesOf(deps, runs);
      // Numbers and names only: never what the player asked or what Allay remembers.
      return Response.json({
        user_id: params.id,
        player: who(),
        op: newest?.op ?? null,
        language: player.language ?? null,
        questions: player.questions,
        cost: player.cost,
        first_seen: player.first_seen?.toISOString() ?? null,
        last_seen: player.last_seen?.toISOString() ?? null,
        servers,
        seen_on: seenOn,
        profile: profileOf(runs, admin.now()),
        runs: runs.slice(0, 50).map((run) => runView(run, who, serverOf)),
      });
    },
  },
  {
    method: "GET",
    path: "/players/:id/head",
    access: "admin",
    async handle({ deps, params }) {
      const player = PSEUDONYM.test(params.id) ? (await deps.players?.of([params.id]))?.get(params.id)?.[0] : undefined;
      const head = player ? await headOf(headKey(player.user_id, player.name)) : null;
      if (!head) return error(404, "NOT_FOUND", "No face for this player");
      return new Response(head.body, { headers: { "Content-Type": head.type, "Cache-Control": "private, max-age=21600" } });
    },
  },
  {
    method: "POST",
    path: "/players/erase",
    access: "admin",
    async handle(ctx) {
      const { deps } = ctx;
      const input = eraseSchema.safeParse(await body(ctx.req));
      if (!input.success) return error(400, "BAD_REQUEST", "Name the server (self or license:<id>) and the player's pseudonym or id");
      const { server: tenant, user_id: given } = input.data;
      if (PSEUDONYM.test(given)) return erasedReply(ctx, tenant, given, await erasePseudonym(deps, tenant, given));
      // A name the directory knows on that server, matched whole; the picker sends pseudonyms, typing may send a name.
      const named = NAME_SEARCH.test(given) ? ((await deps.players?.search(given, { tenant, limit: 50 })) ?? []).filter((p) => p.name.toLowerCase() === given.toLowerCase()) : [];
      if (named.length > 1) return error(409, "AMBIGUOUS", "Several players had that name on that server; pick one from the list");
      if (named.length === 1) return erasedReply(ctx, tenant, named[0].pseudonym, await erasePseudonym(deps, tenant, named[0].pseudonym));
      if (!USER_ID.test(given)) return error(404, "NOT_FOUND", "No player had that name on that server");
      return erasedReply(ctx, tenant, deps.pseudonyms.of(tenant, given), await erasePlayer(deps, { tenant, userId: given }));
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
      const player = await playerOn(ctx);
      if (player instanceof Response) return player;
      return erasedReply(ctx, player.tenant, player.pseudonym, await erasePseudonym(ctx.deps, player.tenant, player.pseudonym));
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
    async handle(ctx) {
      const { deps, url } = ctx;
      if (!deps.runs) return error(503, "NO_RUNS", "This backend keeps no statistics");
      const tenant = url.searchParams.get("server") ?? undefined;
      const servers = await deps.runs.servers({ server: tenant, limit: limitOf(url, 500) });
      return Response.json({ servers: await serversView(ctx, servers, tenant) });
    },
  },
  {
    // One server: what it is, the license behind it, its players, and its newest runs. `-` stands for no server id.
    method: "GET",
    path: "/servers/:tenant/:id",
    access: "viewer",
    async handle(ctx) {
      const { deps, params, me } = ctx;
      if (!TENANT.test(params.tenant)) return error(404, "NOT_FOUND", "No such server");
      const serverId = params.id === "-" ? undefined : params.id;
      const asked = (await deps.runs?.servers({ server: params.tenant, server_id: serverId, limit: 50 })) ?? [];
      const all = await serversView(ctx, asked, params.tenant);
      const server = all.find((s) => (s.server_id ?? "-") === params.id);
      if (!server) return error(404, "NOT_FOUND", "No such server");
      const [found, runs] = await Promise.all([
        deps.runs?.players({ server: params.tenant, server_id: serverId, limit: 200, skip: 0 }),
        deps.runs?.list({ server: params.tenant, server_id: serverId, limit: 50 }) ?? [],
      ]);
      // Runs without a server id belong to every server of the tenant otherwise; only the empty one may show them.
      const own = serverId ? runs : runs.filter((r) => !r.server_id);
      const who = await whoOf(deps, (found?.players ?? []).map((p) => p.user_id), me);
      return Response.json({
        server,
        players: (found?.players ?? [])
          .map((p) => ({ user_id: p.user_id, player: who(p.user_id), questions: p.questions, cost: p.cost, first_seen: p.first_seen.toISOString(), last_seen: p.last_seen.toISOString() })),
        runs: await runsView(deps, own, me),
      });
    },
  },
  {
    method: "GET",
    path: "/runs",
    access: "viewer",
    async handle({ deps, url, me }) {
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
      return Response.json({ runs: await runsView(deps, runs, me) });
    },
  },
  {
    method: "GET",
    path: "/runs/:id",
    access: "viewer",
    async handle({ deps, admin, params, me }) {
      const run = await deps.runs?.get(params.id);
      if (!run) return error(404, "NOT_FOUND", "No such run");
      const trace = await admin.traces?.get(run.id).catch(() => null);
      const [view] = await runsView(deps, [run], me);
      // The license's name, so the page says whose server it was: its server's own name, not the MOTD.
      const names = await licenseNames(deps, [run.server]);
      return Response.json({ run: view, trace_id: trace?.trace.trace_id ?? null, server_name: names.get(run.server) ?? null, span_count: trace?.spans.length ?? null });
    },
  },
  {
    // Owners only, one run at a time, with a reason, and every look is in the audit log: for a problem a player or a
    // server reported. Never the environment's account: scripts sign in with it, and scripts don't read players' words.
    method: "POST",
    path: "/runs/:id/reveal",
    access: "owner",
    async handle({ deps, admin, params, me, ip, req }) {
      if (me!.env) return error(403, "NOT_FOR_SCRIPTS", "The environment's account can't open runs; sign in with your own");
      const input = revealSchema.safeParse(await body(req));
      if (!input.success) return error(400, "REASON_REQUIRED", "Say why you open this run, in 10–500 characters");
      const run = await deps.runs?.get(params.id);
      if (!run) return error(404, "NOT_FOUND", "No such run");
      const spans = await admin.traces?.reveal(run.id).catch(() => null);
      if (!spans) return error(404, "NO_TRACE", `This run has no trace: traces live ${admin.settings.get("TRACE_DAYS")} days`);
      await record(admin, { actor: me!.username, action: "run.reveal", target: `${run.server} ${run.user_id} ${run.id}`, changes: [{ field: "reason", old: "", new: input.data.reason }], ip });
      return Response.json({ run_id: run.id, spans }, { headers: { "Cache-Control": "no-store" } });
    },
  },
  {
    method: "GET",
    path: "/traces",
    access: "viewer",
    async handle({ deps, admin, url, me }) {
      if (!admin.traces) return Response.json({ traces: [] });
      const traces = await admin.traces.list({ before: beforeOf(url), limit: limitOf(url) });
      // Each trace with its run's numbers, so the table says who, where, which model, and what it cost.
      const runs = await runsView(deps, (await deps.runs?.many(traces.flatMap((t) => (t.run_id ? [t.run_id] : [])))) ?? [], me);
      return Response.json({ traces: traces.map((t) => ({ ...t, run: runs.find((r) => r.id === t.run_id) ?? null })) });
    },
  },
  {
    method: "GET",
    path: "/traces/:id",
    access: "viewer",
    async handle({ deps, admin, params, me }) {
      const found = await admin.traces?.get(params.id);
      if (!found) return error(404, "NOT_FOUND", "No such trace; traces live a few days and only for sampled runs");
      const run = found.trace.run_id ? await deps.runs?.get(found.trace.run_id) : null;
      return Response.json({ ...found, run: run ? (await runsView(deps, [run], me))[0] : null });
    },
  },
];
