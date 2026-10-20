import type { AllayDeps } from "../../agent/allay";
import type { Owner } from "../../shared/types/owner";
import type { Memory } from "../../infrastructure/memory/memory";
import type { SessionExport } from "../../infrastructure/history/history";
import type { Consent } from "../../infrastructure/privacy/consents";

/** How many runs a player's copy lists; older ones still count in the statistics, by pseudonym. */
const EXPORT_RUNS = 1000;

/** Everything the backend keeps about one player of one tenant (GDPR art. 15). */
export interface PlayerExport extends SessionExport {
  user_id: string;
  tenant: string;
  memories: Memory[];
  /** The notice the player agreed to and when, or null. */
  consent: Consent | null;
  /** The pseudonym the statistics know the player by. */
  pseudonym: string;
  /** When operators stopped the player from asking on this tenant, or null. */
  blocked_at: string | null;
  runs: Array<{ at: string; kind: string; model: string; input_tokens: number; output_tokens: number; cost: number; duration_ms: number; result: string }>;
  retention: Record<string, string>;
}

export const exportPlayer = async (deps: AllayDeps, owner: Owner): Promise<PlayerExport> => {
  const pseudonym = deps.pseudonyms.of(owner.userId);
  const [memories, consent, sessions, runs, bans] = await Promise.all([
    deps.memories.list(owner),
    deps.consents.get(owner),
    deps.history.export(owner),
    deps.runs?.of(pseudonym, owner.tenant, EXPORT_RUNS) ?? [],
    deps.bans.of([pseudonym]),
  ]);
  return {
    user_id: owner.userId,
    tenant: owner.tenant,
    pseudonym,
    blocked_at: bans.get(pseudonym)?.find((b) => b.tenant === owner.tenant)?.blocked_at ?? null,
    memories,
    consent,
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
      consent: "until the player withdraws it or their data is erased",
      session: "CHAT_TTL_SECONDS after the last question (a day by default)",
      runs: "400 days, by pseudonym",
      traces: "TRACE_DAYS (7 by default)",
      block: "until an operator unblocks the player, by pseudonym; an erasure doesn't lift it",
    },
  };
};

/**
 * The id behind a pseudonym on one tenant, which the panel never shows: the players who agreed to the notice there
 * (everyone who asked since 6.1) and those with memories. Null when neither knows them.
 */
export const findPlayer = async (deps: Pick<AllayDeps, "consents" | "memories" | "pseudonyms">, tenant: string, pseudonym: string): Promise<string | null> => {
  const ids = new Set([...(await deps.consents.users(tenant)), ...(await deps.memories.users(tenant))]);
  for (const id of ids) if (deps.pseudonyms.of(id) === pseudonym) return id;
  return null;
};

/** What an erasure removed, as counts only. */
export interface Erased {
  memories: number;
  runs: number;
  traces: number;
}

/**
 * Forgets a player of one tenant (GDPR art. 17): memories, their consent, their session, pending task outcomes, and their agents'
 * threads go; their runs keep only numbers under `erased`; their traces go whole. The server's shared public thread
 * isn't theirs alone and expires within PUBLIC_CHAT_TTL_SECONDS by itself.
 */
export const erasePlayer = async (deps: AllayDeps, owner: Owner): Promise<Erased> => {
  const memories = await deps.memories.clear(owner);
  await deps.consents.withdraw(owner);
  await deps.history.erase(owner);
  const runIds = (await deps.runs?.forget(deps.pseudonyms.of(owner.userId), owner.tenant)) ?? [];
  const traces = (await deps.traces?.forget(runIds)) ?? 0;
  return { memories, runs: runIds.length, traces };
};

/**
 * Erasure by pseudonym, from the panel: the whole erasure when the backend can tell who it is; otherwise nothing names
 * the player but their runs and traces (no consent, no memories, and a session that long expired), so those go.
 */
export const erasePseudonym = async (deps: AllayDeps, tenant: string, pseudonym: string): Promise<Erased> => {
  const userId = await findPlayer(deps, tenant, pseudonym);
  if (userId) return erasePlayer(deps, { tenant, userId });
  const runIds = (await deps.runs?.forget(pseudonym, tenant)) ?? [];
  const traces = (await deps.traces?.forget(runIds)) ?? 0;
  return { memories: 0, runs: runIds.length, traces };
};
