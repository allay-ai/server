import type { AllayDeps } from "../../agent/allay";
import type { Owner } from "../../shared/types/owner";
import type { Memory } from "../../infrastructure/memory/memory";
import type { SessionExport } from "../../infrastructure/history/history";
import type { Consent } from "../../infrastructure/privacy/consents";
import type { Death } from "../../infrastructure/playerdata/deaths";
import type { StoredState } from "../../infrastructure/playerdata/state";

/** How many runs a player's copy lists; older ones still count in the statistics, by pseudonym. */
const EXPORT_RUNS = 1000;

/** Everything the backend keeps about one player of one tenant (GDPR art. 15). */
export interface PlayerExport extends SessionExport {
  user_id: string;
  tenant: string;
  /** Facts and places. */
  memories: Memory[];
  /** Since 6.9: their deaths, newest first. */
  deaths: Death[];
  /** Since 6.9: their time zone, settings, and goals, as the plugin keeps them. */
  state: StoredState | null;
  /** The notice the player agreed to and when, or null. */
  consent: Consent | null;
  /** The pseudonym the statistics know the player by. */
  pseudonym: string;
  /** When operators stopped the player from asking on this tenant, or null. */
  blocked_at: string | null;
  /** The name the panel knows the player by on this tenant, from their last question, or null. */
  name: string | null;
  runs: Array<{ at: string; kind: string; model: string; input_tokens: number; output_tokens: number; cost: number; duration_ms: number; result: string }>;
  retention: Record<string, string>;
}

export const exportPlayer = async (deps: AllayDeps, owner: Owner): Promise<PlayerExport> => {
  const pseudonym = deps.pseudonyms.of(owner.tenant, owner.userId);
  const [memories, deaths, state, consent, sessions, runs, bans, known] = await Promise.all([
    deps.memories.list(owner),
    deps.deaths.list(owner),
    deps.states.get(owner),
    deps.consents.get(owner),
    deps.history.export(owner),
    deps.runs?.of(pseudonym, owner.tenant, EXPORT_RUNS) ?? [],
    deps.bans.of([pseudonym]),
    deps.players?.get(owner.tenant, pseudonym) ?? null,
  ]);
  return {
    user_id: owner.userId,
    tenant: owner.tenant,
    pseudonym,
    blocked_at: bans.get(pseudonym)?.find((b) => b.tenant === owner.tenant)?.blocked_at ?? null,
    name: known?.name ?? null,
    memories,
    deaths,
    state,
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
      memories: "until the player deletes them, or 365 days after their last question",
      deaths: "the newest DEATHS_MAX (100 by default), and 365 days after the player's last question",
      state: "365 days after the player's last question",
      consent: "until the player withdraws it, their data is erased, or 730 days after their last question",
      session: "CHAT_TTL_SECONDS after the last question (30 days by default)",
      runs: "730 days, by pseudonym",
      name: "730 days after the last question, for the panel",
      traces: "TRACE_DAYS (30 by default)",
      block: "until an operator unblocks the player, by pseudonym; an erasure doesn't lift it",
    },
  };
};

/**
 * The id behind a pseudonym on one tenant: the directory of players who asked since 6.4, then those who agreed to
 * the notice there (everyone who asked since 6.1) and those with memories. Null when none knows them.
 */
export const findPlayer = async (deps: Pick<AllayDeps, "consents" | "memories" | "pseudonyms" | "players">, tenant: string, pseudonym: string): Promise<string | null> => {
  const known = await deps.players?.get(tenant, pseudonym);
  if (known) return known.user_id;
  const ids = new Set([...(await deps.consents.users(tenant)), ...(await deps.memories.users(tenant))]);
  for (const id of ids) if (deps.pseudonyms.of(tenant, id) === pseudonym) return id;
  return null;
};

/** What an erasure removed, as counts only. */
export interface Erased {
  memories: number;
  deaths: number;
  runs: number;
  traces: number;
}

/**
 * Forgets a player of one tenant (GDPR art. 17): memories, deaths, their state, open export links, their consent, their
 * name in the directory, their session, pending task outcomes, and their agents' threads go; their runs keep only numbers under `erased`; their traces go whole. The server's shared public thread
 * isn't theirs alone and expires within PUBLIC_CHAT_TTL_SECONDS by itself.
 */
export const erasePlayer = async (deps: AllayDeps, owner: Owner): Promise<Erased> => {
  const memories = await deps.memories.clear(owner);
  const deaths = await deps.deaths.clear(owner);
  await deps.states.clear(owner);
  await deps.exports.revoke(owner);
  await deps.players?.forget(owner.tenant, deps.pseudonyms.of(owner.tenant, owner.userId));
  await deps.consents.withdraw(owner);
  await deps.history.erase(owner);
  const runIds = (await deps.runs?.forget(deps.pseudonyms.of(owner.tenant, owner.userId), owner.tenant)) ?? [];
  const traces = (await deps.traces?.forget(runIds)) ?? 0;
  return { memories, deaths, runs: runIds.length, traces };
};

/**
 * Erasure by pseudonym, from the panel: the whole erasure when the backend can tell who it is; otherwise nothing names
 * the player but their runs and traces (no consent, no memories, and a session that long expired), so those go.
 */
export const erasePseudonym = async (deps: AllayDeps, tenant: string, pseudonym: string): Promise<Erased> => {
  const userId = await findPlayer(deps, tenant, pseudonym);
  if (userId) return erasePlayer(deps, { tenant, userId });
  await deps.players?.forget(tenant, pseudonym);
  const runIds = (await deps.runs?.forget(pseudonym, tenant)) ?? [];
  const traces = (await deps.traces?.forget(runIds)) ?? 0;
  return { memories: 0, deaths: 0, runs: runIds.length, traces };
};
