import type { RunRecord } from "../../infrastructure/runs/runs";

const DAY = 86_400_000;

/** How many days the activity chart on a player's page covers. */
export const PROFILE_DAYS = 30;

/** How many of a player's runs the profile reads, newest first; enough for anyone but a bot. */
export const PROFILE_RUNS = 5_000;

export interface Profile {
  errors: number;
  cancelled: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  searches: number;
  tool_calls: number;
  tool_failures: number;
  p50_ms: number | null;
  p95_ms: number | null;
  /** Questions per day over the last PROFILE_DAYS days, oldest first. */
  activity: Array<{ t: string; questions: number; errors: number; cost: number }>;
  kinds: Record<string, number>;
  models: Array<{ name: string; runs: number; cost: number }>;
  tools: Array<{ name: string; calls: number; failed: number }>;
  /** When in the day (UTC hours) the player asks. */
  hours: number[];
}

const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);

const round = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000;

/** A player's runs as numbers for their page: what they ask with, how it goes, and when. */
export const profileOf = (runs: RunRecord[], now: Date): Profile => {
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const start = today - (PROFILE_DAYS - 1) * DAY;
  const activity = Array.from({ length: PROFILE_DAYS }, (_, i) => ({ t: new Date(start + i * DAY).toISOString(), questions: 0, errors: 0, cost: 0 }));
  const models = new Map<string, { name: string; runs: number; cost: number }>();
  const tools = new Map<string, { name: string; calls: number; failed: number }>();
  const kinds: Record<string, number> = {};
  const hours = Array.from({ length: 24 }, () => 0);
  const durations: number[] = [];
  const profile = { errors: 0, cancelled: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, searches: 0, tool_calls: 0, tool_failures: 0 };
  for (const run of runs) {
    if (run.kind === "summary") continue;
    profile.input_tokens += run.input_tokens;
    profile.output_tokens += run.output_tokens;
    profile.reasoning_tokens += run.reasoning_tokens ?? 0;
    profile.searches += run.searches;
    if (run.result === "error") profile.errors++;
    if (run.result === "cancelled") profile.cancelled++;
    kinds[run.kind] = (kinds[run.kind] ?? 0) + 1;
    hours[run.at.getUTCHours()]++;
    durations.push(run.duration_ms);
    const model = models.get(run.model) ?? { name: run.model, runs: 0, cost: 0 };
    model.runs++;
    model.cost += run.cost;
    models.set(run.model, model);
    for (const call of run.tools) {
      const tool = tools.get(call.name) ?? { name: call.name, calls: 0, failed: 0 };
      tool.calls++;
      profile.tool_calls++;
      if (!call.ok) {
        tool.failed++;
        profile.tool_failures++;
      }
      tools.set(call.name, tool);
    }
    const day = Math.floor((run.at.getTime() - start) / DAY);
    if (day >= 0 && day < PROFILE_DAYS) {
      activity[day].questions++;
      activity[day].cost += run.cost;
      if (run.result === "error") activity[day].errors++;
    }
  }
  durations.sort((a, b) => a - b);
  return {
    ...profile,
    p50_ms: percentile(durations, 50),
    p95_ms: percentile(durations, 95),
    activity: activity.map((d) => ({ ...d, cost: round(d.cost) })),
    kinds,
    models: [...models.values()].map((m) => ({ ...m, cost: round(m.cost) })).sort((a, b) => b.runs - a.runs).slice(0, 8),
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls).slice(0, 12),
    hours,
  };
};
