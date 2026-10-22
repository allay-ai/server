import { ConsentModel } from "../../entities/consent/consent.model";
import type { Owner } from "../../shared/types/owner";

/** The age group a player picked before agreeing (since plugin 6.7, which asks everyone). */
export const AGE_BANDS = ["under_13", "13", "14_15", "16_17", "18_plus"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export interface Consent {
  version: number;
  /** Since 6.9: what the plugin hashed the notice and the policy's revision to; absent for older agreements. */
  hash?: string;
  revision?: string;
  /** Since 6.9: the player is old enough to agree where they play; false when they weren't asked or before 6.9. */
  age_confirmed: boolean;
  /** Since 6.9: the age group they picked, when the plugin sent it. */
  age_band?: AgeBand;
  accepted_at: string;
  /** Since 6.9: when the player took it back; the record stays as proof of what the data rested on. */
  withdrawn_at?: string;
}

/** What a player agrees to: the notice's version, and since 6.9 its hash, the policy's revision, and their age. */
export interface Agreement {
  version: number;
  hash?: string;
  revision?: string;
  age_confirmed?: boolean;
  age_band?: AgeBand;
}

/**
 * Who agreed to what, per player and tenant. The plugin asks a player before their first question and keeps the answer
 * here. A withdrawal keeps the record, marked, as proof of what the data rested on until the player's records go;
 * erasure removes it, and it goes by itself CONSENT_DAYS after the player's last question.
 */
export interface ConsentStore {
  /** The agreement in force: null when there's none or it was withdrawn. */
  get(owner: Owner): Promise<Consent | null>;
  /** The record whatever its state, withdrawn ones included, for the player's copy of what's kept. */
  record(owner: Owner): Promise<Consent | null>;
  /** Records the agreement, replacing an older one or a withdrawal. */
  give(owner: Owner, agreement: Agreement): Promise<Consent>;
  /** Marks the agreement withdrawn; whether there was one in force. */
  withdraw(owner: Owner): Promise<boolean>;
  /** Removes the record whole, for an erasure. */
  erase(owner: Owner): Promise<void>;
  /** The player just asked: the agreement lives another CONSENT_DAYS. */
  touch(owner: Owner): Promise<void>;
  /** The ids of every player with a record on [tenant]: since 6.1 that's everyone who asked there. */
  users(tenant: string): Promise<string[]>;
}

export const MAX_CONSENT_VERSION = 1000;

const query = (owner: Owner) => ({ tenant: owner.tenant, user_id: owner.userId });

type Stored = { version: number; hash?: string; revision?: string; age_confirmed?: boolean; age_band?: AgeBand; accepted_at: Date; withdrawn_at?: Date };

const consentOf = (doc: Stored): Consent => ({
  version: doc.version,
  ...(doc.hash ? { hash: doc.hash } : {}),
  ...(doc.revision ? { revision: doc.revision } : {}),
  age_confirmed: doc.age_confirmed ?? false,
  ...(doc.age_band ? { age_band: doc.age_band } : {}),
  accepted_at: doc.accepted_at.toISOString(),
  ...(doc.withdrawn_at ? { withdrawn_at: doc.withdrawn_at.toISOString() } : {}),
});

const inForce = (consent: Consent | null) => (consent && !consent.withdrawn_at ? consent : null);

export const mongoConsents: ConsentStore = {
  async get(owner) {
    return inForce(await mongoConsents.record(owner));
  },
  async record(owner) {
    const doc = await ConsentModel.findOne(query(owner)).lean<Stored>();
    return doc ? consentOf(doc) : null;
  },
  async give(owner, agreement) {
    const accepted_at = new Date();
    const fields = {
      version: agreement.version,
      accepted_at,
      seen_at: accepted_at,
      ...(agreement.hash ? { hash: agreement.hash } : {}),
      ...(agreement.revision ? { revision: agreement.revision } : {}),
      ...(agreement.age_confirmed !== undefined ? { age_confirmed: agreement.age_confirmed } : {}),
      ...(agreement.age_band ? { age_band: agreement.age_band } : {}),
    };
    // A new agreement replaces the old one whole: nothing from before stays behind it, a withdrawal included.
    const unset = {
      withdrawn_at: "",
      ...(agreement.hash ? {} : { hash: "" }),
      ...(agreement.revision ? {} : { revision: "" }),
      ...(agreement.age_confirmed !== undefined ? {} : { age_confirmed: "" }),
      ...(agreement.age_band ? {} : { age_band: "" }),
    };
    await ConsentModel.updateOne(query(owner), { $set: fields, $unset: unset }, { upsert: true });
    return consentOf(fields);
  },
  async withdraw(owner) {
    const result = await ConsentModel.updateOne({ ...query(owner), withdrawn_at: { $exists: false } }, { $set: { withdrawn_at: new Date() } });
    return result.modifiedCount > 0;
  },
  async erase(owner) {
    await ConsentModel.deleteOne(query(owner));
  },
  async touch(owner) {
    await ConsentModel.updateOne(query(owner), { $set: { seen_at: new Date() } });
  },
  async users(tenant) {
    return ConsentModel.distinct("user_id", { tenant });
  },
};

/** For tests and local runs without MongoDB. */
export const memoryConsents = (): ConsentStore => {
  const store = new Map<string, Consent>();
  const at = (owner: Owner) => `${owner.tenant}\n${owner.userId}`;
  return {
    async get(owner) {
      return inForce(store.get(at(owner)) ?? null);
    },
    async record(owner) {
      return store.get(at(owner)) ?? null;
    },
    async give(owner, agreement) {
      const consent = consentOf({ ...agreement, accepted_at: new Date() });
      store.set(at(owner), consent);
      return consent;
    },
    async withdraw(owner) {
      const consent = store.get(at(owner));
      if (!consent || consent.withdrawn_at) return false;
      store.set(at(owner), { ...consent, withdrawn_at: new Date().toISOString() });
      return true;
    },
    async erase(owner) {
      store.delete(at(owner));
    },
    async touch() {},
    async users(tenant) {
      return [...store.keys()].filter((key) => key.startsWith(`${tenant}\n`)).map((key) => key.slice(tenant.length + 1));
    },
  };
};
