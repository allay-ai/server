import { createHmac } from "node:crypto";

/**
 * What the statistics keep instead of a player's id: `p_` and 20 hex digits of an HMAC of the tenant and the id under a
 * key derived from the backend's secrets key. The same player on one server always gets the same pseudonym, so the
 * panel counts players, but nobody without the key can tell who it is. Since 6.9 the tenant is part of it: the same
 * Minecraft account on two servers is two pseudonyms, so the statistics can't tie a player's servers together.
 * Pseudonymised, not anonymous: with the key and a UUID, the backend finds the player again.
 */
export interface Pseudonyms {
  of(tenant: string, userId: string): string;
}

export const PSEUDONYM = /^p_[0-9a-f]{20}$/;

/** What an erased player's runs keep: numbers that still add up, and nobody to point at. */
export const ERASED = "erased";

export const PSEUDONYM_LABEL = "allay-pseudonym-v1";

export const pseudonymsWith = (key: Buffer | string): Pseudonyms => ({
  of: (tenant, userId) => `p_${createHmac("sha256", key).update(`${tenant}\n${userId}`).digest("hex").slice(0, 20)}`,
});
