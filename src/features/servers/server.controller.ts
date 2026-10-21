import type { Server } from "bun";
import { z } from "zod";
import type { AllayDeps } from "../../agent/allay";
import { clientAddress } from "../../shared/lib/address";
import { jsonError, readJson } from "../../shared/lib/http";
import { logger } from "../../shared/logging/logger";
import { API_ERRORS, ApiFailure, apierror } from "../../shared/types/errors";
import { identify } from "../auth/caller";
import { settings } from "../settings/settings";
import { trustOf } from "../settings/trust";

const optional = (max: number) => z.string().trim().max(max).optional().transform((v) => v || undefined);

/** What the plugin says about its server at start. A bad address or port is dropped, as in a question. */
const ServerBody = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  // Letters of any script, digits, spaces, and . _ ' - ; two to 32 of them.
  name: z
    .string()
    .trim()
    .regex(/^[\p{L}\p{N} ._'-]{2,32}$/u)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  motd: optional(128),
  software: optional(64),
  version: optional(64),
  plugin_version: optional(64),
  address: z.string().trim().regex(/^[A-Za-z0-9.:[\]-]{1,255}$/).optional().catch(undefined),
  port: z.number().int().min(1).max(65_535).optional().catch(undefined),
});

/**
 * PUT /api/v2/server: the plugin registers its server at start (since 6.7), so the admin panel knows its name, MOTD,
 * and address before its first question. A name belongs to one server on the backend: another tenant's name answers
 * `409 NAME_TAKEN`, and the plugin tells its owner to pick another.
 */
export const handleServer = (deps: AllayDeps) => async (req: Request, server?: Server<undefined>): Promise<Response> => {
  if (req.method !== "PUT") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const caller = await identify(deps.billing, req);
  if (caller instanceof ApiFailure) return jsonError(caller.toApiError());
  const json = await readJson(req);
  if (!json.ok) return jsonError(json.error);
  const body = ServerBody.safeParse(json.body);
  if (!body.success) return jsonError(apierror(API_ERRORS.BAD_REQUEST, "id is 1–64 letters, digits, - or _; name is 2–32 letters, digits, spaces, or . _ ' -"));
  if (!deps.servers) return Response.json({ registered: false });
  const { id, ...info } = body.data;
  const defined = Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined));
  try {
    const result = await deps.servers.register({ tenant: caller.tenant, server_id: id, ip: clientAddress(req, server, trustOf(settings)), ...defined }, new Date());
    if (result === "taken") return jsonError({ code: "NAME_TAKEN", message: `Another server on this backend is called “${info.name}”; pick another name`, statusCode: 409 });
    return Response.json({ registered: true, name: info.name ?? null });
  } catch (error) {
    logger.warn(`Couldn't register a server of ${caller.tenant}: ${String(error)}`);
    return jsonError({ code: "STORAGE_ERROR", message: "Couldn't register the server", statusCode: 503 });
  }
};
