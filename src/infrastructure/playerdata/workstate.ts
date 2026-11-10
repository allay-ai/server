import { LegacyWorkStateModel, WORKSTATE_DAYS, WorkStateModel } from "../../entities/workstate/workstate.model";
import type { Owner } from "../../shared/types/owner";
import { openJson, sealJson } from "../crypto/data";

/** A player's work state on one server as the plugin wrote it: its agents, each with its job. */
export interface StoredWorkState {
  server_id: string;
  agents: unknown[];
  updated_at: string;
}

/**
 * Work state per player, tenant, and server, replaced whole. A self-hosted backend may serve several servers under one
 * tenant, and an agent's furnaces stand in one world only, so each server keeps its own. It goes WORKSTATE_DAYS after
 * its last change, and with the player's erasure or withdrawal.
 */
export interface WorkStateStore {
  get(owner: Owner, serverId: string): Promise<StoredWorkState | null>;
  /** An empty list forgets the server's work state. */
  put(owner: Owner, serverId: string, agents: unknown[]): Promise<void>;
  /** Every server's, for the player's copy. */
  list(owner: Owner): Promise<StoredWorkState[]>;
  clear(owner: Owner): Promise<number>;
}

const query = (owner: Owner) => ({ tenant: owner.tenant, user_id: owner.userId });

const fresh = (at: Date) => Date.now() - at.getTime() < WORKSTATE_DAYS * 86_400_000;

const stored = (doc: { server_id: string; sealed: unknown; updated_at: Date }): StoredWorkState | null => {
  const agents = fresh(doc.updated_at) ? openJson<unknown[]>(doc.sealed as never) : undefined;
  return agents ? { server_id: doc.server_id, agents, updated_at: doc.updated_at.toISOString() } : null;
};

export const mongoWorkStates: WorkStateStore = {
  async get(owner, serverId) {
    const at = { ...query(owner), server_id: serverId };
    const doc = (await WorkStateModel.findOne(at).lean()) ?? (await LegacyWorkStateModel.findOne(at).lean());
    return doc ? stored(doc) : null;
  },
  async put(owner, serverId, agents) {
    const at = { ...query(owner), server_id: serverId };
    // What 6.31.0 kept moves over with the first write.
    await LegacyWorkStateModel.deleteOne(at);
    if (agents.length === 0) {
      await WorkStateModel.deleteOne(at);
      return;
    }
    await WorkStateModel.updateOne(at, { $set: { sealed: sealJson(agents), updated_at: new Date() } }, { upsert: true });
  },
  async list(owner) {
    const docs = [...(await WorkStateModel.find(query(owner)).lean()), ...(await LegacyWorkStateModel.find(query(owner)).lean())];
    const seen = new Set<string>();
    return docs.flatMap((doc) => {
      if (seen.has(doc.server_id)) return [];
      seen.add(doc.server_id);
      const state = stored(doc);
      return state ? [state] : [];
    });
  },
  async clear(owner) {
    return (await WorkStateModel.deleteMany(query(owner))).deletedCount + (await LegacyWorkStateModel.deleteMany(query(owner))).deletedCount;
  },
};

/** For tests and local runs without MongoDB. */
export const memoryWorkStates = (): WorkStateStore => {
  const store = new Map<string, StoredWorkState>();
  const at = (owner: Owner, serverId: string) => `${owner.tenant}\n${owner.userId}\n${serverId}`;
  const prefix = (owner: Owner) => `${owner.tenant}\n${owner.userId}\n`;
  return {
    async get(owner, serverId) {
      return store.get(at(owner, serverId)) ?? null;
    },
    async put(owner, serverId, agents) {
      if (agents.length === 0) store.delete(at(owner, serverId));
      else store.set(at(owner, serverId), { server_id: serverId, agents, updated_at: new Date().toISOString() });
    },
    async list(owner) {
      return [...store.entries()].filter(([key]) => key.startsWith(prefix(owner))).map(([, value]) => value);
    },
    async clear(owner) {
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix(owner)));
      for (const key of keys) store.delete(key);
      return keys.length;
    },
  };
};
