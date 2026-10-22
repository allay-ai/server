import { type PlayerDocument, PlayerModel } from "../../entities/player/player.model";
import type { RunStore } from "../runs/runs";

export interface KnownPlayer {
  tenant: string;
  pseudonym: string;
  user_id: string;
  name: string;
  op?: boolean;
  first_seen: Date;
  last_seen: Date;
}

/**
 * Who each pseudonym is, per tenant: the name and id a player's last question came with. Runs keep only the
 * pseudonym, so a rename shows everywhere at once and an erasure takes the name off every run.
 */
export interface PlayerDirectory {
  /** Records a question from this player now. */
  seen(player: Omit<KnownPlayer, "first_seen" | "last_seen">, at: Date): Promise<void>;
  /** Every tenant's entry for each of [pseudonyms], newest first. */
  of(pseudonyms: string[]): Promise<Map<string, KnownPlayer[]>>;
  /** Players whose name starts with [text], or whose id or pseudonym is [text], newest first. */
  search(text: string, options: { tenant?: string; limit: number }): Promise<KnownPlayer[]>;
  /** The entry of [pseudonym] on [tenant], if the directory knows them. */
  get(tenant: string, pseudonym: string): Promise<KnownPlayer | null>;
  /** Forgets the player on one tenant; whether there was an entry. */
  forget(tenant: string, pseudonym: string): Promise<boolean>;
}

/** Minecraft names are 3–16 letters, digits, or underscores; Bedrock players through Geyser add a dot or a space. */
export const NAME_SEARCH = /^[\w .*-]{1,32}$/;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const plain = (doc: PlayerDocument): KnownPlayer => ({
  tenant: doc.tenant,
  pseudonym: doc.pseudonym,
  user_id: doc.user_id,
  name: doc.name,
  ...(doc.op === undefined ? {} : { op: doc.op }),
  first_seen: doc.first_seen,
  last_seen: doc.last_seen,
});

const grouped = (players: KnownPlayer[]) => {
  const map = new Map<string, KnownPlayer[]>();
  for (const player of [...players].sort((a, b) => b.last_seen.getTime() - a.last_seen.getTime())) map.set(player.pseudonym, [...(map.get(player.pseudonym) ?? []), player]);
  return map;
};

export const mongoPlayers: PlayerDirectory = {
  async seen(player, at) {
    await PlayerModel.updateOne(
      { tenant: player.tenant, pseudonym: player.pseudonym },
      {
        $set: { user_id: player.user_id, name: player.name, name_lower: player.name.toLowerCase(), last_seen: at, ...(player.op === undefined ? {} : { op: player.op }) },
        $setOnInsert: { first_seen: at },
      },
      { upsert: true },
    );
  },
  async of(pseudonyms) {
    if (!pseudonyms.length) return new Map();
    return grouped((await PlayerModel.find({ pseudonym: { $in: [...new Set(pseudonyms)] } }).lean<PlayerDocument[]>()).map(plain));
  },
  async search(text, { tenant, limit }) {
    const filter = { $or: [{ name_lower: { $regex: `^${escape(text.toLowerCase())}` } }, { user_id: text }, { pseudonym: text }], ...(tenant ? { tenant } : {}) };
    return (await PlayerModel.find(filter).sort({ last_seen: -1 }).limit(limit).lean<PlayerDocument[]>()).map(plain);
  },
  async get(tenant, pseudonym) {
    const doc = await PlayerModel.findOne({ tenant, pseudonym }).lean<PlayerDocument>();
    return doc ? plain(doc) : null;
  },
  async forget(tenant, pseudonym) {
    return (await PlayerModel.deleteOne({ tenant, pseudonym })).deletedCount > 0;
  },
};

/** For tests and local runs without MongoDB. */
export const memoryPlayers = (): PlayerDirectory & { all: KnownPlayer[] } => {
  const all: KnownPlayer[] = [];
  const find = (tenant: string, pseudonym: string) => all.find((p) => p.tenant === tenant && p.pseudonym === pseudonym);
  return {
    all,
    async seen(player, at) {
      const known = find(player.tenant, player.pseudonym);
      if (known) Object.assign(known, { user_id: player.user_id, name: player.name, last_seen: at, ...(player.op === undefined ? {} : { op: player.op }) });
      else all.push({ ...player, first_seen: at, last_seen: at });
    },
    async of(pseudonyms) {
      return grouped(all.filter((p) => pseudonyms.includes(p.pseudonym)).map((p) => ({ ...p })));
    },
    async search(text, { tenant, limit }) {
      const lower = text.toLowerCase();
      return all
        .filter((p) => (!tenant || p.tenant === tenant) && (p.name.toLowerCase().startsWith(lower) || p.user_id === text || p.pseudonym === text))
        .sort((a, b) => b.last_seen.getTime() - a.last_seen.getTime())
        .slice(0, limit)
        .map((p) => ({ ...p }));
    },
    async get(tenant, pseudonym) {
      const known = find(tenant, pseudonym);
      return known ? { ...known } : null;
    },
    async forget(tenant, pseudonym) {
      const index = all.findIndex((p) => p.tenant === tenant && p.pseudonym === pseudonym);
      if (index < 0) return false;
      all.splice(index, 1);
      return true;
    },
  };
};

/** Java's UUID.toString(), which the plugin sends: lower case with dashes, from either form Mojang prints. */
export const dashedUuid = (text: string) => {
  const hex = text.trim().toLowerCase().replace(/-/g, "");
  return /^[0-9a-f]{32}$/.test(hex) ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : null;
};

export interface Restored {
  name: string;
  /** The tenants whose runs had this player, the pseudonym there, and whether the directory got them now or knew them already. */
  tenants: Array<{ tenant: string; pseudonym: string; added: boolean }>;
}

/**
 * Names players who asked before 6.4, when the directory didn't exist: for each name and UUID, the runs under its
 * pseudonym tell the tenants and the first and last question. A player without runs is left out, and an entry a newer
 * question made stays as it is.
 */
export const restorePlayers = async (
  entries: Array<{ name: string; userId: string }>,
  deps: { pseudonyms: { of(tenant: string, id: string): string }; runs: Pick<RunStore, "tenants" | "of">; players: PlayerDirectory },
): Promise<Restored[]> => {
  const restored: Restored[] = [];
  for (const { name, userId } of entries) {
    const tenants: Restored["tenants"] = [];
    for (const tenant of await deps.runs.tenants()) {
      const pseudonym = deps.pseudonyms.of(tenant, userId);
      if (await deps.players.get(tenant, pseudonym)) {
        tenants.push({ tenant, pseudonym, added: false });
        continue;
      }
      const runs = await deps.runs.of(pseudonym, tenant, 100_000);
      if (!runs.length) continue;
      const player = { tenant, pseudonym, user_id: userId, name };
      // The first call sets when they first asked, the second when they last did.
      await deps.players.seen(player, runs.at(-1)!.at);
      await deps.players.seen(player, runs[0].at);
      tenants.push({ tenant, pseudonym, added: true });
    }
    restored.push({ name, tenants });
  }
  return restored;
};
