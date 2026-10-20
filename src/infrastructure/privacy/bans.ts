import { BanModel } from "../../entities/ban/ban.model";

export interface Ban {
  tenant: string;
  by: string;
  blocked_at: string;
}

/**
 * Players operators stopped from asking, per tenant and pseudonym: the store never holds a player's id, and a ban
 * outlives an erasure, so erasing their data doesn't lift it. It stays until someone unblocks the player.
 */
export interface BanStore {
  /** Whether the player with [pseudonym] may not ask on [tenant]. */
  has(tenant: string, pseudonym: string): Promise<boolean>;
  /** Every tenant that blocked each of [pseudonyms]. */
  of(pseudonyms: string[]): Promise<Map<string, Ban[]>>;
  /** Every ban, newest first, for the panel's list. */
  list(limit: number): Promise<Array<{ pseudonym: string } & Ban>>;
  /** Whether the player wasn't blocked there before. */
  block(tenant: string, pseudonym: string, by: string): Promise<boolean>;
  /** Whether there was a ban to lift. */
  unblock(tenant: string, pseudonym: string): Promise<boolean>;
}

const grouped = (bans: Array<{ pseudonym: string } & Ban>) => {
  const map = new Map<string, Ban[]>();
  for (const { pseudonym, ...ban } of bans) map.set(pseudonym, [...(map.get(pseudonym) ?? []), ban]);
  return map;
};

export const mongoBans: BanStore = {
  async has(tenant, pseudonym) {
    return (await BanModel.exists({ tenant, pseudonym })) !== null;
  },
  async of(pseudonyms) {
    const docs = await BanModel.find({ pseudonym: { $in: pseudonyms } }).lean();
    return grouped(docs.map((d) => ({ pseudonym: d.pseudonym, tenant: d.tenant, by: d.by, blocked_at: d.blocked_at.toISOString() })));
  },
  async list(limit) {
    const docs = await BanModel.find({}).sort({ blocked_at: -1 }).limit(limit).lean();
    return docs.map((d) => ({ pseudonym: d.pseudonym, tenant: d.tenant, by: d.by, blocked_at: d.blocked_at.toISOString() }));
  },
  async block(tenant, pseudonym, by) {
    const result = await BanModel.updateOne({ tenant, pseudonym }, { $setOnInsert: { by, blocked_at: new Date() } }, { upsert: true });
    return result.upsertedCount > 0;
  },
  async unblock(tenant, pseudonym) {
    return (await BanModel.deleteOne({ tenant, pseudonym })).deletedCount > 0;
  },
};

/** For tests and local runs without MongoDB. */
export const memoryBans = (): BanStore => {
  const store = new Map<string, { pseudonym: string } & Ban>();
  const at = (tenant: string, pseudonym: string) => `${tenant}\n${pseudonym}`;
  return {
    async has(tenant, pseudonym) {
      return store.has(at(tenant, pseudonym));
    },
    async of(pseudonyms) {
      return grouped([...store.values()].filter((b) => pseudonyms.includes(b.pseudonym)));
    },
    async list(limit) {
      return [...store.values()].sort((a, b) => b.blocked_at.localeCompare(a.blocked_at)).slice(0, limit);
    },
    async block(tenant, pseudonym, by) {
      if (store.has(at(tenant, pseudonym))) return false;
      store.set(at(tenant, pseudonym), { pseudonym, tenant, by, blocked_at: new Date().toISOString() });
      return true;
    },
    async unblock(tenant, pseudonym) {
      return store.delete(at(tenant, pseudonym));
    },
  };
};
