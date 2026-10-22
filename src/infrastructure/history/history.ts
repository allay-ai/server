import type { ModelMessage } from "ai";
import { Schema, model } from "mongoose";
import { settings } from "../../features/settings/settings";
import { logger } from "../../shared/logging/logger";
import type { Owner } from "../../shared/types/owner";
import { type Sealed, openJson, sealJson } from "../crypto/data";

export type { Owner };

/** A message as the model reads it: the question, the answer, and the tool calls and results between them. */
export type HistoryMessage = ModelMessage;

/** A player's conversation: recent messages verbatim and a summary of what came before them. */
export interface Session {
  summary?: string;
  messages: HistoryMessage[];
}

/** Writes a new summary from the old one and the messages that drop out of the verbatim window. */
export type Summarize = (summary: string | undefined, older: HistoryMessage[]) => Promise<string>;

/** A conversation a run reads and writes; the kind sets how long it lives. */
export interface Thread {
  key: string;
  kind: "private" | "public" | "task";
}

/** Everything the sessions hold about one player, for their copy of it. */
export interface SessionExport {
  session: Session;
  outcomes: string[];
  /** Each automation agent's own thread, by task id. */
  tasks: Record<string, Session>;
}

/** Sessions per player and tenant, shared by v1 and v2 so a conversation carries over between them. */
export interface HistoryStore {
  load(thread: Thread): Promise<Session>;
  /** Adds one exchange: the question and everything the run said and called for it. */
  append(thread: Thread, ...messages: HistoryMessage[]): Promise<void>;
  /** Once the session outgrows foldAt tokens (CHAT_FOLD_TOKENS by default) or MAX_EXCHANGES, folds all but about CHAT_KEEP_TOKENS of it into the summary. True when it folded. */
  compact(thread: Thread, summarize: Summarize, foldAt?: number): Promise<boolean>;
  /** `/ask new`: the player's own session and pending outcomes go; their memories and agents' threads stay. */
  clear(owner: Owner): Promise<void>;
  /** Keeps how one of the player's automations ended, until their next question carries it to the chat. */
  noteOutcome(owner: Owner, outcome: string): Promise<void>;
  /** The outcomes kept since the player's last question, oldest first; each is handed out once. */
  takeOutcomes(owner: Owner): Promise<string[]>;
  /** Everything kept about the player: their session, outcomes, and agents' threads. */
  export(owner: Owner): Promise<SessionExport>;
  /** Erases all of it; the server's shared public thread expires on its own within PUBLIC_CHAT_TTL_SECONDS. */
  erase(owner: Owner): Promise<void>;
}

/**
 * The session folds once its messages pass this many tokens. Each step reads them again, mostly from the
 * provider's cache, so a long verbatim window is cheap until a question comes after the cache has gone cold.
 */
export const foldTokens = () => settings.get("CHAT_FOLD_TOKENS");
/** Past this many, the session folds before the next question is answered, not after: the player waits for the summary. */
export const maxTokens = () => settings.get("CHAT_MAX_TOKENS");
/** About this many tokens of the newest exchanges stay verbatim after a fold. */
export const keepTokens = () => settings.get("CHAT_KEEP_TOKENS");
/** A fold keeps at least this many exchanges, however long they are. */
export const MIN_KEEP_EXCHANGES = 2;
/** Short exchanges fold too, once there are this many, down to at most KEEP_EXCHANGES. */
export const MAX_EXCHANGES = 100;
export const KEEP_EXCHANGES = 30;
export const sessionTtl = () => settings.get("CHAT_TTL_SECONDS");
/** A server's thread of public questions is a passing talk, so it lives shorter than a player's session. */
export const publicTtl = () => settings.get("PUBLIC_CHAT_TTL_SECONDS");
/** An automation agent's own thread: its wakes and its notes to itself, for as long as a task could run. */
export const taskTtl = () => settings.get("TASK_CHAT_TTL_SECONDS");
/**
 * The session a run reads and writes: a task's own thread for an automation agent, the server's shared thread for
 * public questions, the asker's own otherwise. Every key starts with the tenant, and user ids, server ids, and task
 * ids hold no colon, so no two threads share a key and no tenant reaches another's.
 */
export const threadOf = (owner: Owner, visibility?: string, serverId?: string, taskId?: string): Thread => {
  if (taskId) return { key: `${owner.tenant}:t:${owner.userId}:${taskId}`, kind: "task" };
  if (visibility === "public" && serverId) return { key: `${owner.tenant}:p:${serverId}`, kind: "public" };
  return { key: `${owner.tenant}:u:${owner.userId}`, kind: "private" };
};

const privateThread = (owner: Owner) => threadOf(owner);
const taskPrefix = (owner: Owner) => `${owner.tenant}:t:${owner.userId}:`;

export const ttlOf = (thread: Thread) => (thread.kind === "task" ? taskTtl() : thread.kind === "public" ? publicTtl() : sessionTtl());
// If folding keeps failing, the oldest exchanges simply fall off here.
const CAP = MAX_EXCHANGES + 20;
const MAX_CONTENT = 4000;
export const MAX_SUMMARY = 3000;

/** A rough count that errs high: about three characters a token for English, Russian, and JSON alike. */
export const estimateTokens = (messages: HistoryMessage[]) => Math.ceil(JSON.stringify(messages).length / 3);

/** A player who starts task after task and never asks keeps only the latest outcomes. */
const MAX_OUTCOMES = 10;

const isMessage = (value: unknown): value is HistoryMessage => {
  const message = value as { role?: unknown; content?: unknown };
  return ["user", "assistant", "tool"].includes(message?.role as string) && (typeof message.content === "string" || Array.isArray(message.content));
};

/** One exchange per entry, sealed since 6.9; entries from before 5.5 hold a single text message each. */
const parse = (raw: string | Sealed): HistoryMessage[] | undefined => {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : openJson<{ messages?: unknown; role?: unknown; content?: unknown }>(raw);
    if (!value) return undefined;
    if (Array.isArray(value.messages)) return value.messages.filter(isMessage);
    if ((value.role === "user" || value.role === "assistant") && typeof value.content === "string") {
      return [{ role: value.role, content: value.content }];
    }
  } catch {
    // A broken entry is skipped; the rest of the history still helps.
  }
  return undefined;
};

const entry = (messages: HistoryMessage[]): HistoryMessage[] =>
  messages
    .map((m) => (typeof m.content === "string" ? ({ ...m, content: m.content.trim().slice(0, MAX_CONTENT) } as HistoryMessage) : m))
    .filter((m) => m.content.length > 0);

/** How many of the newest exchanges stay verbatim, or undefined when nothing needs to fold. Exchanges come newest first. */
const keepOf = (exchanges: HistoryMessage[][], foldAt: number): number | undefined => {
  const sizes = exchanges.map(estimateTokens);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= foldAt && exchanges.length <= MAX_EXCHANGES) return undefined;
  let kept = 0;
  let tokens = 0;
  while (kept < exchanges.length && (kept < MIN_KEEP_EXCHANGES || (kept < KEEP_EXCHANGES && tokens + sizes[kept] <= keepTokens()))) tokens += sizes[kept++];
  return kept < exchanges.length ? kept : undefined;
};

const exchangesOf = (raw: Array<string | Sealed>) => raw.map(parse).filter((m): m is HistoryMessage[] => !!m);

/**
 * A conversation: exchanges newest first, each sealed on its own so a push needs no read, and the sealed summary beside
 * them. Strings are exchanges from before 6.9, in the clear; they expire within CHAT_TTL_SECONDS.
 */
interface SessionDoc {
  key: string;
  /** A new id whenever the session starts over, so a fold that began before /ask new can't write into the next one. */
  started: string;
  summary?: string | Sealed;
  exchanges: Array<string | Sealed>;
  expires_at: Date;
}

/** How an automation ended, kept by the player's private thread until their next question. */
interface OutcomesDoc {
  key: string;
  outcomes: Array<string | Sealed>;
  expires_at: Date;
}

const sessionSchema = new Schema<SessionDoc>({
  key: { type: String, required: true, unique: true },
  started: { type: String, required: true },
  summary: Schema.Types.Mixed,
  exchanges: { type: [Schema.Types.Mixed], default: [] },
  expires_at: { type: Date, required: true },
});
// Only garbage collection: the monitor runs about once a minute, so every read checks expires_at itself.
sessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

const outcomesSchema = new Schema<OutcomesDoc>({
  key: { type: String, required: true, unique: true },
  outcomes: { type: [Schema.Types.Mixed], default: [] },
  expires_at: { type: Date, required: true },
});
outcomesSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

export const SessionModel = model<SessionDoc>("Session", sessionSchema, "sessions");
export const OutcomesModel = model<OutcomesDoc>("Outcomes", outcomesSchema, "session_outcomes");

/** Keys that start with [prefix], as an anchored regex, so the unique index on key serves it. */
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const startingWith = (prefix: string) => new RegExp(`^${escapeRegex(prefix)}`);

/** The exchanges a document holds, oldest first, as the model reads them. */
const sessionOf = (doc: Pick<SessionDoc, "summary" | "exchanges"> | null): Session => {
  if (!doc) return { messages: [] };
  const summary = doc.summary ? openJson<string>(doc.summary) : undefined;
  return { messages: exchangesOf(doc.exchanges ?? []).reverse().flat(), ...(summary ? { summary } : {}) };
};

const outcomesOf = (stored: Array<string | Sealed> | undefined) => (stored ?? []).map((o) => openJson<string>(o)).filter((o): o is string => typeof o === "string");

/**
 * Sessions in MongoDB. Expiry is exact without the TTL monitor: every read asks for `expires_at` after now, a read that
 * misses deletes an expired document at once, and a write onto an expired session starts it over.
 */
export const mongoHistory = (now: () => number = Date.now): HistoryStore => {
  const sessions = () => SessionModel.collection;
  const outcomes = () => OutcomesModel.collection;
  const alive = () => ({ $gt: new Date(now()) });
  /** Deletes what lies past its time under [filter]; nobody waits for it. */
  const sweep = (collection: ReturnType<typeof sessions>, filter: Record<string, unknown>) =>
    void collection.deleteMany({ ...filter, expires_at: { $lte: new Date(now()) } }).catch(() => {});

  const read = async (key: string) => {
    const doc = await sessions().findOne<SessionDoc>({ key, expires_at: alive() });
    if (!doc) sweep(sessions(), { key });
    return doc;
  };

  /** Pipeline values: whether the stored session is still alive, and a fresh one's start otherwise. */
  const living = (at: Date) => ({ $gt: [{ $ifNull: ["$expires_at", new Date(0)] }, at] });

  return {
    async load(thread) {
      try {
        return sessionOf(await read(thread.key));
      } catch (error) {
        // History is a nicety: answer without it rather than fail the question.
        logger.warn(`History unavailable: ${String(error)}`);
        return { messages: [] };
      }
    },
    async append(thread, ...messages) {
      const kept = entry(messages);
      if (kept.length === 0) return;
      const at = new Date(now());
      const raw = sealJson({ id: crypto.randomUUID(), messages: kept });
      try {
        // One atomic pipeline: push onto a live session, or start an expired or missing one over without its past.
        await sessions().updateOne(
          { key: thread.key },
          [
            {
              $set: {
                exchanges: { $cond: [living(at), { $slice: [{ $concatArrays: [[{ $literal: raw }], "$exchanges"] }, CAP] }, [{ $literal: raw }]] },
                summary: { $cond: [living(at), "$summary", "$$REMOVE"] },
                started: { $cond: [living(at), "$started", { $literal: crypto.randomUUID() }] },
                expires_at: { $literal: new Date(at.getTime() + ttlOf(thread) * 1000) },
              },
            },
          ],
          { upsert: true },
        );
      } catch (error) {
        logger.warn(`Couldn't save history: ${String(error)}`);
      }
    },
    async compact(thread, summarize, foldAt = foldTokens()) {
      const doc = await read(thread.key);
      if (!doc) return false;
      const parsed = doc.exchanges.map(parse);
      const valid = parsed.flatMap((exchange, i) => (exchange ? [i] : []));
      const exchanges = valid.map((i) => parsed[i]!);
      const kept = keepOf(exchanges, foldAt);
      if (kept === undefined) return false;
      const older = exchanges.slice(kept).reverse().flat();
      const summary = (await summarize(sessionOf(doc).summary, older)).trim().slice(0, MAX_SUMMARY);
      // The stored entries to keep, broken ones among them included; exchanges appended while the summary was written
      // sit at the head, so they stay too. A session that started over meanwhile has another start, and the fold leaves it alone.
      const keep = { $add: [valid[kept]!, { $max: [0, { $subtract: [{ $size: "$exchanges" }, doc.exchanges.length] }] }] };
      await sessions().updateOne({ key: thread.key, started: doc.started, expires_at: alive() }, [
        { $set: { exchanges: { $slice: ["$exchanges", keep] }, ...(summary ? { summary: { $literal: sealJson(summary) } } : {}) } },
      ]);
      return true;
    },
    async clear(owner) {
      await Promise.all([sessions().deleteOne({ key: privateThread(owner).key }), outcomes().deleteOne({ key: privateThread(owner).key })]);
    },
    async noteOutcome(owner, outcome) {
      const at = new Date(now());
      try {
        await outcomes().updateOne(
          { key: privateThread(owner).key },
          [
            {
              $set: {
                outcomes: { $cond: [living(at), { $slice: [{ $concatArrays: ["$outcomes", [{ $literal: sealJson(outcome) }]] }, -MAX_OUTCOMES] }, [{ $literal: sealJson(outcome) }]] },
                expires_at: { $literal: new Date(at.getTime() + sessionTtl() * 1000) },
              },
            },
          ],
          { upsert: true },
        );
      } catch (error) {
        logger.warn(`Couldn't keep a task outcome: ${String(error)}`);
      }
    },
    async takeOutcomes(owner) {
      const key = privateThread(owner).key;
      try {
        // One delete takes them all at once, so two questions at the same time can't both get them.
        const doc = await outcomes().findOneAndDelete({ key, expires_at: alive() });
        if (!doc) sweep(outcomes(), { key });
        return outcomesOf(doc?.outcomes as OutcomesDoc["outcomes"] | undefined);
      } catch (error) {
        logger.warn(`Task outcomes unavailable: ${String(error)}`);
        return [];
      }
    },
    async export(owner) {
      const prefix = taskPrefix(owner);
      const tasks: Record<string, Session> = {};
      for await (const doc of sessions().find<SessionDoc>({ key: startingWith(prefix), expires_at: alive() })) tasks[doc.key.slice(prefix.length)] = sessionOf(doc);
      const pending = await outcomes().findOne<OutcomesDoc>({ key: privateThread(owner).key, expires_at: alive() });
      return { session: sessionOf(await read(privateThread(owner).key)), outcomes: outcomesOf(pending?.outcomes), tasks };
    },
    async erase(owner) {
      const key = privateThread(owner).key;
      await Promise.all([
        sessions().deleteMany({ $or: [{ key }, { key: startingWith(taskPrefix(owner)) }] }),
        outcomes().deleteOne({ key }),
      ]);
    },
  };
};

/** For tests and local runs without MongoDB; the same windows, and the same exact expiry by [now]. */
export const memoryHistory = (now: () => number = Date.now): HistoryStore & { keys: () => string[] } => {
  type Stored = { summary?: string; exchanges: HistoryMessage[][]; started: number; until: number };
  const store = new Map<string, Stored>();
  const outcomes = new Map<string, { list: string[]; until: number }>();
  let starts = 0;
  const live = <T extends { until: number }>(map: Map<string, T>, key: string): T | undefined => {
    const found = map.get(key);
    if (found && found.until <= now()) map.delete(key);
    return found && found.until > now() ? found : undefined;
  };
  const load = (key: string): Session => {
    const session = live(store, key);
    return session ? { ...(session.summary ? { summary: session.summary } : {}), messages: session.exchanges.flat() } : { messages: [] };
  };
  return {
    keys: () => [...store.keys(), ...[...outcomes.keys()].map((k) => `outcomes:${k}`)],
    async load(thread) {
      return load(thread.key);
    },
    async append(thread, ...messages) {
      const kept = entry(messages);
      if (kept.length === 0) return;
      const session = live(store, thread.key);
      const until = now() + ttlOf(thread) * 1000;
      if (session) Object.assign(session, { exchanges: [...session.exchanges, kept].slice(-CAP), until });
      else store.set(thread.key, { exchanges: [kept], started: ++starts, until });
    },
    async compact(thread, summarize, foldAt = foldTokens()) {
      const session = live(store, thread.key);
      if (!session) return false;
      const read = session.exchanges.length;
      const newest = [...session.exchanges].reverse();
      const kept = keepOf(newest, foldAt);
      if (kept === undefined) return false;
      const older = newest.slice(kept).reverse().flat();
      const summary = (await summarize(session.summary, older)).trim().slice(0, MAX_SUMMARY);
      // As in MongoDB: exchanges appended meanwhile stay, and a session that started over is left alone.
      const current = live(store, thread.key);
      if (!current || current.started !== session.started) return true;
      const added = Math.max(0, current.exchanges.length - read);
      Object.assign(current, { summary: summary || current.summary, exchanges: current.exchanges.slice(-(kept + added)) });
      return true;
    },
    async clear(owner) {
      store.delete(privateThread(owner).key);
      outcomes.delete(privateThread(owner).key);
    },
    async noteOutcome(owner, outcome) {
      const at = privateThread(owner).key;
      outcomes.set(at, { list: [...(live(outcomes, at)?.list ?? []), outcome].slice(-MAX_OUTCOMES), until: now() + sessionTtl() * 1000 });
    },
    async takeOutcomes(owner) {
      const at = privateThread(owner).key;
      const taken = live(outcomes, at)?.list ?? [];
      outcomes.delete(at);
      return taken;
    },
    async export(owner) {
      const tasks: Record<string, Session> = {};
      for (const at of [...store.keys()]) {
        if (at.startsWith(taskPrefix(owner)) && live(store, at)) tasks[at.slice(taskPrefix(owner).length)] = load(at);
      }
      return { session: load(privateThread(owner).key), outcomes: [...(live(outcomes, privateThread(owner).key)?.list ?? [])], tasks };
    },
    async erase(owner) {
      for (const at of [...store.keys()]) if (at.startsWith(taskPrefix(owner))) store.delete(at);
      store.delete(privateThread(owner).key);
      outcomes.delete(privateThread(owner).key);
    },
  };
};
