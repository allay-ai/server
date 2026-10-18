import { DURATION_BUCKETS, type DayRollup, type RunRecord, type RunStore } from "../../infrastructure/runs/runs";

export const RANGES = ["24h", "7d", "30d", "1y"] as const;
export type Range = (typeof RANGES)[number];

const HOUR = 3_600_000;
const DAY = 86_400_000;
const DAYS: Record<Exclude<Range, "24h">, number> = { "7d": 7, "30d": 30, "1y": 365 };

export interface Point {
  t: string;
  questions: number;
  errors: number;
  cost: number;
  players: number;
}

export interface Stats {
  range: Range;
  /** Hourly for a day, daily otherwise. */
  step: "hour" | "day";
  series: Point[];
  totals: {
    questions: number;
    errors: number;
    cancelled: number;
    error_rate: number;
    cost: number;
    cost_per_question: number;
    players: number;
    servers: number;
    searches: number;
    input_tokens: number;
    output_tokens: number;
    p50_ms: number | null;
    p95_ms: number | null;
  };
  /** Over days, percentiles are read from buckets, so they show each bucket's upper bound. */
  approximate: boolean;
  kinds: Record<string, number>;
  models: Array<{ name: string; runs: number; cost: number }>;
  tools: Array<{ name: string; calls: number; failed: number }>;
}

const round = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000;

const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);

/** The bound of the bucket where the p-th percentile falls. */
const bucketPercentile = (counts: number[], p: number) => {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const rank = Math.ceil((p / 100) * total);
  let seen = 0;
  for (const [i, count] of counts.entries()) {
    seen += count;
    if (seen >= rank) return Number.isFinite(DURATION_BUCKETS[i]) ? DURATION_BUCKETS[i] : DURATION_BUCKETS[i - 1];
  }
  return null;
};

const top = <T extends { name: string }>(entries: T[], by: (t: T) => number, n: number) => entries.sort((a, b) => by(b) - by(a)).slice(0, n);

/** The last day, hour by hour, from the runs themselves: exact percentiles. */
export const statsOfRuns = (runs: RunRecord[], now: Date): Stats => {
  const end = Math.floor(now.getTime() / HOUR) * HOUR + HOUR;
  const start = end - 24 * HOUR;
  const buckets = Array.from({ length: 24 }, (_, i) => ({ t: new Date(start + i * HOUR).toISOString(), questions: 0, errors: 0, cost: 0, users: new Set<string>() }));
  const models = new Map<string, { name: string; runs: number; cost: number }>();
  const tools = new Map<string, { name: string; calls: number; failed: number }>();
  const kinds: Record<string, number> = {};
  const players = new Set<string>();
  const servers = new Set<string>();
  const durations: number[] = [];
  let cost = 0;
  let errors = 0;
  let cancelled = 0;
  let searches = 0;
  let input = 0;
  let output = 0;
  let questions = 0;
  for (const run of runs) {
    const at = run.at.getTime();
    if (at < start || at >= end) continue;
    const bucket = buckets[Math.floor((at - start) / HOUR)];
    bucket.cost += run.cost;
    cost += run.cost;
    input += run.input_tokens;
    output += run.output_tokens;
    kinds[run.kind] = (kinds[run.kind] ?? 0) + 1;
    const model = models.get(run.model) ?? { name: run.model, runs: 0, cost: 0 };
    model.runs++;
    model.cost += run.cost;
    models.set(run.model, model);
    if (run.kind === "summary") continue;
    questions++;
    bucket.questions++;
    bucket.users.add(run.user_id);
    players.add(run.user_id);
    servers.add(run.server_id ?? run.server);
    durations.push(run.duration_ms);
    searches += run.searches;
    if (run.result === "error") {
      errors++;
      bucket.errors++;
    }
    if (run.result === "cancelled") cancelled++;
    for (const call of run.tools) {
      const tool = tools.get(call.name) ?? { name: call.name, calls: 0, failed: 0 };
      tool.calls++;
      if (!call.ok) tool.failed++;
      tools.set(call.name, tool);
    }
  }
  durations.sort((a, b) => a - b);
  return {
    range: "24h",
    step: "hour",
    series: buckets.map(({ users, ...b }) => ({ ...b, cost: round(b.cost), players: users.size })),
    totals: {
      questions,
      errors,
      cancelled,
      error_rate: questions ? errors / questions : 0,
      cost: round(cost),
      cost_per_question: questions ? round(cost / questions) : 0,
      players: players.size,
      servers: servers.size,
      searches,
      input_tokens: input,
      output_tokens: output,
      p50_ms: percentile(durations, 50),
      p95_ms: percentile(durations, 95),
    },
    approximate: false,
    kinds,
    models: top([...models.values()].map((m) => ({ ...m, cost: round(m.cost) })), (m) => m.runs, 8),
    tools: top([...tools.values()], (t) => t.calls, 20),
  };
};

const dayKey = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Days from their rollups; missing days count as empty. */
export const statsOfDays = (range: Exclude<Range, "24h">, days: DayRollup[], now: Date): Stats => {
  const count = DAYS[range];
  const today = Date.parse(`${dayKey(now.getTime())}T00:00:00Z`);
  const keys = Array.from({ length: count }, (_, i) => dayKey(today - (count - 1 - i) * DAY));
  const byDay = new Map(days.map((d) => [d.day, d]));
  const models = new Map<string, { name: string; runs: number; cost: number }>();
  const tools = new Map<string, { name: string; calls: number; failed: number }>();
  const kinds: Record<string, number> = {};
  const players = new Set<string>();
  const servers = new Set<string>();
  const histogram = DURATION_BUCKETS.map(() => 0);
  const totals = { questions: 0, errors: 0, cancelled: 0, cost: 0, searches: 0, input: 0, output: 0 };
  const series = keys.map((key): Point => {
    const day = byDay.get(key);
    if (!day) return { t: `${key}T00:00:00.000Z`, questions: 0, errors: 0, cost: 0, players: 0 };
    totals.questions += day.questions ?? 0;
    totals.errors += day.errors ?? 0;
    totals.cancelled += day.cancelled ?? 0;
    totals.cost += day.cost ?? 0;
    totals.searches += day.searches ?? 0;
    totals.input += day.input_tokens ?? 0;
    totals.output += day.output_tokens ?? 0;
    for (const [kind, n] of Object.entries(day.kinds ?? {})) kinds[kind] = (kinds[kind] ?? 0) + n;
    for (const [name, m] of Object.entries(day.models ?? {})) {
      const model = models.get(name) ?? { name, runs: 0, cost: 0 };
      model.runs += m.runs ?? 0;
      model.cost += m.cost ?? 0;
      models.set(name, model);
    }
    for (const [name, t] of Object.entries(day.tools ?? {})) {
      const tool = tools.get(name) ?? { name, calls: 0, failed: 0 };
      tool.calls += t.calls ?? 0;
      tool.failed += t.failed ?? 0;
      tools.set(name, tool);
    }
    for (const [i, n] of Object.entries(day.durations ?? {})) histogram[Number(i)] += n;
    for (const p of day.players ?? []) players.add(p);
    for (const s of day.servers ?? []) servers.add(s);
    return { t: `${key}T00:00:00.000Z`, questions: day.questions ?? 0, errors: day.errors ?? 0, cost: round(day.cost ?? 0), players: day.players?.length ?? 0 };
  });
  return {
    range,
    step: "day",
    series,
    totals: {
      questions: totals.questions,
      errors: totals.errors,
      cancelled: totals.cancelled,
      error_rate: totals.questions ? totals.errors / totals.questions : 0,
      cost: round(totals.cost),
      cost_per_question: totals.questions ? round(totals.cost / totals.questions) : 0,
      players: players.size,
      servers: servers.size,
      searches: totals.searches,
      input_tokens: totals.input,
      output_tokens: totals.output,
      p50_ms: bucketPercentile(histogram, 50),
      p95_ms: bucketPercentile(histogram, 95),
    },
    approximate: true,
    kinds,
    models: top([...models.values()].map((m) => ({ ...m, cost: round(m.cost) })), (m) => m.runs, 8),
    tools: top([...tools.values()], (t) => t.calls, 20),
  };
};

export const statsFor = async (runs: RunStore, range: Range, now: Date): Promise<Stats> => {
  if (range === "24h") return statsOfRuns(await runs.since(new Date(now.getTime() - 25 * HOUR)), now);
  const count = DAYS[range];
  const to = dayKey(now.getTime());
  const from = dayKey(Date.parse(`${to}T00:00:00Z`) - (count - 1) * DAY);
  return statsOfDays(range, await runs.days(from, to), now);
};

