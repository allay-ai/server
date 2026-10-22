import { Schema, model } from "mongoose";
import { ERASED } from "../privacy/pseudonyms";

export const RUN_KINDS = ["ask", "askall", "askx", "task", "summary", "telegram"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/**
 * One run as numbers: who, on what, how long, how much, and how it ended. Never the question, the answer,
 * or what tools were given and returned: nobody reads those in the panel, in any role.
 */
export interface RunRecord {
  id: string;
  at: Date;
  kind: RunKind;
  /** Who paid: a license, a server's own key, or this backend's key. */
  payer: "license" | "byok" | "self";
  /** The tenant: `license:<id>` or `self`; runs from before 6.0 may also hold `byok:<fingerprint>`. */
  server: string;
  /** The plugin's random server id, when it sent one. */
  server_id?: string;
  /** The player's pseudonym (`p_…`), never their id or name; `erased` once they asked to be forgotten. */
  user_id: string;
  language?: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost: number;
  steps: number;
  tools: Array<{ name: string; ok: boolean }>;
  searches: number;
  duration_ms: number;
  result: "ok" | "cancelled" | "error";
  error_code?: string;
}

/** A day's runs summed, kept forever so charts over a year read 365 small documents. */
export interface DayRollup {
  day: string;
  runs: number;
  questions: number;
  errors: number;
  cancelled: number;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  searches: number;
  kinds: Record<string, number>;
  models: Record<string, { runs: number; cost: number }>;
  tools: Record<string, { calls: number; failed: number }>;
  /** Counts per DURATION_BUCKETS index, for percentiles. */
  durations: Record<string, number>;
  /** Pseudonyms of the day's players, while the day is younger than RUN_DAYS; [player_count] keeps their number after. */
  players: string[];
  player_count?: number;
  servers: string[];
}

/** Upper bounds in milliseconds; percentiles over days read the bucket a rank falls into. */
export const DURATION_BUCKETS = [500, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 8_000, 10_000, 12_500, 15_000, 20_000, 25_000, 30_000, 40_000, 50_000, 60_000, 90_000, 120_000, 180_000, 300_000, Number.POSITIVE_INFINITY];

export const bucketOf = (ms: number) => DURATION_BUCKETS.findIndex((bound) => ms <= bound);

export const RUN_DAYS = 730;

export interface PlayerSummary {
  user_id: string;
  language?: string;
  questions: number;
  errors: number;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  searches: number;
  /** The mean time of an answer. */
  avg_ms: number;
  /** How many tenants the player asked on. */
  servers: number;
  first_seen: Date;
  last_seen: Date;
}

export interface PlayerQuery {
  /** A pseudonym's start. */
  search?: string;
  /** Exactly these pseudonyms, as a search by name finds them. */
  ids?: string[];
  /** Only questions since then; the summary counts those alone. */
  from?: Date;
  /** Newest first by default; `questions` ranks the busiest first. */
  sort?: "last_seen" | "questions";
  limit: number;
  skip: number;
}

export interface ServerSummary {
  server: string;
  server_id?: string;
  payer: RunRecord["payer"];
  questions: number;
  players: number;
  cost: number;
  last_seen: Date;
}

export interface RunFilter {
  user_id?: string;
  server?: string;
  server_id?: string;
  kind?: RunKind;
  result?: RunRecord["result"];
  before?: Date;
  limit: number;
}

export interface RunStore {
  /** Keeps a run and adds it to its day. */
  add(run: RunRecord): Promise<void>;
  get(id: string): Promise<RunRecord | null>;
  list(filter: RunFilter): Promise<RunRecord[]>;
  /** Runs since a time, for the last day's hourly charts. */
  since(from: Date): Promise<RunRecord[]>;
  days(from: string, to: string): Promise<DayRollup[]>;
  players(options: PlayerQuery): Promise<{ players: PlayerSummary[]; total: number }>;
  servers(options: { server?: string; limit: number }): Promise<ServerSummary[]>;
  /** The numbers of a player's runs on one tenant, newest first, for their copy of what's kept. */
  of(userId: string, server: string, limit: number): Promise<RunRecord[]>;
  /** The tenants a player asked on, by pseudonym. */
  tenantsOf(userId: string): Promise<string[]>;
  /**
   * Erasure on one tenant: the player's runs there keep their numbers under `erased`, and the days forget the
   * pseudonym. Returns the run ids, so their traces can go too.
   */
  forget(userId: string, server: string): Promise<string[]>;
  /** Days older than RUN_DAYS keep how many players they had, not who. */
  prune(now: Date): Promise<number>;
}

const cutoffDay = (now: Date) => dayOf(new Date(now.getTime() - RUN_DAYS * 86_400_000));

const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/** MongoDB field names can't hold dots or dollars; model ids have dots. */
export const fieldKey = (key: string) => key.replace(/[.$%]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const unfieldKey = (key: string) => key.replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

/** What a run adds to its day, as MongoDB's $inc and $addToSet. */
export const rollupUpdate = (run: RunRecord) => {
  const inc: Record<string, number> = {
    runs: 1,
    questions: run.kind === "summary" ? 0 : 1,
    errors: run.result === "error" ? 1 : 0,
    cancelled: run.result === "cancelled" ? 1 : 0,
    cost: run.cost,
    input_tokens: run.input_tokens,
    output_tokens: run.output_tokens,
    searches: run.searches,
    [`kinds.${run.kind}`]: 1,
    [`models.${fieldKey(run.model)}.runs`]: 1,
    [`models.${fieldKey(run.model)}.cost`]: run.cost,
  };
  if (run.kind !== "summary") inc[`durations.${bucketOf(run.duration_ms)}`] = 1;
  for (const tool of run.tools) {
    inc[`tools.${fieldKey(tool.name)}.calls`] = (inc[`tools.${fieldKey(tool.name)}.calls`] ?? 0) + 1;
    inc[`tools.${fieldKey(tool.name)}.failed`] = (inc[`tools.${fieldKey(tool.name)}.failed`] ?? 0) + (tool.ok ? 0 : 1);
  }
  const add = run.kind === "summary" || run.user_id === ERASED ? {} : { players: run.user_id, servers: run.server_id ?? run.server };
  return { day: dayOf(run.at), inc, add };
};

const runSchema = new Schema<RunRecord>(
  {
    id: { type: String, required: true, unique: true },
    at: { type: Date, required: true },
    kind: { type: String, enum: RUN_KINDS, required: true },
    payer: { type: String, required: true },
    server: { type: String, required: true },
    server_id: String,
    user_id: { type: String, required: true },
    language: String,
    model: { type: String, required: true },
    input_tokens: Number,
    output_tokens: Number,
    reasoning_tokens: Number,
    cost: Number,
    steps: Number,
    tools: [{ _id: false, name: String, ok: Boolean }],
    searches: Number,
    duration_ms: Number,
    result: { type: String, required: true },
    error_code: String,
  },
  { versionKey: false },
);

runSchema.index({ at: 1 }, { expireAfterSeconds: RUN_DAYS * 86_400 });
runSchema.index({ user_id: 1, at: -1 });
runSchema.index({ server: 1, at: -1 });
runSchema.index({ server_id: 1, at: -1 }, { sparse: true });

const daySchema = new Schema<DayRollup>(
  {
    day: { type: String, required: true, unique: true },
    runs: Number,
    questions: Number,
    errors: Number,
    cancelled: Number,
    cost: Number,
    input_tokens: Number,
    output_tokens: Number,
    searches: Number,
    kinds: { type: Schema.Types.Mixed, default: {} },
    models: { type: Schema.Types.Mixed, default: {} },
    tools: { type: Schema.Types.Mixed, default: {} },
    durations: { type: Schema.Types.Mixed, default: {} },
    players: [String],
    player_count: Number,
    servers: [String],
  },
  // `errors` is a count here, not Mongoose's validation errors.
  { versionKey: false, minimize: false, suppressReservedKeysWarning: true },
);

export const RunModel = model<RunRecord>("Run", runSchema, "runs");
export const DayModel = model<DayRollup>("RunDay", daySchema, "run_days");

const PROJECTION = { _id: 0 };

const decodeDay = (day: DayRollup): DayRollup => ({
  ...day,
  models: Object.fromEntries(Object.entries(day.models ?? {}).map(([k, v]) => [unfieldKey(k), v])),
  tools: Object.fromEntries(Object.entries(day.tools ?? {}).map(([k, v]) => [unfieldKey(k), v])),
});

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const query = (filter: RunFilter) => ({
  ...(filter.user_id ? { user_id: filter.user_id } : {}),
  ...(filter.server ? { server: filter.server } : {}),
  ...(filter.server_id ? { server_id: filter.server_id } : {}),
  ...(filter.kind ? { kind: filter.kind } : {}),
  ...(filter.result ? { result: filter.result } : {}),
  ...(filter.before ? { at: { $lt: filter.before } } : {}),
});

export const mongoRuns: RunStore = {
  async add(run) {
    await RunModel.create(run);
    const { day, inc, add } = rollupUpdate(run);
    await DayModel.updateOne({ day }, { $inc: inc, ...(Object.keys(add).length ? { $addToSet: add } : {}) }, { upsert: true });
  },
  async get(id) {
    return RunModel.findOne({ id }, PROJECTION).lean<RunRecord>();
  },
  async list(filter) {
    return RunModel.find(query(filter), PROJECTION).sort({ at: -1 }).limit(filter.limit).lean<RunRecord[]>();
  },
  async since(from) {
    return RunModel.find({ at: { $gte: from } }, PROJECTION).lean<RunRecord[]>();
  },
  async days(from, to) {
    return (await DayModel.find({ day: { $gte: from, $lte: to } }, PROJECTION).sort({ day: 1 }).lean<DayRollup[]>()).map(decodeDay);
  },
  async players({ search, ids, from, sort = "last_seen", limit, skip }) {
    const user = ids ? { $in: ids } : search ? { $regex: `^${escape(search)}` } : { $ne: ERASED };
    const match = { kind: { $ne: "summary" }, user_id: user, ...(from ? { at: { $gte: from } } : {}) };
    const [result] = await RunModel.aggregate<{ players: PlayerSummary[]; total: Array<{ n: number }> }>([
      { $match: match },
      { $sort: { at: 1 } },
      {
        $group: {
          _id: "$user_id",
          language: { $last: "$language" },
          questions: { $sum: 1 },
          errors: { $sum: { $cond: [{ $eq: ["$result", "error"] }, 1, 0] } },
          cost: { $sum: "$cost" },
          input_tokens: { $sum: "$input_tokens" },
          output_tokens: { $sum: "$output_tokens" },
          searches: { $sum: "$searches" },
          avg_ms: { $avg: "$duration_ms" },
          servers: { $addToSet: "$server" },
          first_seen: { $first: "$at" },
          last_seen: { $last: "$at" },
        },
      },
      {
        $facet: {
          players: [
            { $sort: sort === "questions" ? { questions: -1, last_seen: -1 } : { last_seen: -1 } },
            { $skip: skip },
            { $limit: limit },
            { $addFields: { user_id: "$_id", servers: { $size: "$servers" }, avg_ms: { $round: [{ $ifNull: ["$avg_ms", 0] }, 0] } } },
            { $project: { _id: 0 } },
          ],
          total: [{ $count: "n" }],
        },
      },
    ]);
    return { players: result?.players ?? [], total: result?.total[0]?.n ?? 0 };
  },
  async servers({ server, limit }) {
    return RunModel.aggregate<ServerSummary>([
      { $match: { kind: { $ne: "summary" }, ...(server ? { server } : {}) } },
      { $sort: { at: 1 } },
      {
        $group: {
          _id: { server: "$server", server_id: "$server_id" },
          payer: { $last: "$payer" },
          questions: { $sum: 1 },
          players: { $addToSet: "$user_id" },
          cost: { $sum: "$cost" },
          last_seen: { $last: "$at" },
        },
      },
      { $project: { _id: 0, server: "$_id.server", server_id: "$_id.server_id", payer: 1, questions: 1, players: { $size: "$players" }, cost: 1, last_seen: 1 } },
      { $sort: { last_seen: -1 } },
      { $limit: limit },
    ]);
  },
  async of(userId, server, limit) {
    return RunModel.find({ user_id: userId, server }, PROJECTION).sort({ at: -1 }).limit(limit).lean<RunRecord[]>();
  },
  async tenantsOf(userId) {
    return RunModel.distinct("server", { user_id: userId });
  },
  async forget(userId, server) {
    const ids = (await RunModel.find({ user_id: userId, server }, { _id: 0, id: 1 }).lean<Array<{ id: string }>>()).map((r) => r.id);
    await RunModel.updateMany({ user_id: userId, server }, { $set: { user_id: ERASED } });
    await DayModel.updateMany({ players: userId }, { $pull: { players: userId } });
    return ids;
  },
  async prune(now) {
    // A pipeline update, which Mongoose only passes through from the driver.
    const result = await DayModel.collection.updateMany({ day: { $lt: cutoffDay(now) }, "players.0": { $exists: true } }, [
      { $set: { player_count: { $size: "$players" }, players: [] } },
    ]);
    return result.modifiedCount;
  },
};

/** For tests and local runs without MongoDB: the same rollups, kept in arrays. */
export const memoryRuns = (): RunStore & { all: RunRecord[] } => {
  const all: RunRecord[] = [];
  const days = new Map<string, DayRollup>();
  const matches = (run: RunRecord, filter: RunFilter) =>
    (!filter.user_id || run.user_id === filter.user_id) &&
    (!filter.server || run.server === filter.server) &&
    (!filter.server_id || run.server_id === filter.server_id) &&
    (!filter.kind || run.kind === filter.kind) &&
    (!filter.result || run.result === filter.result) &&
    (!filter.before || run.at < filter.before);
  return {
    all,
    async add(run) {
      all.push(structuredClone(run));
      const { day, inc, add } = rollupUpdate(run);
      const rollup = days.get(day) ?? ({ day, runs: 0, questions: 0, errors: 0, cancelled: 0, cost: 0, input_tokens: 0, output_tokens: 0, searches: 0, kinds: {}, models: {}, tools: {}, durations: {}, players: [], servers: [] } as DayRollup);
      for (const [path, by] of Object.entries(inc)) {
        const parts = path.split(".");
        let target = rollup as unknown as Record<string, unknown>;
        for (const part of parts.slice(0, -1)) target = (target[part] ??= {}) as Record<string, unknown>;
        const last = parts.at(-1)!;
        target[last] = ((target[last] as number) ?? 0) + by;
      }
      for (const [field, value] of Object.entries(add) as Array<["players" | "servers", string]>) {
        if (!rollup[field].includes(value)) rollup[field].push(value);
      }
      days.set(day, rollup);
    },
    async get(id) {
      return structuredClone(all.find((r) => r.id === id) ?? null);
    },
    async list(filter) {
      return structuredClone(all.filter((r) => matches(r, filter)).sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, filter.limit));
    },
    async since(from) {
      return structuredClone(all.filter((r) => r.at >= from));
    },
    async days(from, to) {
      return [...days.values()].filter((d) => d.day >= from && d.day <= to).sort((a, b) => a.day.localeCompare(b.day)).map((d) => decodeDay(structuredClone(d)));
    },
    async players({ search, ids, from, sort = "last_seen", limit, skip }) {
      const byUser = new Map<string, PlayerSummary & { tenants: Set<string>; time: number }>();
      for (const run of [...all].sort((a, b) => a.at.getTime() - b.at.getTime())) {
        if (run.kind === "summary" || (from && run.at < from)) continue;
        if (ids ? !ids.includes(run.user_id) : search ? !run.user_id.startsWith(search) : run.user_id === ERASED) continue;
        const known = byUser.get(run.user_id);
        const tenants = (known?.tenants ?? new Set<string>()).add(run.server);
        const questions = (known?.questions ?? 0) + 1;
        const time = (known?.time ?? 0) + run.duration_ms;
        byUser.set(run.user_id, {
          user_id: run.user_id,
          language: run.language ?? known?.language,
          questions,
          errors: (known?.errors ?? 0) + (run.result === "error" ? 1 : 0),
          cost: (known?.cost ?? 0) + run.cost,
          input_tokens: (known?.input_tokens ?? 0) + run.input_tokens,
          output_tokens: (known?.output_tokens ?? 0) + run.output_tokens,
          searches: (known?.searches ?? 0) + run.searches,
          avg_ms: Math.round(time / questions),
          servers: tenants.size,
          tenants,
          time,
          first_seen: known?.first_seen ?? run.at,
          last_seen: run.at,
        });
      }
      const players = [...byUser.values()]
        .map(({ tenants: _, time: __, ...p }) => p)
        .sort((a, b) => (sort === "questions" ? b.questions - a.questions : 0) || b.last_seen.getTime() - a.last_seen.getTime());
      return { players: players.slice(skip, skip + limit), total: players.length };
    },
    async servers({ server, limit }) {
      const byServer = new Map<string, ServerSummary & { users: Set<string> }>();
      for (const run of [...all].sort((a, b) => a.at.getTime() - b.at.getTime())) {
        if (run.kind === "summary" || (server && run.server !== server)) continue;
        const key = `${run.server}\n${run.server_id ?? ""}`;
        const known = byServer.get(key) ?? { server: run.server, server_id: run.server_id, payer: run.payer, questions: 0, players: 0, cost: 0, last_seen: run.at, users: new Set<string>() };
        known.questions++;
        known.cost += run.cost;
        known.users.add(run.user_id);
        known.players = known.users.size;
        known.last_seen = run.at;
        known.payer = run.payer;
        byServer.set(key, known);
      }
      return [...byServer.values()]
        .map(({ users: _, ...s }) => s)
        .sort((a, b) => b.last_seen.getTime() - a.last_seen.getTime())
        .slice(0, limit);
    },
    async of(userId, server, limit) {
      return structuredClone(all.filter((r) => r.user_id === userId && r.server === server).sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit));
    },
    async tenantsOf(userId) {
      return [...new Set(all.filter((r) => r.user_id === userId).map((r) => r.server))];
    },
    async forget(userId, server) {
      const ids: string[] = [];
      for (const run of all) {
        if (run.user_id !== userId || run.server !== server) continue;
        ids.push(run.id);
        run.user_id = ERASED;
      }
      for (const day of days.values()) day.players = day.players.filter((p) => p !== userId);
      return ids;
    },
    async prune(now) {
      let pruned = 0;
      for (const day of days.values()) {
        if (day.day >= cutoffDay(now) || !day.players.length) continue;
        day.player_count = day.players.length;
        day.players = [];
        pruned++;
      }
      return pruned;
    },
  };
};
