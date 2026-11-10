import { Schema, model } from "mongoose";
import type { Sealed } from "../../infrastructure/crypto/data";

/** How long a player's work state stays after its last change: long enough for any wait, short enough to be forgotten. */
export const WORKSTATE_DAYS = 30;

/**
 * The work state of a player's automation agents on one server, since 6.31: every agent that does work, its job and
 * what it waits for, so it goes on after a restart or a rejoin. Sealed: the backend reads none of it.
 */
export interface WorkStateDocument {
  tenant: string;
  user_id: string;
  server_id: string;
  sealed: Sealed;
  updated_at: Date;
}

const schema = new Schema<WorkStateDocument>({
  tenant: { type: String, required: true },
  user_id: { type: String, required: true },
  server_id: { type: String, required: true },
  sealed: { type: Schema.Types.Mixed, required: true },
  updated_at: { type: Date, default: Date.now },
});

schema.index({ tenant: 1, user_id: 1, server_id: 1 }, { unique: true });
schema.index({ updated_at: 1 }, { expireAfterSeconds: WORKSTATE_DAYS * 86_400 });

export const WorkStateModel = model<WorkStateDocument>("WorkState", schema, "work_states");

/** Where 6.31.0 kept the same documents; read until its last one ages out, never written. */
export const LegacyWorkStateModel = model<WorkStateDocument>("PlayerAgents", schema.clone(), "player_agents");
