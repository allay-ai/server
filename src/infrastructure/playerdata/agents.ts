import { AGENTS_DAYS, AgentsModel } from "../../entities/agents/agents.model";
import type { Owner } from "../../shared/types/owner";
import { openJson, sealJson } from "../crypto/data";

/** A player's agents on one server as the plugin wrote them; the backend stores them sealed and reads none of it. */
export interface StoredAgents {
  server_id: string;
  agents: unknown[];
  updated_at: string;
}

/**
 * Automation agents per player, tenant, and server, replaced whole. A self-hosted backend may serve several servers under
 * one tenant, and an agent's furnaces stand in one world only, so each server keeps its own. They go AGENTS_DAYS after
 * their last change, and with the player's erasure or withdrawal.
 */
export interface AgentStore {
  get(owner: Owner, serverId: string): Promise<StoredAgents | null>;
  /** An empty list forgets the server's agents. */
  put(owner: Owner, serverId: string, agents: unknown[]): Promise<void>;
  /** Every server's, for the player's copy. */
  list(owner: Owner): Promise<StoredAgents[]>;
  clear(owner: Owner): Promise<number>;
}

const query = (owner: Owner) => ({ tenant: owner.tenant, user_id: owner.userId });

const fresh = (at: Date) => Date.now() - at.getTime() < AGENTS_DAYS * 86_400_000;

export const mongoAgents: AgentStore = {
  async get(owner, serverId) {
    const doc = await AgentsModel.findOne({ ...query(owner), server_id: serverId }).lean();
    if (!doc || !fresh(doc.updated_at)) return null;
    const agents = openJson<unknown[]>(doc.sealed);
    return agents ? { server_id: serverId, agents, updated_at: doc.updated_at.toISOString() } : null;
  },
  async put(owner, serverId, agents) {
    const at = { ...query(owner), server_id: serverId };
    if (agents.length === 0) {
      await AgentsModel.deleteOne(at);
      return;
    }
    await AgentsModel.updateOne(at, { $set: { sealed: sealJson(agents), updated_at: new Date() } }, { upsert: true });
  },
  async list(owner) {
    const docs = await AgentsModel.find(query(owner)).lean();
    return docs.flatMap((doc) => {
      const agents = fresh(doc.updated_at) ? openJson<unknown[]>(doc.sealed) : undefined;
      return agents ? [{ server_id: doc.server_id, agents, updated_at: doc.updated_at.toISOString() }] : [];
    });
  },
  async clear(owner) {
    return (await AgentsModel.deleteMany(query(owner))).deletedCount;
  },
};

/** For tests and local runs without MongoDB. */
export const memoryAgents = (): AgentStore => {
  const store = new Map<string, StoredAgents>();
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
