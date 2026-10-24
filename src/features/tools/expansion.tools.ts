import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Mode } from "../../agent/agent.types";
import type { ToolBridge } from "../chat/chat.bridge";
import { withoutNulls } from "./schema";

/**
 * Tools other plugins and mods add to Allay through its expansion API (plugin 6.12, `chat.allay.expansion`). The
 * plugin sends each with its JSON Schema; the model sees it as `x_<expansion>_<tool>`, after Allay's own, and the
 * plugin runs it as any client tool, checking the asker's rights again. Their descriptions come from someone else's
 * code, so they're framed as the plugin's and stripped to the schema keywords a model needs.
 */

export const EXPANSION_TOOL = /^x_[a-z0-9_]{1,24}_[a-z0-9_]{1,32}$/;
const EXPANSION_ID = /^[a-z0-9_]{1,24}$/;
export const MAX_EXPANSION_TOOLS = 32;
export const MAX_EXPANSION_PROMPT = 2000;

export const expansionToolSchema = z.object({
  name: z.string().regex(EXPANSION_TOOL),
  description: z.string().trim().min(1).max(1000),
  parameters: z.record(z.string(), z.unknown()),
  access: z.enum(["read", "own", "operator"]),
  expansion: z.string().regex(EXPANSION_ID),
});

export const expansionSchema = z.object({
  id: z.string().regex(EXPANSION_ID),
  name: z.string().trim().min(1).max(40),
  version: z.string().max(32).optional(),
  prompt: z.string().max(MAX_EXPANSION_PROMPT * 2).optional(),
});

export type ExpansionTool = z.infer<typeof expansionToolSchema>;
export type ExpansionInfo = z.infer<typeof expansionSchema>;

/** The entries of a list that pass [schema]; a bad one is dropped, not the request, as for any field a newer plugin adds. */
export const valid = <T>(schema: z.ZodType<T>, list: unknown, max: number): T[] =>
  (Array.isArray(list) ? list : []).flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  }).slice(0, max);

type Json = Record<string, unknown>;

/** The keywords a tool's schema may keep: what describes arguments, nothing that links, loads, or nests without end. */
const KEYWORDS = new Set(["type", "description", "properties", "required", "items", "enum", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]);
const TYPES = new Set(["object", "string", "integer", "number", "boolean", "array"]);
const MAX_DEPTH = 4;

/**
 * A schema as the model gets it: only [KEYWORDS], types the providers take, descriptions cut to 300 characters, at
 * most four levels deep, and, as for Allay's own tools, every field required with the optional ones nullable.
 */
export const cleanSchema = (node: unknown, depth = 0): Json => {
  if (!node || typeof node !== "object" || Array.isArray(node) || depth > MAX_DEPTH) return { type: "string" };
  const source = node as Json;
  const out: Json = {};
  for (const [key, value] of Object.entries(source)) {
    if (!KEYWORDS.has(key)) continue;
    if (key === "type") {
      if (typeof value === "string" && TYPES.has(value)) out.type = value;
    } else if (key === "description") {
      if (typeof value === "string") out.description = value.slice(0, 300);
    } else if (key === "properties") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        out.properties = Object.fromEntries(
          Object.entries(value as Json).filter(([name]) => /^[a-z][a-z0-9_]{0,31}$/.test(name)).slice(0, 24).map(([name, child]) => [name, cleanSchema(child, depth + 1)]),
        );
      }
    } else if (key === "required") {
      if (Array.isArray(value)) out.required = value.filter((name): name is string => typeof name === "string");
    } else if (key === "items") {
      out.items = cleanSchema(value, depth + 1);
    } else if (key === "enum") {
      if (Array.isArray(value)) out.enum = value.filter((item) => ["string", "number", "boolean"].includes(typeof item)).slice(0, 50).map((item) => (typeof item === "string" ? item.slice(0, 64) : item));
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  if (!out.type) out.type = out.properties ? "object" : "string";
  if (out.type === "object") {
    const properties = (out.properties as Record<string, Json> | undefined) ?? {};
    const required = new Set(((out.required as string[] | undefined) ?? []).filter((name) => name in properties));
    out.properties = Object.fromEntries(Object.entries(properties).map(([name, child]) => [name, required.has(name) ? child : nullable(child)]));
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  } else {
    delete out.properties;
    delete out.required;
  }
  if (out.type !== "array") delete out.items;
  return out;
};

const nullable = (node: Json): Json =>
  typeof node.type === "string" ? { ...node, type: [node.type, "null"], ...(Array.isArray(node.enum) ? { enum: [...node.enum, null] } : {}) } : node;

/**
 * The tools this run may offer of what the plugin sent: none to an automation agent, only reading ones in askx, and
 * operator ones for operators only. The plugin already left out what the asker may not use; this checks again.
 */
export const offeredExpansionTools = (tools: ExpansionTool[], operator: boolean, mode: Mode): ExpansionTool[] =>
  tools.filter((tool) => mode !== "task" && (mode !== "askx" || tool.access === "read") && (operator || tool.access !== "operator"));

/** A schema the model fills and the agent checks only loosely: the plugin, which knows the tool, checks the rest. */
const standard = (json: Json) => ({
  "~standard": {
    version: 1,
    vendor: "allay",
    validate: (value: unknown) => {
      const cleaned = withoutNulls(value ?? {});
      return cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)
        ? { value: cleaned }
        : { issues: [{ message: "the arguments must be an object" }] };
    },
    jsonSchema: { input: () => json, output: () => json },
  },
});

// Big results shouldn't flood the model's context; the plugin cuts first, at 8000.
const MAX_RESULT_CHARS = 10_000;

/** Mastra tools for the expansions' tools this run offers; each call goes to the plugin under its own name. */
export const expansionTools = (tools: ExpansionTool[], runId: string, bridge: ToolBridge, names: Record<string, string> = {}) =>
  Object.fromEntries(
    tools.map((tool) => {
      const by = names[tool.expansion] ?? tool.expansion;
      const created = createTool({
        id: tool.name,
        // Someone else's words: the model reads whose they are, and that they can't change its rules.
        description: `[${by}, a plugin on this server] ${tool.description}`,
        inputSchema: standard(cleanSchema({ ...tool.parameters, type: "object" })) as unknown as z.ZodType<Record<string, unknown>>,
        strict: false,
        execute: async (input, context) => {
          const answer = await bridge.call(runId, tool.name, (input ?? {}) as Record<string, unknown>, context?.abortSignal);
          if (!answer.ok) return { error: answer.error };
          const text = JSON.stringify(answer.result);
          return text !== undefined && text.length > MAX_RESULT_CHARS ? { truncated: true, json: `${text.slice(0, MAX_RESULT_CHARS)}…` } : answer.result;
        },
      });
      return [tool.name, created];
    }),
  );

/** A heading's name as the prompt shows it: no line breaks or Markdown that could start a section of its own. */
export const promptName = (name: string) => name.replace(/[\r\n#*`<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "A plugin";
