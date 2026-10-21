import { type ServerDocument, ServerModel } from "../../entities/server/server.model";

export type KnownServer = Omit<ServerDocument, "name_lower">;

/** What a question tells about its server; the name and MOTD come only when the plugin registers. */
export type SeenServer = Omit<KnownServer, "first_seen" | "last_seen" | "name" | "motd">;

/** What the plugin registers at start: everything a question says, plus the name and MOTD. */
export type RegisteredServer = Omit<KnownServer, "first_seen" | "last_seen">;

/**
 * Where each Minecraft server connects from and what it runs, for the panel's Servers page, and the name its owner
 * gave it. A name belongs to one server on the whole backend; another server of the same tenant may take it over,
 * since that's the same owner moving, but another tenant's server can't.
 */
export interface ServerDirectory {
  seen(server: SeenServer, at: Date): Promise<void>;
  /** Records the server and its name; `taken` when a server of another tenant holds the name, and then nothing changes. */
  register(server: RegisteredServer, at: Date): Promise<"ok" | "taken">;
  /** Every server of [tenant], or of every tenant, newest first. */
  list(tenant?: string): Promise<KnownServer[]>;
}

const plain = (doc: ServerDocument): KnownServer => ({
  tenant: doc.tenant,
  server_id: doc.server_id ?? "",
  ip: doc.ip,
  ...(doc.name ? { name: doc.name } : {}),
  ...(doc.motd ? { motd: doc.motd } : {}),
  ...(doc.address ? { address: doc.address } : {}),
  ...(doc.port ? { port: doc.port } : {}),
  ...(doc.software ? { software: doc.software } : {}),
  ...(doc.version ? { version: doc.version } : {}),
  ...(doc.plugin_version ? { plugin_version: doc.plugin_version } : {}),
  first_seen: doc.first_seen,
  last_seen: doc.last_seen,
});

/** What a question says replaces what an older one said; what it leaves out goes, so a removed address doesn't linger. */
const fields = (server: RegisteredServer, keys: Array<keyof RegisteredServer>) => {
  const set: Record<string, unknown> = { ip: server.ip };
  const unset: Record<string, ""> = {};
  for (const key of keys) {
    if (server[key] !== undefined) set[key] = server[key];
    else unset[key] = "";
  }
  return { set, unset };
};

const SEEN = ["address", "port", "software", "version", "plugin_version"] as const;
const REGISTERED = [...SEEN, "name", "motd"] as const;

/** Mongo's answer to a second document with the same unique key. */
const duplicate = (error: unknown) => (error as { code?: number }).code === 11000;

export const mongoServers: ServerDirectory = {
  async seen(server, at) {
    const { set, unset } = fields(server, [...SEEN]);
    await ServerModel.updateOne(
      { tenant: server.tenant, server_id: server.server_id },
      { $set: { ...set, last_seen: at }, $unset: unset, $setOnInsert: { first_seen: at } },
      { upsert: true },
    );
  },
  async register(server, at) {
    const lower = server.name?.toLowerCase();
    if (lower) {
      const holder = await ServerModel.findOne({ name_lower: lower }).lean<ServerDocument>();
      if (holder && holder.tenant !== server.tenant) return "taken";
      // The same owner moved the name to another of their servers.
      if (holder && holder.server_id !== server.server_id) {
        await ServerModel.updateOne({ tenant: holder.tenant, server_id: holder.server_id }, { $unset: { name: "", name_lower: "" } });
      }
    }
    const { set, unset } = fields(server, [...REGISTERED]);
    if (lower) set.name_lower = lower;
    else unset.name_lower = "";
    try {
      await ServerModel.updateOne(
        { tenant: server.tenant, server_id: server.server_id },
        { $set: { ...set, last_seen: at }, $unset: unset, $setOnInsert: { first_seen: at } },
        { upsert: true },
      );
    } catch (error) {
      if (duplicate(error)) return "taken";
      throw error;
    }
    return "ok";
  },
  async list(tenant) {
    return (await ServerModel.find(tenant ? { tenant } : {}).sort({ last_seen: -1 }).limit(1_000).lean<ServerDocument[]>()).map(plain);
  },
};

/** For tests and local runs without MongoDB. */
export const memoryServers = (): ServerDirectory & { all: KnownServer[] } => {
  const all: KnownServer[] = [];
  return {
    all,
    async seen(server, at) {
      const known = all.find((s) => s.tenant === server.tenant && s.server_id === server.server_id);
      const next: KnownServer = {
        ...server,
        ...(known?.name ? { name: known.name } : {}),
        ...(known?.motd ? { motd: known.motd } : {}),
        first_seen: known?.first_seen ?? at,
        last_seen: at,
      };
      if (known) all.splice(all.indexOf(known), 1, next);
      else all.push(next);
    },
    async register(server, at) {
      const lower = server.name?.toLowerCase();
      const holder = lower ? all.find((s) => s.name?.toLowerCase() === lower) : undefined;
      if (holder && holder.tenant !== server.tenant) return "taken";
      if (holder && holder.server_id !== server.server_id) delete holder.name;
      const known = all.find((s) => s.tenant === server.tenant && s.server_id === server.server_id);
      const next: KnownServer = { ...server, first_seen: known?.first_seen ?? at, last_seen: at };
      if (known) all.splice(all.indexOf(known), 1, next);
      else all.push(next);
      return "ok";
    },
    async list(tenant) {
      return all.filter((s) => !tenant || s.tenant === tenant).sort((a, b) => b.last_seen.getTime() - a.last_seen.getTime()).map((s) => ({ ...s }));
    },
  };
};
