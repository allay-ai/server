import { Schema, model } from "mongoose";
import type { Sealed } from "../../infrastructure/crypto/data";

/** How long a player's agents stay after their last change: long enough for any wait, short enough to be forgotten. */
export const AGENTS_DAYS = 30;

/** A player's automation agents on one server, since 6.31: what lets them go on after a restart or a rejoin, sealed. */
export interface AgentsDocument {
  tenant: string;
  user_id: string;
  server_id: string;
  sealed: Sealed;
  updated_at: Date;
}

const schema = new Schema<AgentsDocument>({
  tenant: { type: String, required: true },
  user_id: { type: String, required: true },
  server_id: { type: String, required: true },
  sealed: { type: Schema.Types.Mixed, required: true },
  updated_at: { type: Date, default: Date.now },
});

schema.index({ tenant: 1, user_id: 1, server_id: 1 }, { unique: true });
schema.index({ updated_at: 1 }, { expireAfterSeconds: AGENTS_DAYS * 86_400 });

export const AgentsModel = model<AgentsDocument>("PlayerAgents", schema, "player_agents");
