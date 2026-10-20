import { ConsentModel } from "../../entities/consent/consent.model";
import type { Owner } from "../../shared/types/owner";

export interface Consent {
  version: number;
  accepted_at: string;
}

/**
 * Who agreed to what, per player and tenant. The plugin asks a player before their first question and keeps the answer
 * here; it stays until the player withdraws it or their data is erased, so it proves the agreement as long as the data
 * it covers exists.
 */
export interface ConsentStore {
  get(owner: Owner): Promise<Consent | null>;
  /** Records the agreement to [version], replacing an older one. */
  give(owner: Owner, version: number): Promise<Consent>;
  /** Whether there was one to withdraw. */
  withdraw(owner: Owner): Promise<boolean>;
}

export const MAX_CONSENT_VERSION = 1000;

const query = (owner: Owner) => ({ tenant: owner.tenant, user_id: owner.userId });

export const mongoConsents: ConsentStore = {
  async get(owner) {
    const doc = await ConsentModel.findOne(query(owner)).lean();
    return doc ? { version: doc.version, accepted_at: doc.accepted_at.toISOString() } : null;
  },
  async give(owner, version) {
    const accepted_at = new Date();
    await ConsentModel.updateOne(query(owner), { $set: { version, accepted_at } }, { upsert: true });
    return { version, accepted_at: accepted_at.toISOString() };
  },
  async withdraw(owner) {
    return (await ConsentModel.deleteOne(query(owner))).deletedCount > 0;
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
    async give(owner, version) {
      const consent = { version, accepted_at: new Date().toISOString() };
      store.set(at(owner), consent);
      return consent;
    },
    async withdraw(owner) {
      return store.delete(at(owner));
    },
  };
};
