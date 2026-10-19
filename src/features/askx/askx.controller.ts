import type { Server } from "bun";
import { type AllayDeps, runAllay } from "../../agent/allay";
import { admit } from "../billing/gate";
import { silent } from "../chat/chat.events";
import { readJson } from "../../shared/lib/http";
import { logger } from "../../shared/logging/logger";
import { API_ERRORS, type ApiError, ApiFailure, apierror } from "../../shared/types/errors";

interface AskXRequest {
  action?: unknown;
  platform?: unknown;
  user_id?: unknown;
}

const error = (e: ApiError): Response => {
  logger.error(`API Error: ${e.code} - ${e.message}`);
  return Response.json({ error: e.message, code: e.code }, { status: e.statusCode || 500 });
};

/** POST /api/askx, v1: commands for older plugins. Same agent, no game tools. */
export const handleAskX = (deps: AllayDeps) => async (req: Request, server?: Server<undefined>): Promise<Response> => {
  if (req.method !== "POST") return error(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const json = await readJson(req);
  if (!json.ok) return error(json.error);
  const body = (json.body ?? {}) as AskXRequest;
  if (body.platform !== undefined && body.platform !== "minecraft") return error(apierror(API_ERRORS.PLATFORM_NOT_SUPPORTED));
  if (typeof body.action !== "string" || !body.action) {
    return error({ code: "ACTION_REQUIRED", message: "Parameter 'action' is required and must be a string", statusCode: 400 });
  }
  const action = body.action.trim();
  if (!action) return error(apierror(API_ERRORS.EMPTY_ACTION));
  if (action.length > 500) return error(apierror(API_ERRORS.ACTION_TOO_LONG));

  const userId = typeof body.user_id === "string" && body.user_id ? body.user_id : "anonymous";
  const admitted = await admit(deps.billing, req.headers, undefined, server?.requestIP(req)?.address ?? userId);
  if (!admitted.ok) return error(admitted.error.toApiError());
  const { admission } = admitted;
  try {
    const result = await runAllay(
      {
        mode: "askx",
        platform: "minecraft",
        userId,
        message: action,
        tools: [],
        provider: admission.provider,
      },
      deps,
      { runId: crypto.randomUUID(), emit: silent, signal: req.signal, spend: admission.spend, payer: admission.payer },
    );
    return Response.json({
      isSequence: result.commands?.is_sequence ?? false,
      commands: result.commands?.commands ?? [],
      status: "success",
      timestamp: new Date().toISOString(),
      platform: "minecraft",
      user_id: userId,
    });
  } catch (e) {
    return error(e instanceof ApiFailure ? e.toApiError() : apierror(API_ERRORS.AI_REQUEST_FAILED, String(e)));
  } finally {
    admission.release();
  }
};
