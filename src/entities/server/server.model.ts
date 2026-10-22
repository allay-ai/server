import { Schema, model } from "mongoose";

/** How long a server stays in the directory after its last question, like its runs. */
export const SERVER_DAYS = 730;

/** What the panel knows about one Minecraft server behind a tenant: where it connects from and what it runs. */
export interface ServerDocument {
  /** `self` or `license:<id>`. */
  tenant: string;
  /** The plugin's random server id; empty for plugins that send none. */
  server_id: string;
  /** The address the server's requests came from, as the trusted proxies tell it. */
  ip: string;
  /** The name the server's owner gave it (`server.name` in the plugin's config, since 6.7); unique on the backend. */
  name?: string;
  /** Lower-cased, so “Moonlands” and “moonlands” are one name. */
  name_lower?: string;
  /** The server's MOTD without formatting codes. */
  motd?: string;
  /** The address players join with, when the plugin says (`server.address` in its config). */
  address?: string;
  port?: number;
  software?: string;
  version?: string;
  plugin_version?: string;
  first_seen: Date;
  last_seen: Date;
}

const schema = new Schema<ServerDocument>(
  {
    tenant: { type: String, required: true },
    server_id: { type: String, default: "" },
    ip: { type: String, required: true },
    name: String,
    name_lower: String,
    motd: String,
    address: String,
    port: Number,
    software: String,
    version: String,
    plugin_version: String,
    first_seen: { type: Date, required: true },
    last_seen: { type: Date, required: true },
  },
  { versionKey: false },
);

schema.index({ tenant: 1, server_id: 1 }, { unique: true });
schema.index({ name_lower: 1 }, { unique: true, partialFilterExpression: { name_lower: { $type: "string" } } });
schema.index({ last_seen: 1 }, { expireAfterSeconds: SERVER_DAYS * 86_400 });

export const ServerModel = model<ServerDocument>("Server", schema, "servers");
