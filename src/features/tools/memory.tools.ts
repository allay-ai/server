import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { forModel } from "./schema";
import { DIMENSIONS, type Position } from "../../agent/agent.types";
import {
  CATEGORIES,
  MAX_MEMORY_CHARS,
  MAX_PINNED,
  MAX_TAG_CHARS,
  MAX_TAGS,
  MAX_TITLE_CHARS,
  type Memory,
  type MemoryStore,
  type Patch,
  type Place,
  maxMemories,
  tagsOf,
} from "../../infrastructure/memory/memory";
import { bearing } from "../../shared/lib/compass";
import type { Owner } from "../../shared/types/owner";
import { logger } from "../../shared/logging/logger";
import { type Emit, type Summary, summaryFields } from "../chat/chat.events";

const FIND_LIMIT = 20;
/** A place's radius at most: a base, a town, a claim. */
const MAX_RADIUS = 256;
/** What the index shows of a memory without a title. */
const INDEX_CHARS = 60;

/** A memory as the model reads it: the place spelled out, with distance and direction from where the player stands. */
export const shown = (memory: Memory, position?: Position) => {
  const way = memory.place ? bearing(position, memory.place) : undefined;
  return {
    id: memory.id,
    kind: memory.kind,
    ...(memory.title ? { title: memory.title } : {}),
    text: memory.text,
    ...(memory.tags.length ? { tags: memory.tags } : {}),
    ...(memory.pinned ? { pinned: true } : {}),
    ...(memory.category ? { category: memory.category } : {}),
    ...(memory.place ? { ...memory.place, ...way, ...(way && memory.place.radius && way.distance <= memory.place.radius ? { inside: true } : {}) } : {}),
    created_at: memory.created_at.slice(0, 10),
    ...(memory.updated_at ? { updated_at: memory.updated_at.slice(0, 10) } : {}),
  };
};

/** One line of the index: enough to match by meaning and pick an id. */
const indexed = (memory: Memory) => ({
  id: memory.id,
  kind: memory.kind,
  about: memory.title ?? (memory.text.length > INDEX_CHARS ? `${memory.text.slice(0, INDEX_CHARS - 1)}…` : memory.text),
  ...(memory.tags.length ? { tags: memory.tags } : {}),
  ...(memory.pinned ? { pinned: true } : {}),
});

/** Memories whose words meet the query's, in the text, the title, or the tags. */
const matching = (memories: Memory[], query?: string) => {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  if (!words.length) return memories;
  return memories.filter((m) => {
    const haystack = [m.text, m.title ?? "", ...m.tags, m.category ?? ""].join(" ").toLowerCase();
    return words.some((w) => haystack.includes(w));
  });
};

const distanceTo = (memory: Memory, position?: Position) => (memory.place ? (bearing(position, memory.place)?.distance ?? Infinity) : Infinity);

const PINS = `${MAX_PINNED} memories are pinned already: unpin one first (update with pinned false), or keep this one unpinned.`;

/**
 * memories: the agent keeps lasting facts about the asking player, and only them, and since 6.9 the places they
 * want kept too, what the plugin's notebook held before. Since 6.27 a memory has a kind, a title, tags, and a pin, a
 * place a category and a radius, and the model changes one in place instead of adding a second.
 */
export const memoryTools = (memories: MemoryStore, options: { owner: Owner; emit: Emit; position?: Position; readOnly?: boolean }) => {
  const status = (name: string, args: object) => {
    const callId = crypto.randomUUID();
    return (state: "started" | "finished" | "failed", summary?: Summary) =>
      options.emit({ event: "tool_status", data: { call_id: callId, name, kind: "server", state, args, ...summaryFields(summary) } });
  };

  /** The place the input names: coordinates, where the player stands, or none; a string when it can't be had. */
  const placeOf = (input: { here?: boolean; x?: number; y?: number; z?: number; dimension?: string; radius?: number }): Place | string | undefined => {
    const radius = input.radius ? { radius: input.radius } : {};
    if (input.x !== undefined && input.z !== undefined) {
      const dimension = input.dimension ?? options.position?.dimension;
      if (!dimension) return "Name the dimension: the player's position isn't known";
      const world = options.position?.world && dimension === options.position.dimension ? { world: options.position.world } : {};
      return { x: input.x, y: input.y ?? options.position?.y ?? 64, z: input.z, dimension, ...world, ...radius };
    }
    if (input.here) return options.position ? { ...options.position, ...radius } : "The player's position isn't known here; pass x, y, z instead";
    return undefined;
  };

  type Input = z.infer<typeof schema>;

  const add = async (input: Input) => {
    if (!input.text || input.text.trim().length < 3) return { error: "add needs text of 3 characters or more" };
    const place = placeOf(input);
    if (typeof place === "string") return { error: place };
    const saved = await memories.add(options.owner, {
      text: input.text,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.pinned ? { pinned: true } : {}),
      ...(place ? { place } : {}),
      ...(input.category ? { category: input.category } : {}),
    });
    if (saved === "full") return { full: true };
    if (saved === "pins") return { error: PINS };
    return { saved: shown(saved, options.position) };
  };

  const update = async (input: Input) => {
    if (!input.id) return { error: "update needs the memory's id: find it first" };
    if (input.text !== undefined && input.text.trim().length < 3) return { error: "text must be 3 characters or more" };
    const place = placeOf(input);
    if (typeof place === "string") return { error: place };
    const before = input.add_tags || input.remove_tags ? (await memories.list(options.owner)).find((m) => m.id === input.id) : undefined;
    const tags = before
      ? [...before.tags.filter((t) => !tagsOf(input.remove_tags).includes(t)), ...tagsOf(input.add_tags)]
      : input.tags;
    const patch: Patch = {
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.title !== undefined ? { title: input.title.trim() || null } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(tags ? { tags } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(place ? { place } : input.remove_place ? { place: null } : {}),
    };
    // A radius alone widens the place the memory has.
    const kept = !place && input.radius && !input.remove_place ? (before ?? (await memories.list(options.owner)).find((m) => m.id === input.id))?.place : undefined;
    if (kept) patch.place = { ...kept, radius: input.radius! };
    const changed = await memories.update(options.owner, input.id, patch);
    if (changed === "pins") return { error: PINS };
    return changed ? { updated: shown(changed, options.position) } : { error: `No memory with id ${input.id}` };
  };

  const find = async (input: Input) => {
    const all = await memories.list(options.owner);
    const filtered = all.filter(
      (m) =>
        (!input.kind || m.kind === input.kind) &&
        (!input.tag || m.tags.includes(tagsOf([input.tag])[0] ?? "")) &&
        (input.pinned === undefined || m.pinned === input.pinned) &&
        (!input.category || m.category === input.category),
    );
    const found = matching(filtered, input.query);
    // No word met: the whole list as a short index, so the model matches by meaning and opens the ones it means.
    if (!found.length && filtered.length) {
      return { matched: 0, total: all.length, note: "no memory has these words; match by meaning in index, then find by id or with a tag", index: filtered.map(indexed).reverse() };
    }
    const byId = input.id ? found.filter((m) => m.id === input.id) : found;
    const ordered = input.near ? [...byId].sort((a, b) => distanceTo(a, options.position) - distanceTo(b, options.position)) : [...byId].reverse();
    const listed = ordered.slice(0, input.limit ?? FIND_LIMIT).map((m) => shown(m, options.position));
    return { matched: byId.length, total: all.length, memories: listed };
  };

  const schema = z.object({
    action: z.enum(["add", "find", "update", "delete"]).optional(),
    id: z.string().min(1).max(16).optional().describe("update, delete: the memory's id; find: just that one"),
    text: z.string().max(MAX_MEMORY_CHARS).optional().describe("add, update: the fact, or what is at the place, whole"),
    title: z.string().max(MAX_TITLE_CHARS).optional().describe("add, update: a few words for the player's list («Железная ферма»); empty removes it"),
    kind: z.enum(["fact", "preference", "goal"]).optional().describe("add, update: what it is about when it has no place; fact by default; find: only these"),
    tags: z
      .array(z.string().min(1).max(MAX_TAG_CHARS))
      .max(MAX_TAGS)
      .optional()
      .describe("add, update: words to group by, in the player's language («ферма», «редстоун»); update replaces them all"),
    add_tags: z.array(z.string().min(1).max(MAX_TAG_CHARS)).max(MAX_TAGS).optional().describe("update: tags to add, keeping the rest"),
    remove_tags: z.array(z.string().min(1).max(MAX_TAG_CHARS)).max(MAX_TAGS).optional().describe("update: tags to take off"),
    pinned: z.boolean().optional().describe(`add, update: pinned memories are always in your prompt and on top of the player's list, ${MAX_PINNED} at most; find: only pinned or unpinned`),
    here: z.boolean().optional().describe("add, update: tie it to where the player stands"),
    x: z.number().int().optional().describe("add, update: only for a place other than where the player stands"),
    y: z.number().int().optional(),
    z: z.number().int().optional(),
    dimension: z.enum(DIMENSIONS).optional().describe("add, update: only when the player names another dimension or the place exists only there"),
    radius: z.number().int().min(1).max(MAX_RADIUS).optional().describe("add, update: how far the place reaches, in blocks, for an area («ферма 20×20» is 10)"),
    category: z.enum(CATEGORIES).optional().describe("add, update: what kind of place; find: only these"),
    remove_place: z.boolean().optional().describe("update: the memory stops being tied to a place"),
    query: z.string().max(100).optional().describe("find: words to look for in the text, title, and tags"),
    tag: z.string().max(MAX_TAG_CHARS).optional().describe("find: only memories with this tag"),
    near: z.boolean().optional().describe("find: nearest places first"),
    limit: z.number().int().min(1).max(50).optional(),
  });

  return {
    memories: createTool({
      id: "memories",
      description: `What Allay keeps about the asking player between conversations: lasting facts (what they have done, what they own), preferences (how they like answers, their layouts), goals, and places (their base, a villager that sells arrows, a farm), each up to ${MAX_MEMORY_CHARS} characters with an optional title, tags, and a pin. action add saves one: with here true it is tied to where the player stands, with x, z (and y, dimension) to another spot, without either it has none; a place may have a category and a radius. Any request to remember something about a place is add with a place («запомни, что тут ферма», “remember my base is here”). update changes one by id in place: when a fact changed («теперь ферма на 3 слоя», "I moved my base"), when the player asks to pin, tag, rename, or move it, never add a second copy. find (the default) returns memories with id and, for places, x, y, z, dimension, distance and direction from the player, and inside when they stand within its radius; query looks in the text, title, and tags; tag, kind, category, and pinned filter; near sorts by distance. When no memory has the query's words, find returns an index of all of them to match by meaning. delete removes one by id when the player asks or it's wrong for good. Never secrets, passwords, or other players' data.`,
      inputSchema: forModel(schema),
      strict: false,
      execute: async (input) => {
        const action = input.action ?? "find";
        if (options.readOnly && action !== "find") return { error: "Only reading here: this request turns into commands" };
        const report = status("memories", input);
        report("started");
        try {
          if (action === "add") {
            const result = await add(input);
            if ("full" in result) {
              report("failed", { text: "memory is full", key: "memory_full" });
              return { error: `Memory is full (${maxMemories()}). Delete an outdated one first, or tell the player to clear some with /allay forget.` };
            }
            if ("error" in result) {
              report("failed", { text: "not saved" });
              return result;
            }
            report("finished", { text: result.saved.text.slice(0, 60), key: "remembered", values: { text: result.saved.text.slice(0, 60) } });
            return result;
          }
          if (action === "update") {
            const result = await update(input);
            if ("error" in result) {
              report("failed", { text: "not changed" });
              return result;
            }
            report("finished", { text: (result.updated.title ?? result.updated.text).slice(0, 60), key: "remembered", values: { text: (result.updated.title ?? result.updated.text).slice(0, 60) } });
            return result;
          }
          if (action === "delete") {
            if (!input.id) return { error: "delete needs the memory's id" };
            const removed = await memories.remove(options.owner, input.id);
            report(removed ? "finished" : "failed", removed ? { text: "forgotten", key: "forgotten" } : { text: "no such memory", key: "no_such_memory" });
            return removed ? { deleted: input.id } : { error: `No memory with id ${input.id}` };
          }
          const result = await find(input);
          report("finished", { text: `${result.memories?.length ?? 0} found` });
          return result;
        } catch (error) {
          logger.warn(`Memories unavailable: ${String(error)}`);
          report("failed", { text: "memory unavailable", key: "memory_unavailable" });
          return { error: "Memory is unavailable right now." };
        }
      },
    }),
  };
};
