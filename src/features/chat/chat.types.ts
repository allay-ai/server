import { z } from "zod";
import { DIMENSIONS, type RunContext, TASK_KINDS, TASK_STATES } from "../../agent/agent.types";
import type { ProviderBlock } from "../billing/gate";
import { API_ERRORS, type ApiError, apierror } from "../../shared/types/errors";
import { USER_ID } from "../../shared/types/owner";

const text = (max: number) => z.string().max(max).optional();
const taskId = z.string().regex(/^[a-z0-9]{1,16}$/);

// Extra fields are allowed so newer plugins can send more without breaking older backends.
export const chatRequestSchema = z.object({
  mode: z.enum(["ask", "askx", "task"]).default("ask"),
  message: z.string(),
  platform: z.literal("minecraft").default("minecraft"),
  visibility: z.enum(["private", "public"]).default("private"),
  // Letters, digits, - and _ only: ids go into Redis keys, and no colon may let one id reach another's thread.
  user_id: z.string().regex(USER_ID, "1–64 letters, digits, - or _"),
  locale: text(16),
  timezone: text(64),
  // dimension since 5.1: where the player stands when they ask. Unknown values are dropped, not refused, for future dimensions.
  player: z
    .object({ name: z.string().min(1).max(32), uuid: text(36), op: z.boolean().optional(), dimension: z.enum(DIMENSIONS).optional().catch(undefined) })
    .optional(),
  server: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(), software: text(64), version: text(64), plugin_version: text(64) }).optional(),
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
});

export const toolAnswerSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  // A longer error is cut, not refused: a refused answer left the model waiting out the tool timeout.
  z.object({ ok: z.literal(false), error: z.string().transform((error) => error.slice(0, 2000)) }),
]);

const LIMITS = { ask: 1000, askx: 500, task: 2000 } as const;

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
    },
    provider: request.provider,
  };
};
