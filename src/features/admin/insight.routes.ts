import { estimateTokens } from "../../infrastructure/history/history";
import { RUN_KINDS, type RunKind, type RunRecord } from "../../infrastructure/runs/runs";
import { record } from "./admin";
import { type Route, error } from "./admin.http";
import { RANGES, type Range, statsFor } from "./stats";

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

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
      const search = url.searchParams.get("search")?.trim().slice(0, 64) || undefined;
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
      if (!USER_ID.test(params.id)) return error(404, "NOT_FOUND", "No such player");
      const [summary, memories, session, runs] = await Promise.all([
        deps.runs?.players({ search: params.id, limit: 1, skip: 0 }),
        deps.memories.list(params.id).catch(() => null),
        deps.history.load(params.id),
        deps.runs?.list({ user_id: params.id, limit: 50 }) ?? [],
      ]);
      const player = summary?.players.find((p) => p.user_id === params.id);
      return Response.json({
        user_id: params.id,
        player: player?.player ?? null,
        language: player?.language ?? null,
        questions: player?.questions ?? 0,
        cost: player?.cost ?? 0,
        first_seen: player?.first_seen.toISOString() ?? null,
        last_seen: player?.last_seen.toISOString() ?? null,
        // How many, never what: memories and the session stay the player's.
        memories: memories?.length ?? null,
        session: { messages: session.messages.length, tokens: estimateTokens(session.messages), summary: !!session.summary },
        runs: runs.map(runView),
      });
    },
  },
  {
    method: "DELETE",
    path: "/players/:id/memories",
    access: "admin",
    async handle({ deps, admin, me, params, ip }) {
      if (!USER_ID.test(params.id)) return error(404, "NOT_FOUND", "No such player");
      const deleted = await deps.memories.clear(params.id);
      await record(admin, { actor: me!.username, action: "player.memories.delete", target: params.id, changes: [{ field: "memories", old: String(deleted), new: "0" }], ip });
      return Response.json({ deleted });
    },
  },
  {
    method: "DELETE",
    path: "/players/:id/session",
    access: "admin",
    async handle({ deps, admin, me, params, ip }) {
      if (!USER_ID.test(params.id)) return error(404, "NOT_FOUND", "No such player");
      await deps.history.clear(params.id);
      await record(admin, { actor: me!.username, action: "player.session.reset", target: params.id, ip });
      return Response.json({ cleared: true });
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
