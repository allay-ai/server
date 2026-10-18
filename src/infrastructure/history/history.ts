import type { ModelMessage } from "ai";
import { redis } from "bun";
import { settings } from "../../features/settings/settings";
import { logger } from "../../shared/logging/logger";

/** A message as the model reads it: the question, the answer, and the tool calls and results between them. */
export type HistoryMessage = ModelMessage;

/** A player's conversation: recent messages verbatim and a summary of what came before them. */
export interface Session {
  summary?: string;
  messages: HistoryMessage[];
}

/** Writes a new summary from the old one and the messages that drop out of the verbatim window. */
export type Summarize = (summary: string | undefined, older: HistoryMessage[]) => Promise<string>;

/** Sessions per user, shared by v1 and v2 so a conversation carries over between them. */
export interface HistoryStore {
  load(userId: string): Promise<Session>;
  /** Adds one exchange: the question and everything the run said and called for it. */
  append(userId: string, ...messages: HistoryMessage[]): Promise<void>;
  /** Once the session outgrows foldAt tokens (CHAT_FOLD_TOKENS by default) or MAX_EXCHANGES, folds all but about CHAT_KEEP_TOKENS of it into the summary. True when it folded. */
  compact(userId: string, summarize: Summarize, foldAt?: number): Promise<boolean>;
  clear(userId: string): Promise<void>;
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
const PUBLIC_PREFIX = "public:";
const TASK_PREFIX = "task:";

/**
 * The session a run reads and writes: a task's own thread for an automation agent, the server's shared
 * thread for public questions, the asker's own otherwise. User ids have no colon, so none of these collide.
 */
export const threadOf = (userId: string, visibility?: string, serverId?: string, taskId?: string) => {
  if (taskId) return `${TASK_PREFIX}${userId}:${taskId}`;
  return visibility === "public" && serverId ? `${PUBLIC_PREFIX}${serverId}` : userId;
};

export const ttlOf = (thread: string) => {
  if (thread.startsWith(TASK_PREFIX)) return taskTtl();
  return thread.startsWith(PUBLIC_PREFIX) ? publicTtl() : sessionTtl();
};
// If folding keeps failing, the oldest exchanges simply fall off here.
const CAP = MAX_EXCHANGES + 20;
const MAX_CONTENT = 4000;
export const MAX_SUMMARY = 3000;

/** A rough count that errs high: about three characters a token for English, Russian, and JSON alike. */
export const estimateTokens = (messages: HistoryMessage[]) => Math.ceil(JSON.stringify(messages).length / 3);

const key = (userId: string) => `chat_history:${userId}`;
const summaryKey = (userId: string) => `chat_summary:${userId}`;

const isMessage = (value: unknown): value is HistoryMessage => {
  const message = value as { role?: unknown; content?: unknown };
  return ["user", "assistant", "tool"].includes(message?.role as string) && (typeof message.content === "string" || Array.isArray(message.content));
};

/** One exchange per entry; entries from before 5.5 hold a single text message each. */
const parse = (raw: string): HistoryMessage[] | undefined => {
  try {
    const value = JSON.parse(raw);
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

const exchangesOf = (raw: string[]) => raw.map(parse).filter((m): m is HistoryMessage[] => !!m);

/** Newest exchange first in a Redis list (the v1 key), the summary next to it; both expire together. */
export const redisHistory: HistoryStore = {
  async load(userId) {
    try {
      const [raw, summary] = await Promise.all([
        redis.send("LRANGE", [key(userId), "0", String(CAP - 1)]) as Promise<string[]>,
        redis.get(summaryKey(userId)),
      ]);
      return { messages: exchangesOf(raw ?? []).reverse().flat(), ...(summary ? { summary } : {}) };
    } catch (error) {
      // History is a nicety: answer without it rather than fail the question.
      logger.warn(`History unavailable for ${userId}: ${String(error)}`);
      return { messages: [] };
    }
  },
  async append(userId, ...messages) {
    const kept = entry(messages);
    if (kept.length === 0) return;
    try {
      await redis.send("LPUSH", [key(userId), JSON.stringify({ id: crypto.randomUUID(), messages: kept })]);
      await redis.send("LTRIM", [key(userId), "0", String(CAP - 1)]);
      await redis.expire(key(userId), ttlOf(userId));
      await redis.expire(summaryKey(userId), ttlOf(userId));
    } catch (error) {
      logger.warn(`Couldn't save history for ${userId}: ${String(error)}`);
    }
  },
  async compact(userId, summarize, foldAt = foldTokens()) {
    const raw = (await redis.send("LRANGE", [key(userId), "0", "-1"])) as string[];
    const exchanges = exchangesOf(raw);
    const kept = keepOf(exchanges, foldAt);
    if (kept === undefined) return false;
    const older = exchanges.slice(kept).reverse().flat();
    const summary = (await summarize((await redis.get(summaryKey(userId))) ?? undefined, older)).trim().slice(0, MAX_SUMMARY);
    if (summary) await redis.set(summaryKey(userId), summary, "EX", ttlOf(userId));
    // Exchanges appended while the summary was written sit at the head, so they stay too.
    const added = Number(await redis.send("LLEN", [key(userId)])) - raw.length;
    await redis.send("LTRIM", [key(userId), "0", String(kept + Math.max(added, 0) - 1)]);
    return true;
  },
  async clear(userId) {
    await redis.del(key(userId), summaryKey(userId));
  },
};

/** For tests and local runs without Redis; same windows, no expiry. */
export const memoryHistory = (): HistoryStore => {
  const store = new Map<string, { summary?: string; exchanges: HistoryMessage[][] }>();
  const of = (userId: string) => store.get(userId) ?? { exchanges: [] };
  return {
    async load(userId) {
      const session = of(userId);
      return { ...(session.summary ? { summary: session.summary } : {}), messages: session.exchanges.flat() };
    },
    async append(userId, ...messages) {
      const kept = entry(messages);
      if (kept.length === 0) return;
      const session = of(userId);
      store.set(userId, { ...session, exchanges: [...session.exchanges, kept].slice(-CAP) });
    },
    async compact(userId, summarize, foldAt = foldTokens()) {
      const session = of(userId);
      const newest = [...session.exchanges].reverse();
      const kept = keepOf(newest, foldAt);
      if (kept === undefined) return false;
      const older = newest.slice(kept).reverse().flat();
      const summary = (await summarize(session.summary, older)).trim().slice(0, MAX_SUMMARY);
      store.set(userId, { summary: summary || session.summary, exchanges: session.exchanges.slice(-kept) });
      return true;
    },
    async clear(userId) {
      store.delete(userId);
    },
  };
};
