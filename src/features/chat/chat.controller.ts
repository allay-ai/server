import type { Server } from "bun";
import { type AllayDeps, runAllay } from "../../agent/allay";
import { jsonError, readJson } from "../../shared/lib/http";
import { logger } from "../../shared/logging/logger";
import { API_ERRORS, apierror } from "../../shared/types/errors";
import { admit, payer } from "../billing/gate";
import { settings } from "../settings/settings";
import { parseChatRequest, toolAnswerSchema } from "./chat.types";
import { sseResponse } from "./chat.sse";

/** POST /api/v2/chat: one question, streamed back as events while the agent works. */
export const handleChat = (deps: AllayDeps) => async (req: Request, server?: Server): Promise<Response> => {
  if (req.method !== "POST") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const json = await readJson(req);
  if (!json.ok) return jsonError(json.error);
  const parsed = parseChatRequest(json.body);
  if (!parsed.ok) return jsonError(parsed.error);
  if (deps.bridge.active >= settings.get("MAX_ACTIVE_RUNS")) {
    return jsonError({ code: "QUEUE_ERROR", message: "Too many questions at once; try again in a minute", statusCode: 503 });
  }
  const serverKey = parsed.context.server?.id ?? server?.requestIP(req)?.address ?? "unknown";
  const admitted = await admit(deps.billing, req.headers, parsed.provider, serverKey);
  if (!admitted.ok) return jsonError(admitted.error.toApiError());
  const { admission } = admitted;

  // Runs outlast Bun's idle timeout while the model thinks; pings keep proxies happy instead.
  server?.timeout(req, 0);
  const runId = crypto.randomUUID();
  const context = { ...parsed.context, provider: admission.provider, model: admission.model };
  logger.info(
    `Run ${runId}: ${context.mode}${context.task ? ` ${context.task.id}` : ""} from ${context.player?.name ?? context.userId}, tools: ${context.tools.length}, on ${payer(admission)}`,
  );

  return sseResponse(async (emit, signal) => {
    deps.bridge.open(runId, emit);
    try {
      await runAllay(context, deps, { runId, emit, signal, spend: admission.spend });
    } finally {
      deps.bridge.close(runId);
      admission.release();
    }
  }, req.signal);
};

type Params = { runId: string; callId: string };

/** POST /api/v2/chat/{run_id}/tools/{call_id}: the plugin's answer to a tool call. */
export const handleToolResult = (deps: AllayDeps) => async (req: Request & { params?: Params }): Promise<Response> => {
  if (req.method !== "POST") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const { runId, callId } = req.params ?? ({} as Params);
  const json = await readJson(req);
  if (!json.ok) return jsonError(json.error);
  const answer = toolAnswerSchema.safeParse(json.body);
  if (!answer.success) return jsonError(apierror(API_ERRORS.BAD_REQUEST, "send { ok: true, result } or { ok: false, error }"));
  const status = deps.bridge.answer(runId, callId, answer.data);
  if (status === 404) return jsonError(apierror(API_ERRORS.RUN_NOT_FOUND));
  if (status === 409) return jsonError(apierror(API_ERRORS.ALREADY_ANSWERED));
  return Response.json({ accepted: true });
};
