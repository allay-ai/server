import { type AllayDeps, runAllay } from "../../agent/allay";
import { identify } from "../auth/caller";
import { admit } from "../billing/gate";
import { silent } from "../chat/chat.events";
import { readJson } from "../../shared/lib/http";
import { logger } from "../../shared/logging/logger";
import { API_ERRORS, type ApiError, ApiFailure, apierror } from "../../shared/types/errors";
import { USER_ID } from "../../shared/types/owner";

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
export const handleAskX = (deps: AllayDeps) => async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return error(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const caller = await identify(deps.billing, req);
  if (caller instanceof ApiFailure) return error(caller.toApiError());
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

  if (body.user_id !== undefined && (typeof body.user_id !== "string" || !USER_ID.test(body.user_id))) {
    return error(apierror(API_ERRORS.BAD_REQUEST, "user_id must be 1–64 letters, digits, - or _"));
  }
  const userId = body.user_id || "anonymous";
  if (await deps.bans.has(caller.tenant, deps.pseudonyms.of(caller.tenant, userId))) return error(apierror(API_ERRORS.PLAYER_BLOCKED));
  const admitted = await admit(deps.billing, req.headers, undefined, caller);
  if (!admitted.ok) return error(admitted.error.toApiError());
  const { admission } = admitted;
  try {
    const result = await runAllay(
      {
        mode: "askx",
        platform: "minecraft",
        tenant: caller.tenant,
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
    return error(e instanceof ApiFailure ? e.toApiError() : apierror(API_ERRORS.AI_REQUEST_FAILED));
  } finally {
    admission.release();
  }
};
