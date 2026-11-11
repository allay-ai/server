import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { localIso } from "../../agent/time";
import { CHAT_HISTORY_HOURS } from "../../entities/chatline/chatline.model";
import type { ChatHistoryStore, ChatLine } from "../../infrastructure/chathistory/chathistory";
import { logger } from "../../shared/logging/logger";
import { type Emit, type Summary, summaryFields } from "../chat/chat.events";
import { forModel } from "./schema";

/** Lines a call returns unless the model asks for more, and at most. */
export const CHAT_LINES = 20;
export const MAX_CHAT_LINES = 100;
/** Lines the store opens at once; a search reads more chunks only when it needs them. */
export const CHAT_CHUNK = 5000;
/** The most one answer reads: a very busy server's three days. */
export const CHAT_MOST = 50_000;
/** Players a count lists. */
const TOP = 25;

const CODES = /[§&][0-9a-fk-orx]/gi;
const MARKS = /\p{M}/gu;
/** What a match ignores: case, colors, accents, ё and е. */
export const folded = (text: string) => text.replace(CODES, "").normalize("NFKD").replace(MARKS, "").toLowerCase().replaceAll("ё", "е");

/** How often [words] occur in [text], already folded. */
const hits = (text: string, words: string[]) => {
  let count = 0;
  for (const word of words) for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + word.length)) count++;
  return count;
};

export interface ChatHistoryOptions {
  emit: Emit;
  tenant: string;
  serverId: string;
  /** The asking player's UUID: they read only the public chat and what they saw or wrote themselves. */
  viewer: string;
  timezone?: string;
  /** A public answer reads only what everyone read. */
  publicOnly?: boolean;
}

/** One line as the model reads it: when, who to whom, where, and the text with the chat's colors as & codes. */
const shown = (line: ChatLine, timezone: string | undefined, now: number) => ({
  at: localIso(new Date(line.at), timezone),
  minutes_ago: Math.max(0, Math.round((now - line.at) / 60_000)),
  from: line.from.name,
  ...(line.to ? { to: line.to.name } : {}),
  ...(line.channel === "public" ? {} : { channel: line.channel }),
  text: line.text.replaceAll("§", "&"),
});

/**
 * What one answer has read of the chat, newest first, in chunks as a call needs them: the model may search, page, and
 * count a dozen times in an answer, and the store opens each line only once.
 */
class Reader {
  /** Newest first. */
  readonly lines: ChatLine[] = [];
  private done = false;

  constructor(
    private readonly store: ChatHistoryStore,
    private readonly options: ChatHistoryOptions,
  ) {}

  /** Reads the next chunk while older lines than [since] may wait; false when there's nothing more to read. */
  async more(since: number): Promise<boolean> {
    const oldest = this.lines[this.lines.length - 1]?.at;
    if (this.done || (oldest !== undefined && oldest < since) || this.lines.length >= CHAT_MOST) return false;
    const chunk = await this.store.read(this.options.tenant, this.options.serverId, this.options.viewer, { since, before: oldest, publicOnly: this.options.publicOnly, scan: CHAT_CHUNK });
    this.lines.push(...chunk);
    if (chunk.length < CHAT_CHUNK) this.done = true;
    return chunk.length > 0;
  }

  /** Whether lines older than what's read may still be there. */
  get capped() {
    return !this.done;
  }
}

/**
 * `chat_history` (since 6.34): what was said in this server's chat over the last CHAT_HISTORY_HOURS. It pages through
 * the chat, searches it, shows the talk around a line, and counts by player, for “what did he write?”, “translate
 * that”, “who swore the most?”, or “is his offer a scam?”. Offered when the plugin keeps the chat (its tools say
 * `chat_history`); the store keeps every reader to their own view of it.
 */
export const chatHistoryTool = (store: ChatHistoryStore, options: ChatHistoryOptions) => {
  const reader = new Reader(store, options);
  return createTool({
    id: "chat_history",
    description: `This server's chat over the last ${CHAT_HISTORY_HOURS} hours, as the asker may read it: the public chat, local lines (channel local) they saw, and their own private messages (channel private, with to), never anyone else's. Each line: at (the player's local time), minutes_ago, from, to, channel, and text with the chat's colors as & codes. Call it when the player refers to the chat: “what did he write?”, «переведи, что он сказал», “what were they talking about?”, “did anyone answer me?”, “who swore the most?”, “is this player aggressive?”, “is his offer a scam?”, or wants to answer someone. Without filters it returns the newest lines; older_than from a result pages back, as far as the chat goes. player keeps lines from or to a player (a part of the name). query keeps lines with any of the words (all with match all), ignoring case, colors, and accents, inside words too: put every form, spelling, translation, and slang variant you'd expect, since the chat is in any language («мат», insults, “scam”, «кидалово»). around (an at from a result) shows the talk around that line, for judging a line in its context. count_by player counts the matching lines and query words per player over the whole window instead of listing them: “who swore the most and how often” is query with the swear words you know in the players' languages plus count_by player. Judge tone and intent from the lines yourself, quote what you base it on, and say it's your reading.`,
    inputSchema: forModel(
      z.object({
        player: z.string().min(1).max(32).optional().describe("Only lines from or to this player"),
        query: z.array(z.string().min(1).max(64)).max(40).optional().describe("Lines with any of these words or parts of words, in every language and form: [\"diamond\", \"алмаз\", \"dia\"]"),
        match: z.enum(["any", "all"]).optional().describe("any by default"),
        channel: z.enum(["public", "local", "private", "all"]).optional().describe("all by default"),
        minutes: z.number().int().min(1).max(CHAT_HISTORY_HOURS * 60).optional().describe(`How far back; all ${CHAT_HISTORY_HOURS} hours by default`),
        limit: z.number().int().min(1).max(MAX_CHAT_LINES).optional().describe(`Lines; ${CHAT_LINES} by default`),
        older_than: z.number().int().positive().optional().describe("From a previous result, for the page before it"),
        around: z.string().max(40).optional().describe("A line's at: the lines before and after it, filters aside from channel"),
        count_by: z.enum(["player"]).optional().describe("Count per player instead of listing lines"),
      }),
    ),
    strict: false,
    execute: async ({ player, query, match, channel, minutes, limit, older_than, around, count_by }) => {
      const callId = crypto.randomUUID();
      const status = (state: "started" | "finished" | "failed", summary?: Summary) =>
        options.emit({ event: "tool_status", data: { call_id: callId, name: "chat_history", kind: "server", state, args: { ...(player ? { player } : {}), ...(query?.length ? { query: query.join(", ") } : {}) }, ...summaryFields(summary) } });
      status("started");
      const now = Date.now();
      const most = limit ?? CHAT_LINES;
      try {
        const since = minutes ? now - minutes * 60_000 : 0;
        const inChannel = (line: ChatLine) => !channel || channel === "all" || line.channel === channel;
        const who = player ? folded(player) : undefined;
        const words = [...new Set((query ?? []).map(folded).map((word) => word.trim()).filter(Boolean))];
        const matches = (text: string) => !words.length || (match === "all" ? words.every((word) => text.includes(word)) : words.some((word) => text.includes(word)));
        const fits = (line: ChatLine) =>
          line.at >= since &&
          inChannel(line) &&
          (!older_than || line.at < older_than) &&
          (!who || folded(line.from.name).includes(who) || (!!line.to && folded(line.to.name).includes(who))) &&
          matches(folded(line.text));
        const at = around ? Date.parse(around) : undefined;
        if (at !== undefined && Number.isNaN(at)) return { error: "around takes a line's at from a result" };
        // A page needs one line more than it shows, to know there are older ones; a count and the talk around a line need their whole stretch.
        const enough = () =>
          count_by ? false
          : at !== undefined ? reader.lines.filter((line) => line.at < at && inChannel(line)).length >= most
          : reader.lines.filter(fits).length > most;
        while (!enough() && (await reader.more(since)));
        const lines = reader.lines.filter((line) => line.at >= since);
        if (at !== undefined) {
          const near = lines.filter(inChannel);
          if (!near.length) return { lines: [] };
          // Newest first: the line nearest that moment, what led to it (the bigger half), and what came after.
          const center = near.reduce((best, line, k) => (Math.abs(line.at - at) < Math.abs(near[best]!.at - at) ? k : best), 0);
          const page = near.slice(Math.max(0, center - Math.floor((most - 1) / 2)), center + 1 + Math.ceil((most - 1) / 2));
          status("finished", { text: `${page.length} lines`, key: "chat_lines", values: { count: page.length } });
          return { lines: page.map((line) => shown(line, options.timezone, now)).reverse() };
        }
        const found = lines.filter(fits);
        const reach = { searched_lines: lines.length, ...(reader.capped && !minutes ? { note: "The chat goes further back than one answer reads; narrow it with minutes or player." } : {}) };
        if (count_by) {
          const counts = new Map<string, { lines: number; hits: number }>();
          for (const line of found) {
            const count = counts.get(line.from.name) ?? { lines: 0, hits: 0 };
            count.lines++;
            count.hits += words.length ? hits(folded(line.text), words) : 1;
            counts.set(line.from.name, count);
          }
          const players = [...counts.entries()].map(([name, count]) => ({ player: name, ...count })).sort((a, b) => b.hits - a.hits || b.lines - a.lines);
          status("finished", { text: `${found.length} lines`, key: "chat_lines", values: { count: found.length } });
          return { matching_lines: found.length, players: players.slice(0, TOP), ...(players.length > TOP ? { more_players: players.length - TOP } : {}), ...reach };
        }
        // Newest first from the store; the model reads a talk the way it went.
        const page = found.slice(0, most);
        status("finished", { text: `${page.length} lines`, key: "chat_lines", values: { count: page.length } });
        return {
          lines: page.map((line) => shown(line, options.timezone, now)).reverse(),
          ...(found.length > most ? { older_than: page[page.length - 1]!.at, matching_lines: found.length } : {}),
          ...reach,
          ...(options.publicOnly ? { visibility: "A public answer reads only the public chat." } : {}),
        };
      } catch (error) {
        logger.warn(`Chat history unavailable: ${String(error)}`);
        status("failed", { text: "chat history unavailable", key: "chat_unavailable" });
        return { error: "The chat history is out of reach right now; say so in a line." };
      }
    },
  });
};
