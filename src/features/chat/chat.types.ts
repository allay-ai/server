import { z } from "zod";
import { DIMENSIONS, LOADERS, type RunContext, SIDES, TASK_KINDS, TASK_STATES } from "../../agent/agent.types";
import type { ProviderBlock } from "../billing/gate";
import { API_ERRORS, type ApiError, apierror } from "../../shared/types/errors";
import { USER_ID } from "../../shared/types/owner";
import { expansionSchema, expansionToolSchema, MAX_EXPANSION_PROMPT, MAX_EXPANSION_TOOLS, valid } from "../tools/expansion.tools";

const text = (max: number) => z.string().max(max).optional();

/** The longest `server.about` the model reads; the plugin warns past 2,000, since every question pays for it. */
export const MAX_ABOUT = 10_000;
const taskId = z.string().regex(/^[a-z0-9]{1,16}$/);

// Extra fields are allowed so newer plugins can send more without breaking older backends.
export const chatRequestSchema = z.object({
  mode: z.enum(["ask", "askx", "task"]).default("ask"),
  message: z.string(),
  platform: z.literal("minecraft").default("minecraft"),
  visibility: z.enum(["private", "public"]).default("private"),
  // Letters, digits, - and _ only: ids go into session keys, and no colon may let one id reach another's thread.
  user_id: z.string().regex(USER_ID, "1–64 letters, digits, - or _"),
  locale: text(16),
  timezone: text(64),
  // dimension since 5.1: where the player stands when they ask. Unknown values are dropped, not refused, for future dimensions.
  // private since 6.5: the player turned on full privacy, so the admin panel doesn't learn their name.
  // position since 6.9: where they stand, for distances to their places and deaths.
  player: z
    .object({
      name: z.string().min(1).max(32),
      uuid: text(36),
      op: z.boolean().optional(),
      dimension: z.enum(DIMENSIONS).optional().catch(undefined),
      private: z.boolean().optional(),
      // Since 6.9; a bad one is dropped, not refused.
      position: z
        .object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), dimension: z.enum(DIMENSIONS), world: z.string().min(1).max(64).optional() })
        .optional()
        .catch(undefined),
    })
    .optional(),
  // address and port since 6.6: where players join, for the admin panel. A bad value is dropped, not refused.
  server: z
    .object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
      software: text(64),
      version: text(64),
      plugin_version: text(64),
      address: z.string().trim().regex(/^[A-Za-z0-9.:\[\]-]{1,255}$/).optional().catch(undefined),
      port: z.number().int().min(1).max(65_535).optional().catch(undefined),
      // Since 6.12; one this backend doesn't know is dropped, not refused.
      loader: z.enum(LOADERS).optional().catch(undefined),
      side: z.enum(SIDES).optional().catch(undefined),
      // Since 6.20: cut, not refused, so a long text never stops a server's questions.
      about: z
        .string()
        .optional()
        .catch(undefined)
        .transform((about) => about?.trim().slice(0, MAX_ABOUT) || undefined),
    })
    .optional(),
  tools: z.array(z.string().max(64)).max(256).default([]),
  // Since 5.0: the server's own provider; its key comes in X-Provider-Key.
  provider: z.object({ base_url: text(512), model: text(200), search_model: text(200) }).optional(),
  // Since 5.5: the automation agent a task-mode run wakes; required in that mode.
  task: z
    .object({ id: taskId, name: z.string().min(1).max(40), depth: z.union([z.literal(1), z.literal(2)]), kind: z.enum(TASK_KINDS) })
    .optional(),
  // Since 5.5, ask mode: the asker's running automations. Since 5.10.1, task mode: the waking agent's own sub-agents.
  tasks: z
    .array(z.object({ id: taskId, name: z.string().min(1).max(40), state: z.enum(TASK_STATES), question: text(200) }))
    .max(4)
    .optional(),
  // Since 6.14, from plugin 6.12: other plugins' and mods' tools and prompt lines. A bad entry is dropped, not refused.
  expansion_tools: z.array(z.unknown()).max(64).optional().catch(undefined),
  expansions: z.array(z.unknown()).max(32).optional().catch(undefined),
});

export const toolAnswerSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  // A longer error is cut, not refused: a refused answer left the model waiting out the tool timeout.
  z.object({ ok: z.literal(false), error: z.string().transform((error) => error.slice(0, 2000)) }),
]);

const LIMITS = { ask: 1000, askx: 500, task: 2000 } as const;

/** What expansions a request brings: none to an automation agent, which works from Allay's own tools only. */
const expansionsOf = (request: z.infer<typeof chatRequestSchema>) => {
  if (request.mode === "task") return {};
  const tools = valid(expansionToolSchema, request.expansion_tools, MAX_EXPANSION_TOOLS);
  const expansions = valid(expansionSchema, request.expansions, 16).map((e) => ({ ...e, prompt: e.prompt?.trim().slice(0, MAX_EXPANSION_PROMPT) || undefined }));
  const names = new Set<string>();
  return {
    ...(tools.length ? { expansionTools: tools.filter((tool) => !names.has(tool.name) && names.add(tool.name)) } : {}),
    ...(expansions.length ? { expansions } : {}),
  };
};

/** Validates a v2 body into a run context, or explains what's wrong with it in v1 error codes. Who pays is decided later. */
export const parseChatRequest = (
  body: unknown,
  tenant: string,
): { ok: true; context: RunContext; provider?: ProviderBlock } | { ok: false; error: ApiError } => {
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: apierror(API_ERRORS.BAD_REQUEST, `${issue.path.join(".") || "body"}: ${issue.message}`) };
  }
  const request = parsed.data;
  if (request.mode === "task" && !request.task) return { ok: false, error: apierror(API_ERRORS.BAD_REQUEST, "task: required in task mode") };
  const message = request.message.trim();
  if (!message) return { ok: false, error: apierror(request.mode === "askx" ? API_ERRORS.EMPTY_ACTION : API_ERRORS.EMPTY_QUESTION) };
  if (message.length > LIMITS[request.mode]) {
    if (request.mode === "askx") return { ok: false, error: apierror(API_ERRORS.ACTION_TOO_LONG) };
    if (request.mode === "task") return { ok: false, error: { ...API_ERRORS.QUESTION_TOO_LONG, message: "Message too long (max 2000 characters)" } };
    return { ok: false, error: apierror(API_ERRORS.QUESTION_TOO_LONG) };
  }
  return {
    ok: true,
    context: {
      mode: request.mode,
      platform: "minecraft",
      tenant,
      userId: request.user_id,
      message,
      locale: request.locale,
      visibility: request.mode === "ask" ? request.visibility : "private",
      timezone: request.timezone,
      player: request.player,
      server: request.server,
      tools: [...new Set(request.tools)],
      ...(request.mode === "task" ? { task: request.task } : {}),
      ...(request.mode !== "askx" && request.tasks?.length ? { tasks: request.tasks } : {}),
      ...expansionsOf(request),
    },
    provider: request.provider,
  };
};
