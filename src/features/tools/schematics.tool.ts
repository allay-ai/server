import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Filters, SchematicCatalog, Schematic } from "../../infrastructure/schematics/catalog";
import { logger } from "../../shared/logging/logger";
import { type Emit, type Summary, summaryFields } from "../chat/chat.events";
import { forModel } from "./schema";

/** Builds one page shows. */
export const PAGE = 5;

/** A build as the model reads it: a title in the player's language, what it is, how big, and from what. */
const shown = (s: Schematic, lang: string) => ({
  id: s.id,
  title: s.title[lang] ?? s.title.en ?? s.id,
  description: s.description,
  size: `${s.size.x}×${s.size.y}×${s.size.z}`,
  blocks: s.blocks,
  materials: s.materials.slice(0, 6).map((m) => `${m.count} × ${m.block.replace(/^minecraft:/, "")}`),
  type: s.tags.type ?? [],
  style: s.tags.style ?? [],
  author: s.author,
  license: s.license,
});

/**
 * `search_schematics`: finds builds in Allay's catalog of real schematics (allay-ai/schematics), so the model offers
 * what exists instead of drawing one. [filters] are the server's and the player's, never the model's to lift.
 */
export const searchSchematicsTool = (catalog: SchematicCatalog, options: { emit: Emit; locale?: string; filters?: Filters }) =>
  createTool({
    id: "search_schematics",
    description:
      "Finds builds in Allay's catalog of real schematics, each by its author: houses, castles, towers, farms, bridges, ships, and more. Write query in English from the player's words (a medieval windmill: \"medieval windmill\"), with type or style when they said one. Each result has an id, a title in the player's language, what it is, its size (width × height × depth), its block count and main materials, and its author. page goes on through more. Never make a build up: offer what this finds, or say it found nothing close.",
    inputSchema: forModel(
      z.object({
        query: z.string().min(1).max(200),
        type: z.string().max(32).optional().describe("house, castle, tower, farm, bridge, ship, temple, shop, village, wall, gate, statue, garden, fountain, redstone, interior, decoration"),
        style: z.string().max(32).optional().describe("medieval, fantasy, modern, rustic, japanese, chinese, nordic, desert, steampunk, gothic, classical, futuristic"),
        page: z.number().int().min(1).max(50).optional(),
      }),
    ),
    strict: false,
    execute: async ({ query, type, style, page }) => {
      const callId = crypto.randomUUID();
      const status = (state: "started" | "finished" | "failed", summary?: Summary) =>
        options.emit({ event: "tool_status", data: { call_id: callId, name: "search_schematics", kind: "server", state, args: { query }, ...summaryFields(summary) } });
      status("started");
      const lang = (options.locale ?? "en").slice(0, 2);
      const at = ((page ?? 1) - 1) * PAGE;
      try {
        const found = await catalog.search(query, { ...options.filters, type: type?.toLowerCase(), style: style?.toLowerCase() }, at, PAGE);
        status("finished", { text: `${found.total} builds`, key: "schematics", values: { count: found.total } });
        return {
          total: found.total,
          page: page ?? 1,
          ...(at + PAGE < found.total ? { next_page: (page ?? 1) + 1 } : {}),
          schematics: found.schematics.map((s) => shown(s, lang)),
        };
      } catch (error) {
        logger.warn(`Schematic search failed: ${String(error)}`);
        status("failed", { text: "the catalog is out of reach", key: "schematics_unavailable" });
        return { error: "The catalog of builds is out of reach right now; say so and offer to look again later." };
      }
    },
  });
