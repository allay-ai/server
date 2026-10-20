import type { ModelMessage } from "ai";
import { redis } from "bun";
import { settings } from "../../features/settings/settings";
import { logger } from "../../shared/logging/logger";
import type { Owner } from "../../shared/types/owner";

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

const key = (thread: Thread) => `chat_history:${thread.key}`;
const summaryKey = (thread: Thread) => `chat_summary:${thread.key}`;
const outcomesKey = (owner: Owner) => `task_outcomes:${privateThread(owner).key}`;
/** A player who starts task after task and never asks keeps only the latest outcomes. */
const MAX_OUTCOMES = 10;

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

/** Every key matching a pattern; SCAN, so a large Redis never blocks. */
const scan = async (pattern: string): Promise<string[]> => {
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = (await redis.send("SCAN", [cursor, "MATCH", pattern, "COUNT", "500"])) as [string, string[]];
    found.push(...keys);
    cursor = next;
  } while (cursor !== "0");
  return found;
};

const loadRedis = async (thread: Thread): Promise<Session> => {
  const [raw, summary] = await Promise.all([
    redis.send("LRANGE", [key(thread), "0", String(CAP - 1)]) as Promise<string[]>,
    redis.get(summaryKey(thread)),
  ]);
  return { messages: exchangesOf(raw ?? []).reverse().flat(), ...(summary ? { summary } : {}) };
};

/** Newest exchange first in a Redis list, the summary next to it; both expire together. */
export const redisHistory: HistoryStore = {
  async load(thread) {
    try {
      return await loadRedis(thread);
    } catch (error) {
      // History is a nicety: answer without it rather than fail the question.
      logger.warn(`History unavailable: ${String(error)}`);
      return { messages: [] };
    }
  },
  async append(thread, ...messages) {
    const kept = entry(messages);
    if (kept.length === 0) return;
    try {
      await redis.send("LPUSH", [key(thread), JSON.stringify({ id: crypto.randomUUID(), messages: kept })]);
      await redis.send("LTRIM", [key(thread), "0", String(CAP - 1)]);
      await redis.expire(key(thread), ttlOf(thread));
      await redis.expire(summaryKey(thread), ttlOf(thread));
    } catch (error) {
      logger.warn(`Couldn't save history: ${String(error)}`);
    }
  },
  async compact(thread, summarize, foldAt = foldTokens()) {
    const raw = (await redis.send("LRANGE", [key(thread), "0", "-1"])) as string[];
    const exchanges = exchangesOf(raw);
    const kept = keepOf(exchanges, foldAt);
    if (kept === undefined) return false;
    const older = exchanges.slice(kept).reverse().flat();
    const summary = (await summarize((await redis.get(summaryKey(thread))) ?? undefined, older)).trim().slice(0, MAX_SUMMARY);
    if (summary) await redis.set(summaryKey(thread), summary, "EX", ttlOf(thread));
    // Exchanges appended while the summary was written sit at the head, so they stay too.
    const added = Number(await redis.send("LLEN", [key(thread)])) - raw.length;
    await redis.send("LTRIM", [key(thread), "0", String(kept + Math.max(added, 0) - 1)]);
    return true;
  },
  async clear(owner) {
    const thread = privateThread(owner);
    await redis.del(key(thread), summaryKey(thread), outcomesKey(owner));
  },
  async noteOutcome(owner, outcome) {
    try {
      await redis.send("RPUSH", [outcomesKey(owner), outcome]);
      await redis.send("LTRIM", [outcomesKey(owner), String(-MAX_OUTCOMES), "-1"]);
      await redis.expire(outcomesKey(owner), sessionTtl());
    } catch (error) {
      logger.warn(`Couldn't keep a task outcome: ${String(error)}`);
    }
  },
  async takeOutcomes(owner) {
    try {
      // One LPOP takes them all at once, so two questions at the same time can't both get them.
      return ((await redis.send("LPOP", [outcomesKey(owner), String(MAX_OUTCOMES)])) as string[] | null) ?? [];
    } catch (error) {
      logger.warn(`Task outcomes unavailable: ${String(error)}`);
      return [];
    }
  },
  async export(owner) {
    const prefix = `chat_history:${taskPrefix(owner)}`;
    const tasks: Record<string, Session> = {};
    for (const found of await scan(`${prefix}*`)) {
      const id = found.slice(prefix.length);
      tasks[id] = await loadRedis({ key: found.slice("chat_history:".length), kind: "task" });
    }
    const outcomes = ((await redis.send("LRANGE", [outcomesKey(owner), "0", "-1"])) as string[] | null) ?? [];
    return { session: await loadRedis(privateThread(owner)), outcomes, tasks };
  },
  async erase(owner) {
    const thread = privateThread(owner);
    const tasks = [...(await scan(`chat_history:${taskPrefix(owner)}*`)), ...(await scan(`chat_summary:${taskPrefix(owner)}*`))];
    await redis.del(key(thread), summaryKey(thread), outcomesKey(owner), ...tasks);
  },
};

/** Keys from before 6.0 carry no tenant, so nobody can be sure whose they are: they go on start. They'd expire within a day anyway. */
export const dropLegacySessions = async (): Promise<number> => {
  let dropped = 0;
  for (const prefix of ["chat_history:", "chat_summary:", "task_outcomes:"]) {
    const legacy = (await scan(`${prefix}*`)).filter((found) => {
      const rest = found.slice(prefix.length);
      return !rest.startsWith("self:") && !rest.startsWith("license:");
    });
    for (let i = 0; i < legacy.length; i += 500) {
      await redis.del(...legacy.slice(i, i + 500));
      dropped += legacy.slice(i, i + 500).length;
    }
  }
  return dropped;
};

/** For tests and local runs without Redis; same windows, no expiry. */
export const memoryHistory = (): HistoryStore & { keys: () => string[] } => {
  const store = new Map<string, { summary?: string; exchanges: HistoryMessage[][] }>();
  const outcomes = new Map<string, string[]>();
  const of = (thread: Thread) => store.get(thread.key) ?? { exchanges: [] };
  const load = (thread: Thread): Session => {
    const session = of(thread);
    return { ...(session.summary ? { summary: session.summary } : {}), messages: session.exchanges.flat() };
  };
  return {
    keys: () => [...store.keys(), ...[...outcomes.keys()].map((k) => `outcomes:${k}`)],
    async load(thread) {
      return load(thread);
    },
    async append(thread, ...messages) {
      const kept = entry(messages);
      if (kept.length === 0) return;
      const session = of(thread);
      store.set(thread.key, { ...session, exchanges: [...session.exchanges, kept].slice(-CAP) });
    },
    async compact(thread, summarize, foldAt = foldTokens()) {
      const session = of(thread);
      const newest = [...session.exchanges].reverse();
      const kept = keepOf(newest, foldAt);
      if (kept === undefined) return false;
      const older = newest.slice(kept).reverse().flat();
      const summary = (await summarize(session.summary, older)).trim().slice(0, MAX_SUMMARY);
      store.set(thread.key, { summary: summary || session.summary, exchanges: session.exchanges.slice(-kept) });
      return true;
    },
    async clear(owner) {
      store.delete(privateThread(owner).key);
      outcomes.delete(privateThread(owner).key);
    },
    async noteOutcome(owner, outcome) {
      const at = privateThread(owner).key;
      outcomes.set(at, [...(outcomes.get(at) ?? []), outcome].slice(-MAX_OUTCOMES));
    },
    async takeOutcomes(owner) {
      const at = privateThread(owner).key;
      const taken = outcomes.get(at) ?? [];
      outcomes.delete(at);
      return taken;
    },
    async export(owner) {
      const tasks: Record<string, Session> = {};
      for (const at of store.keys()) {
        if (at.startsWith(taskPrefix(owner))) tasks[at.slice(taskPrefix(owner).length)] = load({ key: at, kind: "task" });
      }
      return { session: load(privateThread(owner)), outcomes: [...(outcomes.get(privateThread(owner).key) ?? [])], tasks };
    },
    async erase(owner) {
      for (const at of [...store.keys()]) if (at.startsWith(taskPrefix(owner))) store.delete(at);
      store.delete(privateThread(owner).key);
      outcomes.delete(privateThread(owner).key);
    },
  };
};
