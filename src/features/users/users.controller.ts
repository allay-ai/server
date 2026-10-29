import type { AllayDeps } from "../../agent/allay";
import { jsonError } from "../../shared/lib/http";
import { logger } from "../../shared/logging/logger";
import { API_ERRORS, ApiFailure, apierror } from "../../shared/types/errors";
import { type Owner, USER_ID } from "../../shared/types/owner";
import { z } from "zod";
import { MAX_MEMORY_CHARS, type Place } from "../../infrastructure/memory/memory";
import { DIMENSIONS } from "../../agent/agent.types";
import { identify } from "../auth/caller";
import { mayKeep } from "../auth/consent";
import { erasePlayer, exportPlayer, withdrawPlayer } from "./privacy";
import { AGE_BANDS, type Agreement, MAX_CONSENT_VERSION } from "../../infrastructure/privacy/consents";
import { POLICY_REVISION } from "../../shared/policy";
import { settings } from "../settings/settings";

type Params = { userId?: string; memoryId?: string };
type Routed = Request & { params?: Params };

const MEMORY_ID = /^[a-z0-9]{1,16}$/;
// The same bounds the memories tool has; a place since 6.9, from the plugin's note buttons and `/allay memory`.
const PlaceBody = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  dimension: z.enum(DIMENSIONS),
  world: z.string().min(1).max(64).optional(),
});
const MemoryBody = z.object({ text: z.string().trim().min(3).max(MAX_MEMORY_CHARS), place: PlaceBody.optional() });
// hash since 6.9: SHA-256 of the notice the player saw and the policy's revision, hex.
// age_confirmed and age_band since 6.9: the player is old enough to agree where they play, and the group they picked.
const ConsentBody = z.object({
  version: z.number().int().min(1).max(MAX_CONSENT_VERSION),
  hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  age_confirmed: z.boolean().optional(),
  age_band: z.enum(AGE_BANDS).optional(),
});
const PrivacyBody = z.object({ full: z.boolean() });
const ID = z.string().min(1).max(64);
// Since 6.9: what the plugin's death listener reports; ids and names as the game gives them.
const DeathBody = z.object({
  at: z.number().int().positive(),
  world: z.string().min(1).max(64),
  dimension: z.string().regex(/^[a-z0-9_.:/-]{1,64}$/),
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  cause: ID.optional(),
  killer: ID.optional(),
  killer_name: z.string().min(1).max(64).optional(),
  message: z.string().min(1).max(256).optional(),
  level: z.number().int().min(0).max(1_000_000),
  kept_inventory: z.boolean().optional(),
  drops: z.record(ID, z.number().int().min(1).max(1_000_000)).refine((d) => Object.keys(d).length <= 20, "at most 20 kinds").optional(),
  experience: z.number().int().min(0).max(100_000_000).optional(),
  // Since plugin 6.21: kinds beyond the 20 in drops.
  more_drops: z.number().int().min(1).max(100_000).optional(),
});
/** A player's state as the plugin keeps it; the backend checks its shape and size, not what's inside. */
const StateBody = z.object({
  timezone: z.string().min(1).max(64).optional(),
  settings: z.record(z.string().max(64), z.unknown()).optional(),
  goals: z.array(z.unknown()).max(100).optional(),
});
export const MAX_STATE_BYTES = 32 * 1024;

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
 * DELETE withdraws it: the plugin's buttons before a first question and `/allay privacy withdraw`. Since 6.9 a
 * withdrawal also erases what the agreement covered (memories, deaths, state, the session); the plugin asks again
 * before the next question.
 */
export const handleConsent = (deps: AllayDeps) => async (req: Routed): Promise<Response> => {
  if (!["GET", "PUT", "DELETE"].includes(req.method)) return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const owner = await ownerOf(deps, req);
  if (owner instanceof Response) return owner;
  let agreement: Agreement | undefined;
  if (req.method === "PUT") {
    const body = ConsentBody.safeParse(await req.json().catch(() => undefined));
    if (!body.success) return jsonError(apierror(API_ERRORS.BAD_REQUEST, `version must be a whole number from 1 to ${MAX_CONSENT_VERSION}, hash 64 hex digits`));
    agreement = {
      version: body.data.version,
      ...(body.data.hash ? { hash: body.data.hash } : {}),
      ...(body.data.age_confirmed !== undefined ? { age_confirmed: body.data.age_confirmed } : {}),
      ...(body.data.age_band ? { age_band: body.data.age_band } : {}),
      revision: POLICY_REVISION,
    };
  }
  try {
    // The current revision comes along, so the plugin can hash the notice it would show now and compare.
    if (req.method === "GET") return noStore({ consent: await deps.consents.get(owner), revision: POLICY_REVISION });
    if (agreement) return noStore({ consent: await deps.consents.give(owner, agreement), revision: POLICY_REVISION });
    // Withdrawing takes away what the agreement covered; the record stays, marked, as proof.
    return noStore(await withdrawPlayer(deps, owner));
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

/** GET lists, POST adds, DELETE wipes /api/v2/users/{user_id}/memories: `/allay memory`, `/allay memory <text>`, note buttons, and `/allay forget all`. */
export const handleMemories = (deps: AllayDeps) => async (req: Routed): Promise<Response> => {
  if (!["GET", "POST", "DELETE"].includes(req.method)) return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const owner = await ownerOf(deps, req);
  if (owner instanceof Response) return owner;
  let text: string | undefined;
  let place: Place | undefined;
  if (req.method === "POST") {
    const body = MemoryBody.safeParse(await req.json().catch(() => undefined));
    if (!body.success) return jsonError(apierror(API_ERRORS.BAD_REQUEST, `text must be 3–${MAX_MEMORY_CHARS} characters, and a place x, y, z, dimension`));
    text = body.data.text;
    place = body.data.place;
  }
  try {
    if (req.method === "GET") return noStore({ memories: await deps.memories.list(owner) });
    if (text !== undefined) {
      if (!(await mayKeep(deps, owner.tenant, owner.userId))) return jsonError(apierror(API_ERRORS.CONSENT_REQUIRED));
      const saved = await deps.memories.add(owner, text, place);
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
    const forgotten = body.data.full ? ((await deps.players?.forget(owner.tenant, deps.pseudonyms.of(owner.tenant, owner.userId))) ?? false) : false;
    return noStore({ full: body.data.full, forgotten });
  } catch (error) {
    return failed("change the player's privacy", error);
  }
};

/** POST /api/v2/users/{user_id}/deaths: the plugin reports a death as it happens; the newest DEATHS_MAX stay, sealed. */
export const handleDeaths = (deps: AllayDeps) => async (req: Routed): Promise<Response> => {
  if (req.method !== "POST") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const owner = await ownerOf(deps, req);
  if (owner instanceof Response) return owner;
  const body = DeathBody.safeParse(await req.json().catch(() => undefined));
  if (!body.success) return jsonError(apierror(API_ERRORS.BAD_REQUEST, `${body.error.issues[0]?.path.join(".") || "body"}: ${body.error.issues[0]?.message}`));
  // A clock far ahead would keep one death on top forever.
  if (body.data.at > Date.now() + 86_400_000) return jsonError(apierror(API_ERRORS.BAD_REQUEST, "at: in the future"));
  try {
    if (!(await mayKeep(deps, owner.tenant, owner.userId))) return jsonError(apierror(API_ERRORS.CONSENT_REQUIRED));
    await deps.deaths.add(owner, body.data);
    return Response.json({ saved: true });
  } catch (error) {
    return failed("keep the death", error);
  }
};

/** GET and PUT /api/v2/users/{user_id}/state: the player's time zone, settings, and goals, replaced whole. */
export const handleState = (deps: AllayDeps) => async (req: Routed): Promise<Response> => {
  if (req.method !== "GET" && req.method !== "PUT") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const owner = await ownerOf(deps, req);
  if (owner instanceof Response) return owner;
  try {
    if (req.method === "GET") {
      const stored = await deps.states.get(owner);
      return noStore({ state: stored?.state ?? null, updated_at: stored?.updated_at ?? null });
    }
    const raw = await req.text();
    if (raw.length > MAX_STATE_BYTES) return jsonError(apierror(API_ERRORS.BAD_REQUEST, `state: at most ${MAX_STATE_BYTES} bytes`));
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return jsonError(apierror(API_ERRORS.BAD_REQUEST, "state: not JSON"));
    }
    const body = StateBody.safeParse(json);
    if (!body.success) return jsonError(apierror(API_ERRORS.BAD_REQUEST, `${body.error.issues[0]?.path.join(".") || "state"}: ${body.error.issues[0]?.message}`));
    if (!(await mayKeep(deps, owner.tenant, owner.userId))) return jsonError(apierror(API_ERRORS.CONSENT_REQUIRED));
    const stored = await deps.states.put(owner, body.data);
    return noStore({ state: stored.state, updated_at: stored.updated_at });
  } catch (error) {
    return failed("reach the player's state", error);
  }
};

/** The address links to a player's copy start with: where people reach this backend in a browser. */
const publicBase = () => String(settings.get("PUBLIC_URL") || settings.get("API_URL")).replace(/\/+$/, "");

/** POST /api/v2/users/{user_id}/export: a link to everything kept about the player, good for a day. */
export const handleExport = (deps: AllayDeps) => async (req: Routed): Promise<Response> => {
  if (req.method !== "POST") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const owner = await ownerOf(deps, req);
  if (owner instanceof Response) return owner;
  try {
    const issued = await deps.exports.issue(owner);
    return noStore({ url: `${publicBase()}/api/v2/exports/${issued.token}`, expires_at: issued.expires_at });
  } catch (error) {
    return failed("make the export link", error);
  }
};

/**
 * GET /api/v2/exports/{token}: the player's copy as a JSON file. The token is the key, so the route takes no
 * credentials; a wrong, expired, or erased one is 404, the same for each.
 */
export const handleExportDownload = (deps: AllayDeps) => async (req: Request & { params?: { token?: string } }): Promise<Response> => {
  if (req.method !== "GET") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const notFound = () => jsonError({ code: "NOT_FOUND", message: "This link expired or never existed", statusCode: 404 });
  try {
    const owner = await deps.exports.redeem(req.params?.token ?? "");
    if (!owner) return notFound();
    const copy = await exportPlayer(deps, owner);
    return new Response(JSON.stringify(copy, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="allay-${owner.userId}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return failed("build the export", error);
  }
};
