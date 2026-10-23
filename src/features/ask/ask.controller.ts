import { type AllayDeps, runAllay } from "../../agent/allay";
import { identify } from "../auth/caller";
import { mayKeep } from "../auth/consent";
import { admit } from "../billing/gate";
import { soloRefusal } from "../billing/solo";
import { silent } from "../chat/chat.events";
import { readJson } from "../../shared/lib/http";
import { logger } from "../../shared/logging/logger";
import { API_ERRORS, type ApiError, ApiFailure, apierror } from "../../shared/types/errors";
import { USER_ID } from "../../shared/types/owner";

interface AskRequest {
  question?: unknown;
  platform?: unknown;
  user_id?: unknown;
}

const error = (e: ApiError): Response => {
  logger.error(`API Error: ${e.code} - ${e.message}`);
  return Response.json(
    { error: e.message, code: e.code, status: "error", timestamp: new Date().toISOString() },
    { status: e.statusCode || 500 },
  );
};

/** POST /api/ask, v1: the Telegram bot and older plugins. Same agent, no game tools, one JSON answer. */
export const handleAsk = (deps: AllayDeps) => async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return error(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const caller = await identify(deps.billing, req);
  if (caller instanceof ApiFailure) return error(caller.toApiError());
  const json = await readJson(req);
  if (!json.ok) return error(json.error);
  const body = (json.body ?? {}) as AskRequest;
  if (typeof body.question !== "string" || !body.question) {
    return error({ code: "QUESTION_REQUIRED", message: "Parameter 'question' is required and must be a string", statusCode: 400 });
  }
  const question = body.question.trim();
  if (!question) return error(apierror(API_ERRORS.EMPTY_QUESTION));
  if (question.length > 1000) return error(apierror(API_ERRORS.QUESTION_TOO_LONG));

  const platform = typeof body.platform === "string" ? body.platform : "unknown";
  if (body.user_id !== undefined && (typeof body.user_id !== "string" || !USER_ID.test(body.user_id))) {
    return error(apierror(API_ERRORS.BAD_REQUEST, "user_id must be 1–64 letters, digits, - or _"));
  }
  const userId = body.user_id || "anonymous";
  if (await deps.bans.has(caller.tenant, deps.pseudonyms.of(caller.tenant, userId))) return error(apierror(API_ERRORS.PLAYER_BLOCKED));
  if (!(await mayKeep(deps, caller.tenant, userId))) return error(apierror(API_ERRORS.CONSENT_REQUIRED));
  const solo = await soloRefusal(deps.billing, deps.pseudonyms, caller, userId);
  if (solo) return error(solo.toApiError());
  const admitted = await admit(deps.billing, req.headers, undefined, caller);
  if (!admitted.ok) return error(admitted.error.toApiError());
  const { admission } = admitted;
  try {
    const result = await runAllay(
      {
        mode: "ask",
        platform: platform === "telegram" ? "telegram" : "minecraft",
        tenant: caller.tenant,
        userId,
        message: question,
        tools: [],
        provider: admission.provider,
      },
      deps,
      { runId: crypto.randomUUID(), emit: silent, signal: req.signal, spend: admission.spend, payer: admission.payer },
    );
    return Response.json({
      answer: result.answer,
      status: "success",
      timestamp: new Date().toISOString(),
      platform,
      user_id: userId,
    });
  } catch (e) {
    return error(e instanceof ApiFailure ? e.toApiError() : apierror(API_ERRORS.AI_REQUEST_FAILED));
  } finally {
    admission.release();
  }
};
