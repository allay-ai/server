import type { Server } from "bun";
import { z } from "zod";
import type { AllayDeps } from "../../agent/allay";
import { jsonError } from "../../shared/lib/http";
import { API_ERRORS, ApiFailure, apierror } from "../../shared/types/errors";
import { createLicense, refreshClaim, statusOf, verifyLicense } from "./billing";

const bodySchema = z.object({ name: z.string().max(200).optional() }).catch({});

/** The MOTD the plugin sends, without formatting codes, in one line. */
const nameOf = (name?: string) => name?.replace(/§./g, "").replace(/\s+/g, " ").trim().slice(0, 64) || undefined;

/**
 * POST /api/v2/license makes a license, or a fresh claim code for the one in `Authorization`;
 * GET answers its status. With billing off both say so, and the plugin needs neither.
 */
export const handleLicense = (deps: AllayDeps) => async (req: Request, server?: Server<undefined>): Promise<Response> => {
  const { billing } = deps;
  if (req.method !== "GET" && req.method !== "POST") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  if (!billing.enabled) return Response.json({ billing: false });
  const header = req.headers.get("Authorization");

  if (req.method === "GET") {
    const license = await verifyLicense(billing, header);
    if (license instanceof ApiFailure) return jsonError(license.toApiError());
    return Response.json(await statusOf(billing, license));
  }

  if (!billing.bot.username) return jsonError(apierror(API_ERRORS.BILLING_UNAVAILABLE));
  const name = nameOf(bodySchema.parse(await req.json().catch(() => ({}))).name);
  if (header) {
    const license = await verifyLicense(billing, header);
    if (license instanceof ApiFailure) return jsonError(license.toApiError());
    return Response.json(await refreshClaim(billing, license, name));
  }
  const take = billing.limits.licenses.take(server?.requestIP(req)?.address ?? "unknown", billing.now().getTime());
  if (!take.ok) return jsonError({ ...apierror(API_ERRORS.RATE_LIMITED), retry_after: take.retryAfter });
  take.release();
  return Response.json(await createLicense(billing, name));
};
