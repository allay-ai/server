import { type ServerDocument, ServerModel } from "../../entities/server/server.model";

export type KnownServer = ServerDocument;

/** Where each Minecraft server connects from and what it runs, from its last question, for the panel's Servers page. */
export interface ServerDirectory {
  seen(server: Omit<KnownServer, "first_seen" | "last_seen">, at: Date): Promise<void>;
  /** Every server of [tenant], or of every tenant, newest first. */
  list(tenant?: string): Promise<KnownServer[]>;
}

const plain = (doc: ServerDocument): KnownServer => ({
  tenant: doc.tenant,
  server_id: doc.server_id ?? "",
  ip: doc.ip,
  ...(doc.address ? { address: doc.address } : {}),
  ...(doc.port ? { port: doc.port } : {}),
  ...(doc.software ? { software: doc.software } : {}),
  ...(doc.version ? { version: doc.version } : {}),
  ...(doc.plugin_version ? { plugin_version: doc.plugin_version } : {}),
  first_seen: doc.first_seen,
  last_seen: doc.last_seen,
});

/** What a question says replaces what an older one said; what it leaves out goes, so a removed address doesn't linger. */
const fields = (server: Omit<KnownServer, "first_seen" | "last_seen">) => {
  const set: Record<string, unknown> = { ip: server.ip };
  const unset: Record<string, ""> = {};
  for (const key of ["address", "port", "software", "version", "plugin_version"] as const) {
    if (server[key] !== undefined) set[key] = server[key];
    else unset[key] = "";
  }
  return { set, unset };
};

export const mongoServers: ServerDirectory = {
  async seen(server, at) {
    const { set, unset } = fields(server);
    await ServerModel.updateOne(
      { tenant: server.tenant, server_id: server.server_id },
      { $set: { ...set, last_seen: at }, $unset: unset, $setOnInsert: { first_seen: at } },
      { upsert: true },
    );
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
      const next = { ...server, first_seen: known?.first_seen ?? at, last_seen: at };
      if (known) all.splice(all.indexOf(known), 1, next);
      else all.push(next);
    },
    async list(tenant) {
      return all.filter((s) => !tenant || s.tenant === tenant).sort((a, b) => b.last_seen.getTime() - a.last_seen.getTime()).map((s) => ({ ...s }));
    },
  };
};
