import { ConsentModel } from "../../entities/consent/consent.model";
import type { Owner } from "../../shared/types/owner";

export interface Consent {
  version: number;
  /** Since 6.9: what the plugin hashed the notice and the policy's revision to; absent for older agreements. */
  hash?: string;
  revision?: string;
  /** Since 6.9: the player said they're 13 or older; false when they weren't asked or before 6.9. */
  age_confirmed: boolean;
  accepted_at: string;
}

/** What a player agrees to: the notice's version, and since 6.9 its hash and the policy's revision. */
export interface Agreement {
  version: number;
  hash?: string;
  revision?: string;
  age_confirmed?: boolean;
}

/**
 * Who agreed to what, per player and tenant. The plugin asks a player before their first question and keeps the answer
 * here; it stays until the player withdraws it, their data is erased, or CONSENT_DAYS after their last question, so it
 * proves the agreement as long as the data it covers exists.
 */
export interface ConsentStore {
  get(owner: Owner): Promise<Consent | null>;
  /** Records the agreement, replacing an older one. */
  give(owner: Owner, agreement: Agreement): Promise<Consent>;
  /** Whether there was one to withdraw. */
  withdraw(owner: Owner): Promise<boolean>;
  /** The player just asked: the agreement lives another CONSENT_DAYS. */
  touch(owner: Owner): Promise<void>;
  /** The ids of every player who agreed on [tenant]: since 6.1 that's everyone who asks there. */
  users(tenant: string): Promise<string[]>;
}

export const MAX_CONSENT_VERSION = 1000;

const query = (owner: Owner) => ({ tenant: owner.tenant, user_id: owner.userId });

const consentOf = (doc: { version: number; hash?: string; revision?: string; age_confirmed?: boolean; accepted_at: Date }): Consent => ({
  version: doc.version,
  ...(doc.hash ? { hash: doc.hash } : {}),
  ...(doc.revision ? { revision: doc.revision } : {}),
  age_confirmed: doc.age_confirmed ?? false,
  accepted_at: doc.accepted_at.toISOString(),
});

export const mongoConsents: ConsentStore = {
  async get(owner) {
    const doc = await ConsentModel.findOne(query(owner)).lean();
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
    };
    // A new agreement replaces the old one whole: nothing from before stays behind it.
    const unset = { ...(agreement.hash ? {} : { hash: "" }), ...(agreement.revision ? {} : { revision: "" }), ...(agreement.age_confirmed !== undefined ? {} : { age_confirmed: "" }) };
    await ConsentModel.updateOne(query(owner), { $set: fields, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { upsert: true });
    return consentOf(fields);
  },
  async withdraw(owner) {
    return (await ConsentModel.deleteOne(query(owner))).deletedCount > 0;
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
      return store.get(at(owner)) ?? null;
    },
    async give(owner, agreement) {
      const consent = consentOf({ ...agreement, accepted_at: new Date() });
      store.set(at(owner), consent);
      return consent;
    },
    async withdraw(owner) {
      return store.delete(at(owner));
    },
    async touch() {},
    async users(tenant) {
      return [...store.keys()].filter((key) => key.startsWith(`${tenant}\n`)).map((key) => key.slice(tenant.length + 1));
    },
  };
};
