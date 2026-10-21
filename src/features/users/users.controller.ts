import type { AllayDeps } from "../../agent/allay";
import { jsonError } from "../../shared/lib/http";
import { logger } from "../../shared/logging/logger";
import { API_ERRORS, ApiFailure, apierror } from "../../shared/types/errors";
import { type Owner, USER_ID } from "../../shared/types/owner";
import { z } from "zod";
import { MAX_MEMORY_CHARS } from "../../infrastructure/memory/memory";
import { identify } from "../auth/caller";
import { erasePlayer, exportPlayer } from "./privacy";
import { MAX_CONSENT_VERSION } from "../../infrastructure/privacy/consents";

type Params = { userId?: string; memoryId?: string };
type Routed = Request & { params?: Params };

const MEMORY_ID = /^[a-z0-9]{1,16}$/;
// The same bounds the remember tool has.
const MemoryBody = z.object({ text: z.string().trim().min(3).max(MAX_MEMORY_CHARS) });
const ConsentBody = z.object({ version: z.number().int().min(1).max(MAX_CONSENT_VERSION) });
const PrivacyBody = z.object({ full: z.boolean() });

const badUser = () => jsonError(apierror(API_ERRORS.BAD_REQUEST, "user_id must be 1–64 letters, digits, - or _"));

const failed = (what: string, error: unknown) => {
  logger.warn(`Couldn't ${what}: ${String(error)}`);
  return jsonError({ code: "STORAGE_ERROR", message: `Couldn't ${what}`, statusCode: 503 });
};

/**
 * The player a request is about, within the caller's tenant: a caller names any player id it likes, but only ever
 * reaches the players of its own server. Without credentials nothing is read, and the answer is the same for players
 * who exist and players who don't.
 */
const ownerOf = async (deps: AllayDeps, req: Routed): Promise<Owner | Response> => {
  const caller = await identify(deps.billing, req);
  if (caller instanceof ApiFailure) return jsonError(caller.toApiError());
  const userId = req.params?.userId;
  if (!userId || !USER_ID.test(userId)) return badUser();
  return { tenant: caller.tenant, userId };
};

const noStore = (body: unknown) => Response.json(body, { headers: { "Cache-Control": "no-store" } });

/** GET a copy of everything kept about the player, DELETE all of it: `/allay privacy export` and `/allay privacy erase`. */
export const handleUser = (deps: AllayDeps) => async (req: Routed): Promise<Response> => {
  if (req.method !== "GET" && req.method !== "DELETE") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const owner = await ownerOf(deps, req);
  if (owner instanceof Response) return owner;
  try {
    if (req.method === "GET") return noStore(await exportPlayer(deps, owner));
    const erased = await erasePlayer(deps, owner);
    logger.info(`Erased a player of ${owner.tenant}: ${erased.memories} memories, ${erased.runs} runs, ${erased.traces} trace spans`);
    return noStore({ erased: true, ...erased });
  } catch (error) {
    return failed(req.method === "GET" ? "export the player's data" : "erase the player's data", error);
  }
};

/**
 * GET /api/v2/users/{user_id}/consent reads whether the player agreed to Allay's notice, PUT records their agreement,
 * DELETE withdraws it: the plugin's buttons before a first question and `/allay privacy withdraw`. Data already kept
 * stays until erased; the plugin asks again before the next question.
 */
export const handleConsent = (deps: AllayDeps) => async (req: Routed): Promise<Response> => {
  if (!["GET", "PUT", "DELETE"].includes(req.method)) return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const owner = await ownerOf(deps, req);
  if (owner instanceof Response) return owner;
  let version: number | undefined;
  if (req.method === "PUT") {
    const body = ConsentBody.safeParse(await req.json().catch(() => undefined));
    if (!body.success) return jsonError(apierror(API_ERRORS.BAD_REQUEST, `version must be a whole number from 1 to ${MAX_CONSENT_VERSION}`));
    version = body.data.version;
  }
  try {
    if (req.method === "GET") return noStore({ consent: await deps.consents.get(owner) });
    if (version !== undefined) return noStore({ consent: await deps.consents.give(owner, version) });
    return noStore({ withdrawn: await deps.consents.withdraw(owner) });
  } catch (error) {
    return failed("reach the consent", error);
  }
};

/** DELETE /api/v2/users/{user_id}/session: `/ask new`. Memories stay. */
export const handleSession = (deps: AllayDeps) => async (req: Routed): Promise<Response> => {
  if (req.method !== "DELETE") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const owner = await ownerOf(deps, req);
  if (owner instanceof Response) return owner;
  try {
    await deps.history.clear(owner);
    return Response.json({ cleared: true });
  } catch (error) {
    return failed("clear the session", error);
  }
};

/** GET lists, POST adds, DELETE wipes /api/v2/users/{user_id}/memories: `/ask memory`, `/ask memory <text>`, and `/ask forget all`. */
export const handleMemories = (deps: AllayDeps) => async (req: Routed): Promise<Response> => {
  if (!["GET", "POST", "DELETE"].includes(req.method)) return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const owner = await ownerOf(deps, req);
  if (owner instanceof Response) return owner;
  let text: string | undefined;
  if (req.method === "POST") {
    const body = MemoryBody.safeParse(await req.json().catch(() => undefined));
    if (!body.success) return jsonError(apierror(API_ERRORS.BAD_REQUEST, `text must be 3–${MAX_MEMORY_CHARS} characters`));
    text = body.data.text;
  }
  try {
    if (req.method === "GET") return noStore({ memories: await deps.memories.list(owner) });
    if (text !== undefined) {
      const saved = await deps.memories.add(owner, text);
      return saved === "full" ? jsonError(apierror(API_ERRORS.MEMORY_FULL)) : Response.json({ memory: saved });
    }
    return Response.json({ deleted: await deps.memories.clear(owner) });
  } catch (error) {
    return failed("reach the memories", error);
  }
};

/** DELETE /api/v2/users/{user_id}/memories/{id}: `/ask forget <n>`. */
export const handleMemory = (deps: AllayDeps) => async (req: Routed): Promise<Response> => {
  if (req.method !== "DELETE") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const owner = await ownerOf(deps, req);
  if (owner instanceof Response) return owner;
  const id = req.params?.memoryId;
  if (!id || !MEMORY_ID.test(id)) return jsonError(apierror(API_ERRORS.MEMORY_NOT_FOUND));
  try {
    if (!(await deps.memories.remove(owner, id))) return jsonError(apierror(API_ERRORS.MEMORY_NOT_FOUND));
    return Response.json({ deleted: 1 });
  } catch (error) {
    return failed("forget the memory", error);
  }
};

/**
 * PUT /api/v2/users/{user_id}/privacy with `{ full }`: the player turned full privacy on or off in the plugin. On, the
 * admin panel forgets their name, UUID, and face at once, and questions that carry `player.private` keep it so. Off
 * changes nothing until their next question names them again. The plugin keeps the switch; the backend keeps no flag.
 */
export const handlePrivacy = (deps: AllayDeps) => async (req: Routed): Promise<Response> => {
  if (req.method !== "PUT") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const owner = await ownerOf(deps, req);
  if (owner instanceof Response) return owner;
  const body = PrivacyBody.safeParse(await req.json().catch(() => undefined));
  if (!body.success) return jsonError(apierror(API_ERRORS.BAD_REQUEST, "full must be true or false"));
  try {
    const forgotten = body.data.full ? ((await deps.players?.forget(owner.tenant, deps.pseudonyms.of(owner.userId))) ?? false) : false;
    return noStore({ full: body.data.full, forgotten });
  } catch (error) {
    return failed("change the player's privacy", error);
  }
};
