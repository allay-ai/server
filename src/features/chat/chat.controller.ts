import type { Server } from "bun";
import { type AllayDeps, runAllay } from "../../agent/allay";
import { jsonError, readJson } from "../../shared/lib/http";
import { logger } from "../../shared/logging/logger";
import { API_ERRORS, type ApiError, ApiFailure, apierror } from "../../shared/types/errors";
import { event, signals } from "../../infrastructure/telemetry/signals";
import { identify } from "../auth/caller";
import { mayKeep } from "../auth/consent";
import { admit, payer } from "../billing/gate";
import { soloRefusal } from "../billing/solo";
import { settings } from "../settings/settings";
import { trustOf } from "../settings/trust";
import { clientAddress } from "../../shared/lib/address";
import { parseChatRequest, toolAnswerSchema } from "./chat.types";
import { sseResponse } from "./chat.sse";
import { type LiveRun, lastEventId, liveResponse } from "./chat.live";

/** Answers a question refused before it ran, and counts it by code for the server that asked. */
const refusing = (tenant: string, serverId: string | undefined, player: string) => (error: ApiError) => {
  signals().instruments.refusals.add(1, { code: error.code, tenant, server_id: serverId ?? "" });
  event("allay.gate.refused", { code: error.code, "allay.tenant": tenant, "allay.player": player, ...(serverId ? { "allay.server.id": serverId } : {}) });
  return jsonError(error);
};

/** Streams [run] on from the plugin's `Last-Event-ID`, or says it went on too far for that. */
const readOn = (run: LiveRun, req: Request, server?: Server<undefined>): Response => {
  const after = lastEventId(req);
  if (!run.resumable(after)) return jsonError(apierror(API_ERRORS.RUN_GONE));
  server?.timeout(req, 0);
  return liveResponse(run, after, req.signal);
};

/** POST /api/v2/chat: one question, streamed back as events while the agent works. */
export const handleChat = (deps: AllayDeps) => async (req: Request, server?: Server<undefined>): Promise<Response> => {
  if (req.method !== "POST") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const caller = await identify(deps.billing, req);
  if (caller instanceof ApiFailure) return jsonError(caller.toApiError());
  const json = await readJson(req);
  if (!json.ok) return jsonError(json.error);
  const parsed = parseChatRequest(json.body, caller.tenant);
  if (!parsed.ok) return jsonError(parsed.error);
  // The same question again after a dropped connection: it reads on in the run it started, which never runs or pays twice.
  const running = parsed.requestId ? deps.live.byRequest(caller.tenant, parsed.requestId) : undefined;
  if (running) return readOn(running, req, server);
  const refuse = refusing(caller.tenant, parsed.context.server?.id, deps.pseudonyms.of(caller.tenant, parsed.context.userId));
  // A blocked player is refused before anything is paid for or kept.
  if (await deps.bans.has(caller.tenant, deps.pseudonyms.of(caller.tenant, parsed.context.userId))) return refuse(apierror(API_ERRORS.PLAYER_BLOCKED));
  // So is a player who hasn't agreed, on a hosted backend: nothing runs, is traced, or is kept.
  if (!(await mayKeep(deps, caller.tenant, parsed.context.userId))) return refuse(apierror(API_ERRORS.CONSENT_REQUIRED));
  // A Solo license answers its own player only.
  const solo = await soloRefusal(deps.billing, deps.pseudonyms, caller, parsed.context.userId);
  if (solo) return refuse(solo.toApiError());
  if (deps.bridge.active >= settings.get("MAX_ACTIVE_RUNS")) {
    return refuse({ code: "QUEUE_ERROR", message: "Too many questions at once; try again in a minute", statusCode: 503 });
  }
  const admitted = await admit(deps.billing, req.headers, parsed.provider, caller);
  if (!admitted.ok) return refuse(admitted.error.toApiError());
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
        ...(info?.loader ? { loader: info.loader } : {}),
        ...(info?.side ? { side: info.side } : {}),
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

  if (parsed.requestId) {
    const requestId = parsed.requestId;
    const live = deps.live.start(runId, caller.tenant, requestId, { detached: () => deps.bridge.hold(runId), attached: () => deps.bridge.release(runId) });
    deps.bridge.open(runId, live.emit, caller.tenant);
    signals().instruments.streams.add(1);
    runAllay(context, deps, { runId, emit: live.emit, signal: live.abort.signal, spend: admission.spend, payer: admission.payer })
      .catch(() => {
        // The run already sent its error event.
      })
      .finally(() => {
        signals().instruments.streams.add(-1);
        deps.bridge.close(runId);
        admission.release();
        deps.live.finish(live, requestId);
      });
    return liveResponse(live, 0, req.signal);
  }

  // A plugin before 6.35 sends no request_id: its run stops with its connection, as it always did.
  return sseResponse(async (emit, signal) => {
    deps.bridge.open(runId, emit, caller.tenant);
    signals().instruments.streams.add(1);
    try {
      await runAllay(context, deps, { runId, emit, signal, spend: admission.spend, payer: admission.payer });
    } finally {
      signals().instruments.streams.add(-1);
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

type RunParams = { runId: string };

/** GET /api/v2/chat/{run_id}/events: a run read on after the plugin's connection dropped, from after its `Last-Event-ID`. */
export const handleRunEvents = (deps: AllayDeps) => async (req: Request & { params?: RunParams }, server?: Server<undefined>): Promise<Response> => {
  if (req.method !== "GET") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const caller = await identify(deps.billing, req);
  if (caller instanceof ApiFailure) return jsonError(caller.toApiError());
  const run = deps.live.get(req.params?.runId ?? "", caller.tenant);
  if (!run) return jsonError(apierror(API_ERRORS.RUN_NOT_FOUND));
  return readOn(run, req, server);
};

/** DELETE /api/v2/chat/{run_id}: the player cancelled, so the run stops now instead of waiting for a plugin that won't read on. */
export const handleRun = (deps: AllayDeps) => async (req: Request & { params?: RunParams }): Promise<Response> => {
  if (req.method !== "DELETE") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const caller = await identify(deps.billing, req);
  if (caller instanceof ApiFailure) return jsonError(caller.toApiError());
  const run = deps.live.get(req.params?.runId ?? "", caller.tenant);
  if (!run) return jsonError(apierror(API_ERRORS.RUN_NOT_FOUND));
  run.abort.abort();
  return Response.json({ cancelled: true });
};
