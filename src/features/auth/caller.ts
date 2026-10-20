import { timingSafeEqual } from "node:crypto";
import type { Billing } from "../billing/billing";
import { verifyLicense } from "../billing/billing";
import type { LicenseRecord } from "../../infrastructure/billing/licenses";
import { API_ERRORS, ApiFailure, apierror } from "../../shared/types/errors";
import { settings } from "../settings/settings";

/** The tenant of a self-hosted backend: one operator, whose plugins share PLUGIN_TOKEN. */
export const SELF = "self";

/** A hosted server's tenant, the same string `runs.server` has held since 5.7. */
export const licenseTenant = (licenseId: string) => `license:${licenseId}`;

/** Tenants as they may appear in keys and queries: `self` or `license:<id>`, nothing a key or a query could misread. */
export const TENANT = /^(self|license:[A-Za-z0-9]{1,32})$/;

/** Who sent a request: the tenant every piece of player data hangs off, and the license that names it on a hosted backend. */
export interface Caller {
  tenant: string;
  license?: LicenseRecord;
}

/** Self-hosted tokens shorter than this are refused as unset, so nobody runs on a guessable one. */
export const MIN_TOKEN = 24;

const same = (a: string, b: string) => {
  const digest = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest();
  return timingSafeEqual(digest(a), digest(b));
};

const bearerOf = (header: string | null) => header?.match(/^Bearer\s+(\S+)\s*$/)?.[1];

/**
 * Identifies a plugin's request, or says why not. Hosted: the license in `Authorization: Bearer <id>.<secret>`; a server
 * with its own key needs one too, as identity only. Self-hosted: PLUGIN_TOKEN, compared in constant time; without one
 * configured the backend answers nobody rather than everybody.
 */
export const identify = async (billing: Billing, req: Request): Promise<Caller | ApiFailure> => {
  const header = req.headers.get("Authorization");
  if (billing.enabled) {
    if (!header) return new ApiFailure(apierror(API_ERRORS.LICENSE_REQUIRED));
    const license = await verifyLicense(billing, header);
    if (license instanceof ApiFailure) return license;
    return { tenant: licenseTenant(license.id), license };
  }
  const token = settings.get("PLUGIN_TOKEN")?.trim();
  if (!token || token.length < MIN_TOKEN) return new ApiFailure(apierror(API_ERRORS.TOKEN_NOT_SET));
  const given = bearerOf(header);
  if (!given) return new ApiFailure(apierror(API_ERRORS.TOKEN_REQUIRED));
  if (!same(given, token)) return new ApiFailure(apierror(API_ERRORS.TOKEN_INVALID));
  return { tenant: SELF };
};
