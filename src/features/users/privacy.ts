import type { AllayDeps } from "../../agent/allay";
import type { Owner } from "../../shared/types/owner";
import type { Memory } from "../../infrastructure/memory/memory";
import type { SessionExport } from "../../infrastructure/history/history";

/** How many runs a player's copy lists; older ones still count in the statistics, by pseudonym. */
const EXPORT_RUNS = 1000;

/** Everything the backend keeps about one player of one tenant (GDPR art. 15). */
export interface PlayerExport extends SessionExport {
  user_id: string;
  tenant: string;
  memories: Memory[];
  /** The pseudonym the statistics know the player by. */
  pseudonym: string;
  runs: Array<{ at: string; kind: string; model: string; input_tokens: number; output_tokens: number; cost: number; duration_ms: number; result: string }>;
  retention: Record<string, string>;
}

export const exportPlayer = async (deps: AllayDeps, owner: Owner): Promise<PlayerExport> => {
  const pseudonym = deps.pseudonyms.of(owner.userId);
  const [memories, sessions, runs] = await Promise.all([
    deps.memories.list(owner),
    deps.history.export(owner),
    deps.runs?.of(pseudonym, owner.tenant, EXPORT_RUNS) ?? [],
  ]);
  return {
    user_id: owner.userId,
    tenant: owner.tenant,
    pseudonym,
    memories,
    ...sessions,
    runs: runs.map((r) => ({
      at: r.at.toISOString(),
      kind: r.kind,
      model: r.model,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cost: r.cost,
      duration_ms: r.duration_ms,
      result: r.result,
    })),
    retention: {
      memories: "until the player forgets them, or 365 days after their last question",
      session: "CHAT_TTL_SECONDS after the last question (a day by default)",
      runs: "400 days, by pseudonym",
      traces: "TRACE_DAYS (7 by default)",
    },
  };
};

/** What an erasure removed, as counts only. */
export interface Erased {
  memories: number;
  runs: number;
  traces: number;
}

/**
 * Forgets a player of one tenant (GDPR art. 17): memories, their session, pending task outcomes, and their agents'
 * threads go; their runs keep only numbers under `erased`; their traces go whole. The server's shared public thread
 * isn't theirs alone and expires within PUBLIC_CHAT_TTL_SECONDS by itself.
 */
export const erasePlayer = async (deps: AllayDeps, owner: Owner): Promise<Erased> => {
  const memories = await deps.memories.clear(owner);
  await deps.history.erase(owner);
  const runIds = (await deps.runs?.forget(deps.pseudonyms.of(owner.userId), owner.tenant)) ?? [];
  const traces = (await deps.traces?.forget(runIds)) ?? 0;
  return { memories, runs: runIds.length, traces };
};
