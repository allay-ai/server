import { CHAT_HISTORY_HOURS, type ChatChannel, ChatLineModel } from "../../entities/chatline/chatline.model";
import type { Owner } from "../../shared/types/owner";
import { openJson, sealJson } from "../crypto/data";
import type { Pseudonyms } from "../privacy/pseudonyms";

export const CHAT_HISTORY_MS = CHAT_HISTORY_HOURS * 3_600_000;

/** A player as the chat named them. */
export interface ChatPerson {
  uuid: string;
  name: string;
}

/** A chat line as the plugin reports it. */
export interface ChatLine {
  /** Milliseconds since the epoch. */
  at: number;
  channel: ChatChannel;
  from: ChatPerson;
  /** Whom a private line went to. */
  to?: ChatPerson;
  /** Who else saw a local line, by UUID; the plugin knows them from the chat event. */
  audience?: string[];
  /** As the chat showed it, colors as § codes. */
  text: string;
}

/** What a line keeps sealed. */
interface SealedLine {
  from: ChatPerson;
  to?: ChatPerson;
  text: string;
}

export interface ReadOptions {
  /** Lines from this moment on, in milliseconds. */
  since: number;
  /** Lines before this moment, for the next page. */
  before?: number;
  /** Only what everyone read: a public answer mustn't carry anyone's private or local lines. */
  publicOnly?: boolean;
  /** How many of the newest lines to open at most; a search filters them after. */
  scan: number;
}

/**
 * The chat of each server of each tenant for CHAT_HISTORY_HOURS (since 6.34), for the chat_history tool. A reader gets
 * the public lines, the local ones they saw, and the private ones they wrote or got: never anyone else's.
 */
export interface ChatHistoryStore {
  /** A line already kept (the same sender at the same moment) is a no-op. Answers how many were new. */
  add(tenant: string, serverId: string, lines: ChatLine[]): Promise<number>;
  /** What [viewer] (a player's UUID) may read on the server, newest first. */
  read(tenant: string, serverId: string, viewer: string, options: ReadOptions): Promise<ChatLine[]>;
  /** What the player wrote on every server of the tenant, newest first, for their copy. */
  list(owner: Owner): Promise<ChatLine[]>;
  clear(owner: Owner): Promise<number>;
  /** Forgets a server's whole chat, as its admins ask (`/allay chat reset`); answers how many lines went. */
  reset(tenant: string, serverId: string): Promise<number>;
}

/** UUIDs come with and without dashes and in either case; a reader must match a sender either way. */
export const uuidKey = (uuid: string) => uuid.toLowerCase().replaceAll("-", "");

const audienceOf = (pseudonyms: Pseudonyms, tenant: string, line: ChatLine) => {
  if (line.channel === "public") return [];
  const others = line.channel === "private" ? (line.to ? [line.to.uuid] : []) : (line.audience ?? []);
  return [...new Set(others.map((uuid) => pseudonyms.of(tenant, uuidKey(uuid))))];
};

const fresh = (line: ChatLine, now: number) => line.at > now - CHAT_HISTORY_MS && line.at < now + 60_000;

const restored = (doc: { at: Date; channel: ChatChannel; sealed: unknown }): ChatLine | null => {
  const line = openJson<SealedLine>(doc.sealed);
  return line ? { at: doc.at.getTime(), channel: doc.channel, ...line } : null;
};

const visible = (me: string, publicOnly?: boolean): Record<string, unknown> =>
  publicOnly ? { channel: "public" } : { $or: [{ channel: "public" }, { from: me }, { audience: me }] };

export const mongoChatHistory = (pseudonyms: Pseudonyms): ChatHistoryStore => ({
  async add(tenant, serverId, lines) {
    const now = Date.now();
    const kept = lines.filter((line) => fresh(line, now));
    if (!kept.length) return 0;
    const result = await ChatLineModel.bulkWrite(
      kept.map((line) => {
        const at = new Date(line.at);
        const from = pseudonyms.of(tenant, uuidKey(line.from.uuid));
        const sealed: SealedLine = { from: line.from, ...(line.to ? { to: line.to } : {}), text: line.text };
        return {
          updateOne: {
            filter: { tenant, server_id: serverId, from, at },
            update: {
              $setOnInsert: {
                tenant, server_id: serverId, from, at, channel: line.channel, audience: audienceOf(pseudonyms, tenant, line),
                sealed: sealJson(sealed), expires_at: new Date(line.at + CHAT_HISTORY_MS),
              },
            },
            upsert: true,
          },
        };
      }),
      { ordered: false },
    );
    return result.upsertedCount;
  },
  async read(tenant, serverId, viewer, options) {
    const me = pseudonyms.of(tenant, uuidKey(viewer));
    const at = { $gte: new Date(Math.max(options.since, Date.now() - CHAT_HISTORY_MS)), ...(options.before ? { $lt: new Date(options.before) } : {}) };
    const filter: Record<string, unknown> = { tenant, server_id: serverId, at, ...visible(me, options.publicOnly) };
    const docs = await ChatLineModel.find(filter, { at: 1, channel: 1, sealed: 1 })
      .sort({ at: -1 })
      .limit(options.scan)
      .lean();
    return docs.map(restored).filter((line): line is ChatLine => !!line);
  },
  async list(owner) {
    const docs = await ChatLineModel.find({ tenant: owner.tenant, from: pseudonyms.of(owner.tenant, uuidKey(owner.userId)), expires_at: { $gt: new Date() } }, { at: 1, channel: 1, sealed: 1 })
      .sort({ at: -1 })
      .lean();
    return docs.map(restored).filter((line): line is ChatLine => !!line);
  },
  async clear(owner) {
    return (await ChatLineModel.deleteMany({ tenant: owner.tenant, from: pseudonyms.of(owner.tenant, uuidKey(owner.userId)) })).deletedCount;
  },
  async reset(tenant, serverId) {
    return (await ChatLineModel.deleteMany({ tenant, server_id: serverId })).deletedCount;
  },
});

/** For tests and local runs without MongoDB; the same rules over plain lines. */
export const memoryChatHistory = (): ChatHistoryStore => {
  const lines: Array<ChatLine & { tenant: string; server_id: string }> = [];
  const mine = (line: ChatLine, me: string) =>
    uuidKey(line.from.uuid) === me ||
    (line.channel === "private" ? !!line.to && uuidKey(line.to.uuid) === me : line.channel === "local" && (line.audience ?? []).some((uuid) => uuidKey(uuid) === me));
  const plain = ({ tenant: _tenant, server_id: _server, ...line }: ChatLine & { tenant: string; server_id: string }): ChatLine => line;
  return {
    async add(tenant, serverId, batch) {
      const now = Date.now();
      let added = 0;
      for (const line of batch) {
        if (!fresh(line, now)) continue;
        if (lines.some((l) => l.tenant === tenant && l.server_id === serverId && l.at === line.at && uuidKey(l.from.uuid) === uuidKey(line.from.uuid))) continue;
        lines.push({ ...line, tenant, server_id: serverId });
        added++;
      }
      return added;
    },
    async read(tenant, serverId, viewer, options) {
      const me = uuidKey(viewer);
      const since = Math.max(options.since, Date.now() - CHAT_HISTORY_MS);
      return lines
        .filter((l) => l.tenant === tenant && l.server_id === serverId && l.at >= since && (!options.before || l.at < options.before))
        .filter((l) => l.channel === "public" || (!options.publicOnly && mine(l, me)))
        .sort((a, b) => b.at - a.at)
        .slice(0, options.scan)
        .map(plain);
    },
    async list(owner) {
      return lines.filter((l) => l.tenant === owner.tenant && uuidKey(l.from.uuid) === uuidKey(owner.userId)).sort((a, b) => b.at - a.at).map(plain);
    },
    async clear(owner) {
      const before = lines.length;
      for (let k = lines.length - 1; k >= 0; k--) if (lines[k]!.tenant === owner.tenant && uuidKey(lines[k]!.from.uuid) === uuidKey(owner.userId)) lines.splice(k, 1);
      return before - lines.length;
    },
    async reset(tenant, serverId) {
      const before = lines.length;
      for (let k = lines.length - 1; k >= 0; k--) if (lines[k]!.tenant === tenant && lines[k]!.server_id === serverId) lines.splice(k, 1);
      return before - lines.length;
    },
  };
};
