import { Schema, model } from "mongoose";

/** A lasting fact Allay keeps about one player of one tenant, such as where their base is. */
export interface MemoryDocument {
  id: string;
  /** `self` or `license:<id>`: whose server the player asked on. */
  tenant: string;
  user_id: string;
  text: string;
  created_at: Date;
  /** When the player last asked: memories of a player who stops asking go after MEMORY_DAYS. */
  seen_at: Date;
}

/** A player who hasn't asked for this long loses their memories; nobody needs them anymore. */
export const MEMORY_DAYS = 365;

const schema = new Schema<MemoryDocument>({
  id: { type: String, required: true },
  tenant: { type: String, required: true },
  user_id: { type: String, required: true },
  text: { type: String, required: true, maxlength: 200 },
  created_at: { type: Date, default: Date.now },
  seen_at: { type: Date, default: Date.now },
});

schema.index({ tenant: 1, user_id: 1, id: 1 }, { unique: true });
schema.index({ tenant: 1, user_id: 1, created_at: 1 });
schema.index({ seen_at: 1 }, { expireAfterSeconds: MEMORY_DAYS * 86_400 });

export const MemoryModel = model<MemoryDocument>("Memory", schema);
