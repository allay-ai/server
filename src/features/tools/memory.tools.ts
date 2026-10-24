import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { forModel } from "./schema";
import { DIMENSIONS, type Position } from "../../agent/agent.types";
import { MAX_MEMORY_CHARS, type Memory, type MemoryStore, type Place, maxMemories } from "../../infrastructure/memory/memory";
import { bearing } from "../../shared/lib/compass";
import type { Owner } from "../../shared/types/owner";
import { logger } from "../../shared/logging/logger";
import { type Emit, type Summary, summaryFields } from "../chat/chat.events";

const FIND_LIMIT = 20;

/** A memory as the model reads it: the place spelled out, with distance and direction from where the player stands. */
const shown = (memory: Memory, position?: Position) => ({
  id: memory.id,
  text: memory.text,
  ...(memory.place ? { ...memory.place, ...bearing(position, memory.place) } : {}),
  created_at: memory.created_at.slice(0, 10),
});

/** Memories whose words meet the query's; when none do, all of them, so the model matches by meaning. */
const matching = (memories: Memory[], query?: string) => {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  if (!words.length) return { matched: memories.length, found: memories };
  const found = memories.filter((m) => words.some((w) => m.text.toLowerCase().includes(w)));
  return { matched: found.length, found: found.length ? found : memories };
};

const distanceTo = (memory: Memory, position?: Position) => (memory.place ? (bearing(position, memory.place)?.distance ?? Infinity) : Infinity);

/**
 * memories: the agent keeps lasting facts about the asking player, and only them, and since 6.9 the places they
 * want kept too, what the plugin's notebook held before.
 */
export const memoryTools = (memories: MemoryStore, options: { owner: Owner; emit: Emit; position?: Position; readOnly?: boolean }) => {
  const status = (name: string, args: object) => {
    const callId = crypto.randomUUID();
    return (state: "started" | "finished" | "failed", summary?: Summary) =>
      options.emit({ event: "tool_status", data: { call_id: callId, name, kind: "server", state, args, ...summaryFields(summary) } });
  };
  const add = async (input: { text?: string; here?: boolean; x?: number; y?: number; z?: number; dimension?: string }) => {
    if (!input.text || input.text.trim().length < 3) return { error: "add needs text of 3 characters or more" };
    let place: Place | undefined;
    if (input.x !== undefined && input.z !== undefined) {
      const dimension = input.dimension ?? options.position?.dimension;
      if (!dimension) return { error: "Name the dimension: the player's position isn't known" };
      place = { x: input.x, y: input.y ?? options.position?.y ?? 64, z: input.z, dimension, ...(options.position?.world && dimension === options.position.dimension ? { world: options.position.world } : {}) };
    } else if (input.here) {
      if (!options.position) return { error: "The player's position isn't known here; pass x, y, z instead" };
      place = { ...options.position };
    }
    const saved = await memories.add(options.owner, input.text, place);
    if (saved === "full") return { full: true };
    return { saved: shown(saved, options.position) };
  };
  return {
    memories: createTool({
      id: "memories",
      description: `What Allay keeps about the asking player between conversations: lasting facts (goals, what they have done, how they like answers) and places (their base, a villager that sells arrows, a cave with diamonds). action add saves one, up to ${MAX_MEMORY_CHARS} characters: with here true it is tied to where the player stands, with x, z (and y, dimension) to another spot, without either it is a plain fact. Any request to remember something about a place is add with a place («запомни, что тут ферма», “remember my base is here”). find (the default) returns them with id, text, and for places x, y, z, dimension, distance and direction from the player; query filters by words, so match by meaning yourself; near sorts by distance. delete removes one by id when the player asks or it's outdated. The prompt already lists the newest facts without a place; use find for places and anything older. Never secrets, passwords, or other players' data.`,
      inputSchema: forModel(
        z.object({
          action: z.enum(["add", "find", "delete"]).optional(),
          text: z.string().max(MAX_MEMORY_CHARS).optional().describe("add: the fact, or what is at the place"),
          here: z.boolean().optional().describe("add: tie it to where the player stands"),
          x: z.number().int().optional().describe("add: only for a place other than where the player stands"),
          y: z.number().int().optional(),
          z: z.number().int().optional(),
          dimension: z.enum(DIMENSIONS).optional().describe("add: only when the player names another dimension or the place exists only there"),
          query: z.string().max(100).optional().describe("find: words to look for"),
          near: z.boolean().optional().describe("find: nearest places first"),
          limit: z.number().int().min(1).max(50).optional(),
          id: z.string().min(1).max(16).optional().describe("delete: the memory's id"),
        }),
      ),
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
          if (action === "delete") {
            if (!input.id) return { error: "delete needs the memory's id" };
            const removed = await memories.remove(options.owner, input.id);
            report(removed ? "finished" : "failed", removed ? { text: "forgotten", key: "forgotten" } : { text: "no such memory", key: "no_such_memory" });
            return removed ? { deleted: input.id } : { error: `No memory with id ${input.id}` };
          }
          const all = await memories.list(options.owner);
          const { matched, found } = matching(all, input.query);
          const ordered = input.near ? [...found].sort((a, b) => distanceTo(a, options.position) - distanceTo(b, options.position)) : [...found].reverse();
          const listed = ordered.slice(0, input.limit ?? FIND_LIMIT).map((m) => shown(m, options.position));
          report("finished", { text: `${listed.length} found` });
          return { matched, total: all.length, memories: listed };
        } catch (error) {
          logger.warn(`Memories unavailable: ${String(error)}`);
          report("failed", { text: "memory unavailable", key: "memory_unavailable" });
          return { error: "Memory is unavailable right now." };
        }
      },
    }),
  };
};
