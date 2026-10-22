import { Schema, model } from "mongoose";
import type { Sealed } from "../../infrastructure/crypto/data";
import { PLAYER_DATA_DAYS } from "../death/death.model";

/** What the plugin keeps about a player while they play, since 6.9: their time zone, settings, and goals, sealed. */
export interface StateDocument {
  tenant: string;
  user_id: string;
  sealed: Sealed;
  updated_at: Date;
  seen_at: Date;
}

const schema = new Schema<StateDocument>({
  tenant: { type: String, required: true },
  user_id: { type: String, required: true },
  sealed: { type: Schema.Types.Mixed, required: true },
  updated_at: { type: Date, default: Date.now },
  seen_at: { type: Date, default: Date.now },
});

schema.index({ tenant: 1, user_id: 1 }, { unique: true });
schema.index({ seen_at: 1 }, { expireAfterSeconds: PLAYER_DATA_DAYS * 86_400 });

export const StateModel = model<StateDocument>("PlayerState", schema, "player_states");
