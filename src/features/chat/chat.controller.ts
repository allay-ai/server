import type { Server } from "bun";
import { type AllayDeps, runAllay } from "../../agent/allay";
import { jsonError, readJson } from "../../shared/lib/http";
import { logger } from "../../shared/logging/logger";
import { API_ERRORS, ApiFailure, apierror } from "../../shared/types/errors";
import { identify } from "../auth/caller";
import { admit, payer } from "../billing/gate";
import { settings } from "../settings/settings";
import { trustOf } from "../settings/trust";
import { clientAddress } from "../../shared/lib/address";
import { parseChatRequest, toolAnswerSchema } from "./chat.types";
import { sseResponse } from "./chat.sse";

/** POST /api/v2/chat: one question, streamed back as events while the agent works. */
export const handleChat = (deps: AllayDeps) => async (req: Request, server?: Server<undefined>): Promise<Response> => {
  if (req.method !== "POST") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const caller = await identify(deps.billing, req);
  if (caller instanceof ApiFailure) return jsonError(caller.toApiError());
  const json = await readJson(req);
  if (!json.ok) return jsonError(json.error);
  const parsed = parseChatRequest(json.body, caller.tenant);
  if (!parsed.ok) return jsonError(parsed.error);
  // A blocked player is refused before anything is paid for or kept.
  if (await deps.bans.has(caller.tenant, deps.pseudonyms.of(parsed.context.userId))) return jsonError(apierror(API_ERRORS.PLAYER_BLOCKED));
  if (deps.bridge.active >= settings.get("MAX_ACTIVE_RUNS")) {
    return jsonError({ code: "QUEUE_ERROR", message: "Too many questions at once; try again in a minute", statusCode: 503 });
  }
  const admitted = await admit(deps.billing, req.headers, parsed.provider, caller);
  if (!admitted.ok) return jsonError(admitted.error.toApiError());
  const { admission } = admitted;
  // Where the server connects from and what it runs, for the panel; never in the log.
  const info = parsed.context.server;
  deps.servers
    ?.seen(
      {
        tenant: caller.tenant,
        server_id: info?.id ?? "",
        ip: clientAddress(req, server, trustOf(settings)),
        ...(info?.address ? { address: info.address } : {}),
        ...(info?.port ? { port: info.port } : {}),
        ...(info?.software ? { software: info.software } : {}),
        ...(info?.version ? { version: info.version } : {}),
        ...(info?.plugin_version ? { plugin_version: info.plugin_version } : {}),
      },
      new Date(),
    )
    .catch((error) => logger.warn(`Couldn't note a server of ${caller.tenant}: ${String(error)}`));

  // Runs outlast Bun's idle timeout while the model thinks; pings keep proxies happy instead.
  server?.timeout(req, 0);
  const runId = crypto.randomUUID();
  const context = { ...parsed.context, provider: admission.provider, model: admission.model };
  // Who asked stays out of the log: the run id ties it to the statistics, which know the player only by pseudonym.
  logger.info(`Run ${runId}: ${context.mode}${context.task ? ` ${context.task.id}` : ""} on ${caller.tenant}, tools: ${context.tools.length}, on ${payer(admission)}`);

  return sseResponse(async (emit, signal) => {
    deps.bridge.open(runId, emit, caller.tenant);
    try {
      await runAllay(context, deps, { runId, emit, signal, spend: admission.spend, payer: admission.payer });
    } finally {
      deps.bridge.close(runId);
      admission.release();
    }
  }, req.signal);
};

type Params = { runId: string; callId: string };

/** POST /api/v2/chat/{run_id}/tools/{call_id}: the plugin's answer to a tool call, accepted only from the run's own tenant. */
export const handleToolResult = (deps: AllayDeps) => async (req: Request & { params?: Params }): Promise<Response> => {
  if (req.method !== "POST") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const caller = await identify(deps.billing, req);
  if (caller instanceof ApiFailure) return jsonError(caller.toApiError());
  const { runId, callId } = req.params ?? ({} as Params);
  const json = await readJson(req);
  if (!json.ok) return jsonError(json.error);
  const answer = toolAnswerSchema.safeParse(json.body);
  if (!answer.success) return jsonError(apierror(API_ERRORS.BAD_REQUEST, "send { ok: true, result } or { ok: false, error }"));
  // Another tenant's run answers as unknown, so its existence doesn't leak either.
  const status = deps.bridge.answer(runId, callId, caller.tenant, answer.data);
  if (status === 404) return jsonError(apierror(API_ERRORS.RUN_NOT_FOUND));
  if (status === 409) return jsonError(apierror(API_ERRORS.ALREADY_ANSWERED));
  return Response.json({ accepted: true });
};
