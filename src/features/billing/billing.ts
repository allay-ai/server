import { timingSafeEqual } from "node:crypto";
import type { LicenseRecord, LicenseStore } from "../../infrastructure/billing/licenses";
import type { TelegramApi } from "../telegram/telegram.client";
import { logger } from "../../shared/logging/logger";
import { API_ERRORS, ApiFailure, apierror } from "../../shared/types/errors";
import type { Net } from "./byok";
import { Limiter, byokLimiter, byokTotalLimiter, hostedLimiter, licenseLimiter, licenseTotalLimiter } from "./limits";
import { type Quota, allocate, quotaOf } from "./plans";

/** Everything billing needs; production builds it from the environment, tests from fakes. */
export interface Billing {
  /** Off on self-hosted backends (SELFHOSTED=1): everyone runs on the backend's key, nobody needs a license. */
  enabled: boolean;
  licenses: LicenseStore;
  net: Net;
  /** The Telegram bot that takes payments; its username is known once it has started, and nothing is set without a bot. */
  bot: {
    username?: string;
    api?: TelegramApi;
    /** What Telegram must send in X-Telegram-Bot-Api-Secret-Token with every webhook call. */
    secret?: string;
    /** Telegram user ids allowed to /refund. */
    admins: number[];
  };
  /** Per tenant, except the totals: `byokTotal` and `licensesTotal` count everyone under the key "all". */
  limits: { byok: Limiter; byokTotal: Limiter; hosted: Limiter; licenses: Limiter; licensesTotal: Limiter };
  now: () => Date;
}

export const newLimits = () => ({
  byok: byokLimiter(),
  byokTotal: byokTotalLimiter(),
  hosted: hostedLimiter(),
  licenses: licenseLimiter(),
  licensesTotal: licenseTotalLimiter(),
});

export const selfHosted = () => ["1", "true", "yes"].includes((process.env.SELFHOSTED || "").toLowerCase());

export const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const random = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

const CLAIM_TTL = 24 * 3_600_000;

export interface Claim {
  claim_code: string;
  pay_url: string;
  claim_expires_at: string;
}

const newClaim = async (billing: Billing, licenseId: string): Promise<Claim> => {
  const code = random(12);
  const expires = new Date(billing.now().getTime() + CLAIM_TTL);
  await billing.licenses.update(licenseId, { claim_hash: sha256(code), claim_expires: expires });
  return { claim_code: code, pay_url: `https://t.me/${billing.bot.username}?start=${code}`, claim_expires_at: expires.toISOString() };
};

/** A new license: `<id>.<secret>`, where only the secret's digest is kept. */
export const createLicense = async (billing: Billing, name?: string): Promise<{ license: string; license_id: string } & Claim> => {
  const id = random(9).replace(/[-_]/g, "x");
  const secret = random(32);
  await billing.licenses.create({ id, secret_hash: sha256(secret), name, created_at: billing.now(), renews: false });
  logger.info(`License ${id} created`);
  return { license: `${id}.${secret}`, license_id: id, ...(await newClaim(billing, id)) };
};

export const refreshClaim = async (billing: Billing, license: LicenseRecord, name?: string) => {
  if (name && name !== license.name) await billing.licenses.update(license.id, { name });
  return { license_id: license.id, ...(await newClaim(billing, license.id)) };
};

/** How the bot names a server: the name the plugin sent, or the license id. */
export const serverName = (license: LicenseRecord) => license.name || license.id;

/** The license an `Authorization: Bearer <id>.<secret>` header names, or why not. */
export const verifyLicense = async (billing: Billing, header: string | null): Promise<LicenseRecord | ApiFailure> => {
  const match = header?.match(/^Bearer\s+([A-Za-z0-9]+)\.([A-Za-z0-9_-]+)\s*$/);
  if (!match) return new ApiFailure(apierror(header ? API_ERRORS.LICENSE_INVALID : API_ERRORS.LICENSE_REQUIRED));
  const license = await billing.licenses.get(match[1]);
  const given = Buffer.from(sha256(match[2]));
  const kept = Buffer.from(license?.secret_hash ?? "0".repeat(64));
  // Compare even when the id is unknown, so timing doesn't tell which ids exist.
  // A revoked key reads as unknown, which the plugin already answers with “delete license.key and /allay link”.
  if (!timingSafeEqual(given, kept) || !license || license.revoked_at) return new ApiFailure(apierror(API_ERRORS.LICENSE_INVALID));
  return license;
};

export const quotaFor = async (billing: Billing, license: LicenseRecord): Promise<Quota> =>
  quotaOf(await billing.licenses.grants(license.id), billing.now());

/** The status `GET /api/v2/license` answers and the bot shows. */
export const statusOf = async (billing: Billing, license: LicenseRecord) => {
  const quota = await quotaFor(billing, license);
  return {
    billing: true,
    license_id: license.id,
    linked: license.telegram_user_id !== undefined,
    active: quota.active && !license.blocked_at,
    plan: license.plan ?? null,
    paid_until: quota.paidUntil?.toISOString() ?? null,
    renews: license.renews && quota.active,
    quota: { used_percent: quota.usedPercent, resets_at: quota.resetsAt?.toISOString() ?? null },
    last_payment_at: license.last_payment_at?.toISOString() ?? null,
  };
};

/** Why a license can't ask now, or nothing when it can. */
export const refusal = (quota: Quota): ApiFailure | undefined => {
  if (!quota.active) return new ApiFailure(apierror(API_ERRORS.SUBSCRIPTION_INACTIVE));
  if (quota.remaining <= 0) {
    return new ApiFailure({ ...apierror(API_ERRORS.QUOTA_EXCEEDED), ...(quota.resetsAt ? { resets_at: quota.resetsAt.toISOString() } : {}) });
  }
  return undefined;
};

/** Charges what a run cost to the license's open windows. */
export const charge = async (billing: Billing, licenseId: string, usd: number) => {
  try {
    const grants = await billing.licenses.grants(licenseId);
    for (const part of allocate(grants, usd, billing.now())) await billing.licenses.charge(part.grant, part.usd);
  } catch (error) {
    logger.error(`Couldn't charge license ${licenseId} $${usd}: ${String(error)}`);
  }
};
