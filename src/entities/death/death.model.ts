import { Schema, model } from "mongoose";
import type { Sealed } from "../../infrastructure/crypto/data";

/** One death of one player of one tenant, since 6.9: the plugin kept them on disk before. */
export interface DeathDocument {
  tenant: string;
  user_id: string;
  /** When the player died; in the clear to sort and page by. */
  at: Date;
  /** Everything else about the death, sealed. */
  sealed: Sealed;
  /** When the player last asked: deaths of a player who stops asking go after PLAYER_DATA_DAYS. */
  seen_at: Date;
}

/** Deaths and the player's state go a year after the player's last question, as their memories do. */
export const PLAYER_DATA_DAYS = 365;

const schema = new Schema<DeathDocument>({
  tenant: { type: String, required: true },
  user_id: { type: String, required: true },
  at: { type: Date, required: true },
  sealed: { type: Schema.Types.Mixed, required: true },
  seen_at: { type: Date, default: Date.now },
});

// One death per moment: the plugin may send the same one again after a retry, and that changes nothing.
schema.index({ tenant: 1, user_id: 1, at: -1 }, { unique: true });
schema.index({ seen_at: 1 }, { expireAfterSeconds: PLAYER_DATA_DAYS * 86_400 });

export const DeathModel = model<DeathDocument>("Death", schema, "deaths");
