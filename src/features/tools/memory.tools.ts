import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { forModel } from "./schema";
import { MAX_MEMORIES, MAX_MEMORY_CHARS, type MemoryStore } from "../../infrastructure/memory/memory";
import type { Owner } from "../../shared/types/owner";
import { logger } from "../../shared/logging/logger";
import { type Emit, type Summary, summaryFields } from "../chat/chat.events";

/** remember and forget: the agent keeps lasting facts about the asking player, and only them. */
export const memoryTools = (memories: MemoryStore, options: { owner: Owner; emit: Emit }) => {
  const status = (name: string, args: object) => {
    const callId = crypto.randomUUID();
    return (state: "started" | "finished" | "failed", summary?: Summary) =>
      options.emit({ event: "tool_status", data: { call_id: callId, name, kind: "server", state, args, ...summaryFields(summary) } });
  };
  return {
    remember: createTool({
      id: "remember",
      description: `Saves a lasting fact about the asking player for future conversations: their goals, what they have done, how they like answers. Never for places: anything about where something is or where the player stands goes in the notebook (notes add), which records the coordinates. One short fact per call, up to ${MAX_MEMORY_CHARS} characters, at most ${MAX_MEMORIES} in total. Never secrets, passwords, or other players' data.`,
      inputSchema: forModel(z.object({ text: z.string().min(3).max(MAX_MEMORY_CHARS) })),
      strict: false,
      execute: async ({ text }) => {
        const report = status("remember", { text });
        report("started");
        try {
          const saved = await memories.add(options.owner, text);
          if (saved === "full") {
            report("failed", { text: "memory is full", key: "memory_full" });
            return { error: `Memory is full (${MAX_MEMORIES}). Forget an outdated fact first, or tell the player to clear some with /ask forget.` };
          }
          report("finished", { text: saved.text.slice(0, 60), key: "remembered", values: { text: saved.text.slice(0, 60) } });
          return { saved };
        } catch (error) {
          logger.warn(`Couldn't remember: ${String(error)}`);
          report("failed", { text: "memory unavailable", key: "memory_unavailable" });
          return { error: "Memory is unavailable right now." };
        }
      },
    }),
    forget: createTool({
      id: "forget",
      description: "Deletes one remembered fact about the asking player by its id, when they ask or when it's outdated.",
      inputSchema: forModel(z.object({ id: z.string().min(1).max(16) })),
      strict: false,
      execute: async ({ id }) => {
        const report = status("forget", { id });
        report("started");
        try {
          const removed = await memories.remove(options.owner, id);
          report(removed ? "finished" : "failed", removed ? { text: "forgotten", key: "forgotten" } : { text: "no such memory", key: "no_such_memory" });
          return removed ? { forgotten: id } : { error: `No memory with id ${id}` };
        } catch (error) {
          logger.warn(`Couldn't forget: ${String(error)}`);
          report("failed", { text: "memory unavailable", key: "memory_unavailable" });
          return { error: "Memory is unavailable right now." };
        }
      },
    }),
  };
};
