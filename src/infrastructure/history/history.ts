import { redis } from "bun";
import { logger } from "../../shared/logging/logger";

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

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
  append(userId: string, ...messages: HistoryMessage[]): Promise<void>;
  /** Once FOLD_AT exchanges pile up, folds all but the last KEEP into the summary. True when it folded. */
  compact(userId: string, summarize: Summarize): Promise<boolean>;
  clear(userId: string): Promise<void>;
}

/** Exchanges kept verbatim after a fold. */
export const KEEP_EXCHANGES = 8;
/** Exchanges that trigger a fold; between the two the model sees them all, so a fold runs every few questions. */
export const FOLD_AT_EXCHANGES = 12;
export const SESSION_TTL_SECONDS = Number(process.env.CHAT_TTL_SECONDS || 24 * 3600);
/** A server's thread of public questions is a passing talk, so it lives shorter than a player's session. */
export const PUBLIC_TTL_SECONDS = Number(process.env.PUBLIC_CHAT_TTL_SECONDS || 2 * 3600);
/** An automation agent's own thread: its wakes and its notes to itself, for as long as a task could run. */
export const TASK_TTL_SECONDS = Number(process.env.TASK_CHAT_TTL_SECONDS || 2 * 3600);
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
  if (thread.startsWith(TASK_PREFIX)) return TASK_TTL_SECONDS;
  return thread.startsWith(PUBLIC_PREFIX) ? PUBLIC_TTL_SECONDS : SESSION_TTL_SECONDS;
};
const KEEP = KEEP_EXCHANGES * 2;
const FOLD_AT = FOLD_AT_EXCHANGES * 2;
// If folding keeps failing, the oldest messages simply fall off here.
const CAP = FOLD_AT + 16;
const MAX_CONTENT = 4000;
export const MAX_SUMMARY = 1500;

const key = (userId: string) => `chat_history:${userId}`;
const summaryKey = (userId: string) => `chat_summary:${userId}`;

const parse = (raw: string): HistoryMessage | undefined => {
  try {
    const value = JSON.parse(raw);
    if ((value.role === "user" || value.role === "assistant") && typeof value.content === "string") {
      return { role: value.role, content: value.content };
    }
  } catch {
    // A broken entry is skipped; the rest of the history still helps.
  }
  return undefined;
};

const entries = (messages: HistoryMessage[]) =>
  messages
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_CONTENT) }))
    .filter((m) => m.content)
    .map((m) => JSON.stringify({ id: crypto.randomUUID(), ...m }));

/** Newest first in a Redis list (the v1 layout), the summary next to it; both expire together. */
export const redisHistory: HistoryStore = {
  async load(userId) {
    try {
      const [raw, summary] = await Promise.all([
        redis.send("LRANGE", [key(userId), "0", String(FOLD_AT - 1)]) as Promise<string[]>,
        redis.get(summaryKey(userId)),
      ]);
      const messages = (raw ?? []).map(parse).filter((m): m is HistoryMessage => !!m).reverse();
      return { messages, ...(summary ? { summary } : {}) };
    } catch (error) {
      // History is a nicety: answer without it rather than fail the question.
      logger.warn(`History unavailable for ${userId}: ${String(error)}`);
      return { messages: [] };
    }
  },
  async append(userId, ...messages) {
    const values = entries(messages);
    if (values.length === 0) return;
    try {
      await redis.send("LPUSH", [key(userId), ...values]);
      await redis.send("LTRIM", [key(userId), "0", String(CAP - 1)]);
      await redis.expire(key(userId), ttlOf(userId));
      await redis.expire(summaryKey(userId), ttlOf(userId));
    } catch (error) {
      logger.warn(`Couldn't save history for ${userId}: ${String(error)}`);
    }
  },
  async compact(userId, summarize) {
    if (Number(await redis.send("LLEN", [key(userId)])) <= FOLD_AT) return false;
    const raw = (await redis.send("LRANGE", [key(userId), String(KEEP), "-1"])) as string[];
    const older = raw.map(parse).filter((m): m is HistoryMessage => !!m).reverse();
    const summary = (await summarize((await redis.get(summaryKey(userId))) ?? undefined, older)).trim().slice(0, MAX_SUMMARY);
    if (summary) await redis.set(summaryKey(userId), summary, "EX", ttlOf(userId));
    await redis.send("LTRIM", [key(userId), "0", String(KEEP - 1)]);
    return true;
  },
  async clear(userId) {
    await redis.del(key(userId), summaryKey(userId));
  },
};

/** For tests and local runs without Redis; same windows, no expiry. */
export const memoryHistory = (): HistoryStore => {
  const store = new Map<string, Session>();
  const of = (userId: string): Session => store.get(userId) ?? { messages: [] };
  return {
    async load(userId) {
      const session = of(userId);
      return { ...session, messages: session.messages.slice(-FOLD_AT) };
    },
    async append(userId, ...messages) {
      const session = of(userId);
      store.set(userId, { ...session, messages: [...session.messages, ...messages].slice(-CAP) });
    },
    async compact(userId, summarize) {
      const session = of(userId);
      if (session.messages.length <= FOLD_AT) return false;
      const older = session.messages.slice(0, -KEEP);
      const summary = (await summarize(session.summary, older)).trim().slice(0, MAX_SUMMARY);
      store.set(userId, { summary: summary || session.summary, messages: session.messages.slice(-KEEP) });
      return true;
    },
    async clear(userId) {
      store.delete(userId);
    },
  };
};
