import type { Server } from "bun";
import { z } from "zod";
import type { AllayDeps } from "../../agent/allay";
import { jsonError } from "../../shared/lib/http";
import { API_ERRORS, ApiFailure, apierror } from "../../shared/types/errors";
import { createLicense, refreshClaim, statusOf, verifyLicense } from "./billing";
import { clientAddress, rateKey } from "../../shared/lib/address";
import { settings } from "../settings/settings";
import { trustOf } from "../settings/trust";
import { licenseTenant } from "../auth/caller";

const bodySchema = z.object({ name: z.string().max(200).optional() }).catch({});

/** The MOTD the plugin sends, without formatting codes, in one line. */
const nameOf = (name?: string) => name?.replace(/§./g, "").replace(/\s+/g, " ").trim().slice(0, 64) || undefined;

/**
 * POST /api/v2/license makes a license, or a fresh claim code for the one in `Authorization`; GET answers its status.
 * A new license is free: it identifies a server, and pays only once someone pays for it. With billing off both say
 * so, and the plugin needs neither.
 */
export const handleLicense = (deps: AllayDeps) => async (req: Request, server?: Server<undefined>): Promise<Response> => {
  const { billing } = deps;
  if (req.method !== "GET" && req.method !== "POST") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  if (!billing.enabled) return Response.json({ billing: false });
  const header = req.headers.get("Authorization");

  if (req.method === "GET") {
    if (!header) return jsonError(apierror(API_ERRORS.LICENSE_REQUIRED));
    const license = await verifyLicense(billing, header);
    if (license instanceof ApiFailure) return jsonError(license.toApiError());
    return Response.json(await statusOf(billing, license));
  }

  if (!billing.bot.username) return jsonError(apierror(API_ERRORS.BILLING_UNAVAILABLE));
  const name = nameOf(bodySchema.parse(await req.json().catch(() => ({}))).name);
  if (header) {
    const license = await verifyLicense(billing, header);
    if (license instanceof ApiFailure) return jsonError(license.toApiError());
    // A name a server registered beats what /allay link sends, which older plugins take from the MOTD.
    const registered = (await deps.servers?.list(licenseTenant(license.id)))?.find((s) => s.name)?.name;
    return Response.json(await refreshClaim(billing, license, registered ?? name));
  }
  // Behind a proxy the peer is the proxy, so the client's own address comes from it, and only from a trusted one.
  const now = billing.now().getTime();
  const take = billing.limits.licenses.take(rateKey(clientAddress(req, server, trustOf(settings))), now);
  if (!take.ok) return jsonError({ ...apierror(API_ERRORS.RATE_LIMITED), retry_after: take.retryAfter });
  take.release();
  const total = billing.limits.licensesTotal.take("all", now);
  if (!total.ok) return jsonError({ ...apierror(API_ERRORS.RATE_LIMITED), retry_after: total.retryAfter });
  total.release();
  return Response.json(await createLicense(billing, name));
};
