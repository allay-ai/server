import { Schema, model } from "mongoose";

/** A player's agreement to have Allay process their data on one tenant's server, kept as proof (GDPR art. 7(1)). */
export interface ConsentDocument {
  /** `self` or `license:<id>`: whose server the player agreed on. */
  tenant: string;
  user_id: string;
  /** Which notice the player agreed to; the plugin asks again when its notice's version goes up. */
  version: number;
  accepted_at: Date;
}

const schema = new Schema<ConsentDocument>({
  tenant: { type: String, required: true },
  user_id: { type: String, required: true },
  version: { type: Number, required: true, min: 1 },
  accepted_at: { type: Date, default: Date.now },
});

schema.index({ tenant: 1, user_id: 1 }, { unique: true });

export const ConsentModel = model<ConsentDocument>("Consent", schema);
