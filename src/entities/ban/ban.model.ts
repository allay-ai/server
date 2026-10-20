import { Schema, model } from "mongoose";

/** A player an operator stopped from asking on one tenant's server, known by pseudonym like everywhere in the panel. */
export interface BanDocument {
  /** `self` or `license:<id>`: whose server the player may not ask on. */
  tenant: string;
  pseudonym: string;
  /** The panel account that blocked them. */
  by: string;
  blocked_at: Date;
}

const schema = new Schema<BanDocument>({
  tenant: { type: String, required: true },
  pseudonym: { type: String, required: true },
  by: { type: String, required: true },
  blocked_at: { type: Date, default: Date.now },
});

schema.index({ tenant: 1, pseudonym: 1 }, { unique: true });
schema.index({ pseudonym: 1 });

export const BanModel = model<BanDocument>("Ban", schema);
