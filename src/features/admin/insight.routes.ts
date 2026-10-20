import { RUN_KINDS, type RunKind, type RunRecord } from "../../infrastructure/runs/runs";
import { z } from "zod";
import { PSEUDONYM } from "../../infrastructure/privacy/pseudonyms";
import { USER_ID } from "../../shared/types/owner";
import { TENANT } from "../auth/caller";
import { erasePlayer } from "../users/privacy";
import { record } from "./admin";
import { type Route, body, error } from "./admin.http";
import { RANGES, type Range, statsFor } from "./stats";

const eraseSchema = z.object({ server: z.string().regex(TENANT), user_id: z.string().regex(USER_ID) });

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
      return Response.json({
        total,
        page,
        limit,
        players: players.map((p) => ({ ...p, first_seen: p.first_seen.toISOString(), last_seen: p.last_seen.toISOString() })),
      });
    },
  },
  {
    method: "GET",
    path: "/players/:id",
    access: "viewer",
    async handle({ deps, params }) {
      if (!PSEUDONYM.test(params.id)) return error(404, "NOT_FOUND", "No such player");
      const [summary, runs] = await Promise.all([
        deps.runs?.players({ search: params.id, limit: 1, skip: 0 }),
        deps.runs?.list({ user_id: params.id, limit: 50 }) ?? [],
      ]);
      const player = summary?.players.find((p) => p.user_id === params.id);
      if (!player) return error(404, "NOT_FOUND", "No such player");
      // Numbers only: the panel knows players by pseudonym, and never what they asked or what Allay remembers.
      return Response.json({
        user_id: params.id,
        language: player.language ?? null,
        questions: player.questions,
        cost: player.cost,
        first_seen: player.first_seen.toISOString(),
        last_seen: player.last_seen.toISOString(),
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
