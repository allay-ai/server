import { StateModel } from "../../entities/state/state.model";
import type { Owner } from "../../shared/types/owner";
import { openJson, sealJson } from "../crypto/data";

/** What the plugin keeps for a player between sessions; the backend stores it sealed and reads none of it. */
export interface PlayerState {
  timezone?: string;
  settings?: Record<string, unknown>;
  goals?: unknown[];
}

export interface StoredState {
  state: PlayerState;
  updated_at: string;
}

/** One state per player and tenant, replaced whole; it goes a year after the player's last question. */
export interface StateStore {
  get(owner: Owner): Promise<StoredState | null>;
  put(owner: Owner, state: PlayerState): Promise<StoredState>;
  clear(owner: Owner): Promise<boolean>;
  touch(owner: Owner): Promise<void>;
}

const query = (owner: Owner) => ({ tenant: owner.tenant, user_id: owner.userId });

export const mongoStates: StateStore = {
  async get(owner) {
    const doc = await StateModel.findOne(query(owner)).lean();
    const state = doc ? openJson<PlayerState>(doc.sealed) : undefined;
    return doc && state ? { state, updated_at: doc.updated_at.toISOString() } : null;
  },
  async put(owner, state) {
    const now = new Date();
    await StateModel.updateOne(query(owner), { $set: { sealed: sealJson(state), updated_at: now, seen_at: now } }, { upsert: true });
    return { state, updated_at: now.toISOString() };
  },
  async clear(owner) {
    return (await StateModel.deleteOne(query(owner))).deletedCount > 0;
  },
  async touch(owner) {
    await StateModel.updateOne(query(owner), { $set: { seen_at: new Date() } });
  },
};

/** For tests and local runs without MongoDB. */
export const memoryStates = (): StateStore => {
  const store = new Map<string, StoredState>();
  const at = (owner: Owner) => `${owner.tenant}\n${owner.userId}`;
  return {
    async get(owner) {
      return store.get(at(owner)) ?? null;
    },
    async put(owner, state) {
      const stored = { state, updated_at: new Date().toISOString() };
      store.set(at(owner), stored);
      return stored;
    },
    async clear(owner) {
      return store.delete(at(owner));
    },
    async touch() {},
  };
};
