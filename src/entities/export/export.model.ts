import { Schema, model } from "mongoose";

/** A link to a player's copy of their data: only the token's digest is kept, and it works for EXPORT_HOURS. */
export interface ExportDocument {
  hash: string;
  tenant: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  downloads: number;
}

export const EXPORT_HOURS = 24;

const schema = new Schema<ExportDocument>({
  hash: { type: String, required: true, unique: true },
  tenant: { type: String, required: true },
  user_id: { type: String, required: true },
  created_at: { type: Date, default: Date.now },
  expires_at: { type: Date, required: true },
  downloads: { type: Number, default: 0 },
});

schema.index({ tenant: 1, user_id: 1 });
// Only garbage collection: every read checks expires_at itself.
schema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

export const ExportModel = model<ExportDocument>("Export", schema, "exports");
