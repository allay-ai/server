import { createHmac } from "node:crypto";

/**
 * What the statistics keep instead of a player's id: `p_` and 20 hex digits of an HMAC under a key derived from the
 * backend's secrets key. The same player always gets the same pseudonym, so the panel counts players, but nobody
 * without the key can tell who it is, and a player's id can't be looked up in `runs` without the backend's help.
 */
export interface Pseudonyms {
  of(userId: string): string;
}

export const PSEUDONYM = /^p_[0-9a-f]{20}$/;

/** What an erased player's runs keep: numbers that still add up, and nobody to point at. */
export const ERASED = "erased";

export const PSEUDONYM_LABEL = "allay-pseudonym-v1";

export const pseudonymsWith = (key: Buffer | string): Pseudonyms => ({
  of: (userId) => `p_${createHmac("sha256", key).update(userId).digest("hex").slice(0, 20)}`,
});
