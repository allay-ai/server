import { Schema, model } from "mongoose";

/** A player's agreement to have Allay process their data on one tenant's server, kept as proof (GDPR art. 7(1)). */
export interface ConsentDocument {
  /** `self` or `license:<id>`: whose server the player agreed on. */
  tenant: string;
  user_id: string;
  /** Which notice the player agreed to; the plugin asks again when its notice's version goes up. */
  version: number;
  /** Since 6.9: SHA-256 of the notice's text and the policy's revision, as the plugin computed it; it asks again when they differ. */
  hash?: string;
  /** Since 6.9: the privacy policy's revision when the player agreed. */
  revision?: string;
  /** Since 6.9: the player said they're 13 or older, which the plugin asks players in the USA (COPPA). */
  age_confirmed?: boolean;
  accepted_at: Date;
  /** When the player last asked: an agreement goes with the player, CONSENT_DAYS after their last question. */
  seen_at: Date;
}

/** As long as the panel's directory knows the player: the agreement proves what that data rests on. */
export const CONSENT_DAYS = 730;

const schema = new Schema<ConsentDocument>({
  tenant: { type: String, required: true },
  user_id: { type: String, required: true },
  version: { type: Number, required: true, min: 1 },
  hash: { type: String, match: /^[0-9a-f]{64}$/ },
  revision: String,
  age_confirmed: Boolean,
  accepted_at: { type: Date, default: Date.now },
  seen_at: { type: Date, default: Date.now },
});

schema.index({ tenant: 1, user_id: 1 }, { unique: true });
schema.index({ seen_at: 1 }, { expireAfterSeconds: CONSENT_DAYS * 86_400 });

export const ConsentModel = model<ConsentDocument>("Consent", schema);
