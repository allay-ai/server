import { Schema, model } from "mongoose";

/** How long a player stays in the directory after their last question, like their runs. */
export const PLAYER_DAYS = 400;

/** Who a pseudonym is on one tenant's server, so the panel can name players and find them by name. */
export interface PlayerDocument {
  /** `self` or `license:<id>`. */
  tenant: string;
  pseudonym: string;
  /** The id the plugin sends, a UUID for Minecraft players. */
  user_id: string;
  /** The name the player had at their last question. */
  name: string;
  /** Lower-cased, for search by name. */
  name_lower: string;
  op?: boolean;
  first_seen: Date;
  last_seen: Date;
}

const schema = new Schema<PlayerDocument>(
  {
    tenant: { type: String, required: true },
    pseudonym: { type: String, required: true },
    user_id: { type: String, required: true },
    name: { type: String, required: true },
    name_lower: { type: String, required: true },
    op: Boolean,
    first_seen: { type: Date, required: true },
    last_seen: { type: Date, required: true },
  },
  { versionKey: false },
);

schema.index({ tenant: 1, pseudonym: 1 }, { unique: true });
schema.index({ pseudonym: 1 });
schema.index({ name_lower: 1 });
schema.index({ user_id: 1 });
schema.index({ last_seen: 1 }, { expireAfterSeconds: PLAYER_DAYS * 86_400 });

export const PlayerModel = model<PlayerDocument>("Player", schema, "players");
