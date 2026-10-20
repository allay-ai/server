import { MemoryModel } from "../../entities/memory/memory.model";
import type { Owner } from "../../shared/types/owner";

export interface Memory {
  id: string;
  text: string;
  created_at: string;
}

/**
 * Lasting facts per player and tenant. Unlike the chat session they outlive a day: the player clears them, and they
 * go by themselves once the player hasn't asked for MEMORY_DAYS.
 */
export interface MemoryStore {
  /** Oldest first. */
  list(owner: Owner): Promise<Memory[]>;
  /** The saved memory, or "full" when the player already has MAX_MEMORIES. */
  add(owner: Owner, text: string): Promise<Memory | "full">;
  remove(owner: Owner, id: string): Promise<boolean>;
  clear(owner: Owner): Promise<number>;
  /** The player just asked: their memories live another MEMORY_DAYS. */
  touch(owner: Owner): Promise<void>;
  /** The ids of every player with memories on [tenant]. */
  users(tenant: string): Promise<string[]>;
}

export const MAX_MEMORIES = 30;
export const MAX_MEMORY_CHARS = 200;

// Five characters are short enough to read in chat and plenty for 30 facts.
const shortId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 5);

const clean = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_CHARS);

const query = (owner: Owner) => ({ tenant: owner.tenant, user_id: owner.userId });

export const mongoMemories: MemoryStore = {
  async list(owner) {
    const docs = await MemoryModel.find(query(owner)).sort({ created_at: 1 }).limit(MAX_MEMORIES).lean();
    return docs.map((doc) => ({ id: doc.id, text: doc.text, created_at: doc.created_at.toISOString() }));
  },
  async add(owner, text) {
    if ((await MemoryModel.countDocuments(query(owner))) >= MAX_MEMORIES) return "full";
    const doc = await MemoryModel.create({ id: shortId(), ...query(owner), text: clean(text) });
    return { id: doc.id, text: doc.text, created_at: doc.created_at.toISOString() };
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
    async add(owner, text) {
      if (of(owner).length >= MAX_MEMORIES) return "full";
      const memory = { id: shortId(), text: clean(text), created_at: new Date().toISOString() };
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
