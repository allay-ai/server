import { type MemoryDocument, MemoryModel, type Place } from "../../entities/memory/memory.model";
import { settings } from "../../features/settings/settings";
import type { Owner } from "../../shared/types/owner";
import { openJson, sealJson } from "../crypto/data";

export type { Place };

/** What a memory is about; a place is one with a place, whatever else it says. */
export const KINDS = ["fact", "preference", "goal", "place"] as const;
export type Kind = (typeof KINDS)[number];
/** What kind of place it is, for its icon in the window and for “my farms”. */
export const CATEGORIES = ["base", "farm", "storage", "portal", "villager", "mine", "structure", "build", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Memory {
  id: string;
  text: string;
  kind: Kind;
  /** Since 6.27: a few words the window shows instead of the text. */
  title?: string;
  /** Since 6.27: lower case, no #. */
  tags: string[];
  /** Since 6.27: always in the prompt and on top of the window. */
  pinned: boolean;
  /** Since 6.9: a memory tied to a place, what the plugin's notebook held before. */
  place?: Place;
  category?: Category;
  created_at: string;
  updated_at?: string;
}

/** What a new memory says; kind follows from the place when left out. */
export interface Draft {
  text: string;
  kind?: Kind;
  title?: string;
  tags?: string[];
  pinned?: boolean;
  place?: Place;
  category?: Category;
}

/** A change to a memory: what's given replaces what was; a null place or title removes it. */
export type Patch = Partial<Omit<Draft, "place" | "title">> & { place?: Place | null; title?: string | null };

/**
 * Lasting facts and places per player and tenant, sealed. Unlike the chat session they outlive a month: the player
 * clears them, and they go by themselves once the player hasn't asked for MEMORY_DAYS.
 */
export interface MemoryStore {
  /** Oldest first. */
  list(owner: Owner): Promise<Memory[]>;
  /** The saved memory, "full" when the player already has MEMORY_MAX, or "pins" when MAX_PINNED are pinned. */
  add(owner: Owner, draft: Draft): Promise<Memory | "full" | "pins">;
  /** The changed memory, undefined when there's none with that id, or "pins" as for add. */
  update(owner: Owner, id: string, patch: Patch): Promise<Memory | "pins" | undefined>;
  remove(owner: Owner, id: string): Promise<boolean>;
  clear(owner: Owner): Promise<number>;
  /** The player just asked: their memories live another MEMORY_DAYS. */
  touch(owner: Owner): Promise<void>;
  /** The ids of every player with memories on [tenant]. */
  users(tenant: string): Promise<string[]>;
}

/** How many memories a player may keep, places included; the notebook held up to 200 before 6.9. */
export const maxMemories = () => settings.get("MEMORY_MAX");
/** 200 before 6.27: a place's note or a plan the player keeps needs more. */
export const MAX_MEMORY_CHARS = 500;
export const MAX_TITLE_CHARS = 40;
export const MAX_TAGS = 5;
export const MAX_TAG_CHARS = 24;
/** Pinned memories all go into every prompt, so they stay few. */
export const MAX_PINNED = 20;
/** The prompt lists this many facts without a place; places and older facts come through the memories tool. */
export const PROMPT_MEMORIES = 30;

// Five characters are short enough to read in chat and plenty for a few hundred.
const shortId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 5);

const clean = (text: string, most = MAX_MEMORY_CHARS) => text.replace(/\s+/g, " ").trim().slice(0, most);

/** «#Ферма», "iron farm" and "iron-farm" are one tag: lower case, words joined by a dash. */
export const tagsOf = (tags: string[] | undefined) =>
  [...new Set((tags ?? []).map((tag) => clean(tag.replace(/^#+/, ""), MAX_TAG_CHARS).toLowerCase().replace(/ /g, "-")).filter(Boolean))].slice(0, MAX_TAGS);

/** What the sealed part holds. */
interface Content {
  text: string;
  place?: Place;
  kind?: Kind;
  title?: string;
  tags?: string[];
  pinned?: boolean;
  category?: Category;
}

const contentOf = (draft: Draft): Content => {
  const title = draft.title ? clean(draft.title, MAX_TITLE_CHARS) : "";
  const tags = tagsOf(draft.tags);
  return {
    text: clean(draft.text),
    ...(draft.place ? { place: draft.place } : {}),
    kind: draft.place ? "place" : draft.kind && draft.kind !== "place" ? draft.kind : "fact",
    ...(title ? { title } : {}),
    ...(tags.length ? { tags } : {}),
    ...(draft.pinned ? { pinned: true } : {}),
    ...(draft.place && draft.category ? { category: draft.category } : {}),
  };
};

/** The draft a memory came from, with [patch] laid over it. */
const patched = (memory: Memory, patch: Patch): Draft => {
  const place = patch.place === null ? undefined : (patch.place ?? memory.place);
  const title = patch.title === null ? undefined : (patch.title ?? memory.title);
  return {
    text: patch.text ?? memory.text,
    kind: patch.kind ?? (memory.kind === "place" && !place ? "fact" : memory.kind),
    ...(title ? { title } : {}),
    tags: patch.tags ?? memory.tags,
    pinned: patch.pinned ?? memory.pinned,
    ...(place ? { place } : {}),
    ...((patch.category ?? memory.category) ? { category: patch.category ?? memory.category } : {}),
  };
};

const memoryOf = (doc: Pick<MemoryDocument, "id" | "sealed" | "text" | "created_at" | "updated_at">): Memory | undefined => {
  const content = doc.sealed ? openJson<Content>(doc.sealed) : doc.text !== undefined ? { text: doc.text } : undefined;
  if (!content) return undefined;
  return {
    id: doc.id,
    text: content.text,
    // Memories from before 6.27 have no kind: a place is one, everything else a fact.
    kind: content.kind ?? (content.place ? "place" : "fact"),
    ...(content.title ? { title: content.title } : {}),
    tags: content.tags ?? [],
    pinned: content.pinned ?? false,
    ...(content.place ? { place: content.place } : {}),
    ...(content.category ? { category: content.category } : {}),
    created_at: doc.created_at.toISOString(),
    ...(doc.updated_at ? { updated_at: doc.updated_at.toISOString() } : {}),
  };
};

/** Whether pinning [content] would pass MAX_PINNED, among [others]. */
const overPinned = (content: Content, others: Memory[]) => !!content.pinned && others.filter((m) => m.pinned).length >= MAX_PINNED;

const query = (owner: Owner) => ({ tenant: owner.tenant, user_id: owner.userId });

export const mongoMemories: MemoryStore = {
  async list(owner) {
    const docs = await MemoryModel.find(query(owner)).sort({ created_at: 1 }).limit(maxMemories()).lean();
    return docs.map(memoryOf).filter((m): m is Memory => !!m);
  },
  async add(owner, draft) {
    if ((await MemoryModel.countDocuments(query(owner))) >= maxMemories()) return "full";
    const content = contentOf(draft);
    if (content.pinned && overPinned(content, await this.list(owner))) return "pins";
    const doc = await MemoryModel.create({ id: shortId(), ...query(owner), sealed: sealJson(content) });
    return memoryOf(doc)!;
  },
  async update(owner, id, patch) {
    const all = await this.list(owner);
    const memory = all.find((m) => m.id === id);
    if (!memory) return undefined;
    const content = contentOf(patched(memory, patch));
    if (content.pinned && !memory.pinned && overPinned(content, all)) return "pins";
    const doc = await MemoryModel.findOneAndUpdate({ ...query(owner), id }, { $set: { sealed: sealJson(content), updated_at: new Date() }, $unset: { text: 1 } }, { new: true }).lean();
    return doc ? memoryOf(doc) : undefined;
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
  const made = (id: string, content: Content, created_at: string, updated_at?: string) =>
    memoryOf({ id, sealed: sealJson(content), created_at: new Date(created_at), ...(updated_at ? { updated_at: new Date(updated_at) } : {}) })!;
  return {
    async list(owner) {
      return [...of(owner)];
    },
    async add(owner, draft) {
      if (of(owner).length >= maxMemories()) return "full";
      const content = contentOf(draft);
      if (overPinned(content, of(owner))) return "pins";
      const memory = made(shortId(), content, new Date().toISOString());
      store.set(at(owner), [...of(owner), memory]);
      return memory;
    },
    async update(owner, id, patch) {
      const memory = of(owner).find((m) => m.id === id);
      if (!memory) return undefined;
      const content = contentOf(patched(memory, patch));
      if (content.pinned && !memory.pinned && overPinned(content, of(owner))) return "pins";
      const changed = made(id, content, memory.created_at, new Date().toISOString());
      store.set(at(owner), of(owner).map((m) => (m.id === id ? changed : m)));
      return changed;
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
