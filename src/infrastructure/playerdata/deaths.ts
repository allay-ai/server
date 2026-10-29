import { DeathModel } from "../../entities/death/death.model";
import { settings } from "../../features/settings/settings";
import type { Owner } from "../../shared/types/owner";
import { openJson, sealJson } from "../crypto/data";

/** A death as the plugin reports it: when, where, what killed the player, and what they dropped. */
export interface Death {
  /** Milliseconds since the epoch. */
  at: number;
  world: string;
  dimension: string;
  x: number;
  y: number;
  z: number;
  cause?: string;
  killer?: string;
  killer_name?: string;
  message?: string;
  level: number;
  kept_inventory?: boolean;
  drops?: Record<string, number>;
  more_drops?: number;
  experience?: number;
}

export interface DeathPage {
  total: number;
  /** Newest first. */
  deaths: Death[];
}

/** The deaths of each player, sealed, newest DEATHS_MAX kept; they go a year after the player's last question. */
export interface DeathStore {
  /** A death at a moment already kept is a no-op: the plugin retries what it isn't sure arrived. */
  add(owner: Owner, death: Death): Promise<void>;
  /** One page of [size], 1-based, newest first. */
  page(owner: Owner, page: number, size: number): Promise<DeathPage>;
  /** All of them, newest first, for the player's copy. */
  list(owner: Owner): Promise<Death[]>;
  clear(owner: Owner): Promise<number>;
  touch(owner: Owner): Promise<void>;
}

export const maxDeaths = () => settings.get("DEATHS_MAX");

const query = (owner: Owner) => ({ tenant: owner.tenant, user_id: owner.userId });

const opened = (docs: Array<{ sealed: unknown }>) => docs.map((d) => openJson<Death>(d.sealed)).filter((d): d is Death => !!d);

export const mongoDeaths: DeathStore = {
  async add(owner, death) {
    const at = new Date(death.at);
    await DeathModel.updateOne({ ...query(owner), at }, { $setOnInsert: { ...query(owner), at, sealed: sealJson(death), seen_at: new Date() } }, { upsert: true });
    const old = await DeathModel.find(query(owner), { _id: 1 }).sort({ at: -1 }).skip(maxDeaths()).lean();
    if (old.length) await DeathModel.deleteMany({ _id: { $in: old.map((d) => d._id) } });
  },
  async page(owner, page, size) {
    const [total, docs] = await Promise.all([
      DeathModel.countDocuments(query(owner)),
      DeathModel.find(query(owner), { sealed: 1 }).sort({ at: -1 }).skip((page - 1) * size).limit(size).lean(),
    ]);
    return { total, deaths: opened(docs) };
  },
  async list(owner) {
    return opened(await DeathModel.find(query(owner), { sealed: 1 }).sort({ at: -1 }).lean());
  },
  async clear(owner) {
    return (await DeathModel.deleteMany(query(owner))).deletedCount;
  },
  async touch(owner) {
    await DeathModel.updateMany(query(owner), { $set: { seen_at: new Date() } });
  },
};

/** For tests and local runs without MongoDB. */
export const memoryDeaths = (): DeathStore => {
  const store = new Map<string, Death[]>();
  const at = (owner: Owner) => `${owner.tenant}\n${owner.userId}`;
  const of = (owner: Owner) => store.get(at(owner)) ?? [];
  return {
    async add(owner, death) {
      if (of(owner).some((d) => d.at === death.at)) return;
      store.set(at(owner), [...of(owner), death].sort((a, b) => b.at - a.at).slice(0, maxDeaths()));
    },
    async page(owner, page, size) {
      return { total: of(owner).length, deaths: of(owner).slice((page - 1) * size, page * size) };
    },
    async list(owner) {
      return [...of(owner)];
    },
    async clear(owner) {
      const count = of(owner).length;
      store.delete(at(owner));
      return count;
    },
    async touch() {},
  };
};
