import { type MemoryDocument, MemoryModel, type Place } from "../../entities/memory/memory.model";
import { settings } from "../../features/settings/settings";
import type { Owner } from "../../shared/types/owner";
import { openJson, sealJson } from "../crypto/data";

export type { Place };

export interface Memory {
  id: string;
  text: string;
  /** Since 6.9: a memory tied to a place, what the plugin's notebook held before. */
  place?: Place;
  created_at: string;
}

/**
 * Lasting facts and places per player and tenant, sealed. Unlike the chat session they outlive a month: the player
 * clears them, and they go by themselves once the player hasn't asked for MEMORY_DAYS.
 */
export interface MemoryStore {
  /** Oldest first. */
  list(owner: Owner): Promise<Memory[]>;
  /** The saved memory, or "full" when the player already has MEMORY_MAX. */
  add(owner: Owner, text: string, place?: Place): Promise<Memory | "full">;
  remove(owner: Owner, id: string): Promise<boolean>;
  clear(owner: Owner): Promise<number>;
  /** The player just asked: their memories live another MEMORY_DAYS. */
  touch(owner: Owner): Promise<void>;
  /** The ids of every player with memories on [tenant]. */
  users(tenant: string): Promise<string[]>;
}

/** How many memories a player may keep, places included; the notebook held up to 200 before 6.9. */
export const maxMemories = () => settings.get("MEMORY_MAX");
export const MAX_MEMORY_CHARS = 200;
/** The prompt lists this many facts without a place; places and older facts come through the memories tool. */
export const PROMPT_MEMORIES = 30;

// Five characters are short enough to read in chat and plenty for a few hundred.
const shortId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 5);

const clean = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_CHARS);

const query = (owner: Owner) => ({ tenant: owner.tenant, user_id: owner.userId });

const memoryOf = (doc: Pick<MemoryDocument, "id" | "sealed" | "text" | "created_at">): Memory | undefined => {
  const content = doc.sealed ? openJson<{ text: string; place?: Place }>(doc.sealed) : doc.text !== undefined ? { text: doc.text } : undefined;
  if (!content) return undefined;
  return { id: doc.id, text: content.text, ...(content.place ? { place: content.place } : {}), created_at: doc.created_at.toISOString() };
};

export const mongoMemories: MemoryStore = {
  async list(owner) {
    const docs = await MemoryModel.find(query(owner)).sort({ created_at: 1 }).limit(maxMemories()).lean();
    return docs.map(memoryOf).filter((m): m is Memory => !!m);
  },
  async add(owner, text, place) {
    if ((await MemoryModel.countDocuments(query(owner))) >= maxMemories()) return "full";
    const content = { text: clean(text), ...(place ? { place } : {}) };
    const doc = await MemoryModel.create({ id: shortId(), ...query(owner), sealed: sealJson(content) });
    return { id: doc.id, ...content, created_at: doc.created_at.toISOString() };
  },
  async remove(owner, id) {
    return (await MemoryModel.deleteOne({ ...query(owner), id })).deletedCount > 0;
  },
  async clear(owner) {
    return (await MemoryModel.deleteMany(query(owner))).deletedCount;
  },
  async touch(owner) {
    await MemoryModel.updateMany(query(owner), { $set: { seen_at: new Date() } });
  },
  async users(tenant) {
    return MemoryModel.distinct("user_id", { tenant });
  },
};

/** For tests and local runs without MongoDB. */
export const memoryMemories = (): MemoryStore => {
  const store = new Map<string, Memory[]>();
  const at = (owner: Owner) => `${owner.tenant}\n${owner.userId}`;
  const of = (owner: Owner) => store.get(at(owner)) ?? [];
  return {
    async list(owner) {
      return [...of(owner)];
    },
    async add(owner, text, place) {
      if (of(owner).length >= maxMemories()) return "full";
      const memory = { id: shortId(), text: clean(text), ...(place ? { place } : {}), created_at: new Date().toISOString() };
      store.set(at(owner), [...of(owner), memory]);
      return memory;
    },
    async remove(owner, id) {
      const before = of(owner);
      store.set(at(owner), before.filter((m) => m.id !== id));
      return before.length !== of(owner).length;
    },
    async clear(owner) {
      const count = of(owner).length;
      store.delete(at(owner));
      return count;
    },
    async touch() {},
    async users(tenant) {
      return [...store.keys()].filter((key) => key.startsWith(`${tenant}\n`) && of({ tenant, userId: key.slice(tenant.length + 1) }).length).map((key) => key.slice(tenant.length + 1));
    },
  };
};
