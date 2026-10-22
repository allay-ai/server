import { Schema, model } from "mongoose";
import type { Sealed } from "../../infrastructure/crypto/data";

/** Where a memory is tied to, since 6.9: the notebook of places joined memories. */
export interface Place {
  x: number;
  y: number;
  z: number;
  dimension: string;
  world?: string;
}

/** A lasting fact Allay keeps about one player of one tenant, such as where their base is. */
export interface MemoryDocument {
  id: string;
  /** `self` or `license:<id>`: whose server the player asked on. */
  tenant: string;
  user_id: string;
  /** `{ text, place? }`, sealed. */
  sealed?: Sealed;
  /** Memories from before 6.9 keep their text in the clear until they're saved again or go. */
  text?: string;
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
  sealed: Schema.Types.Mixed,
  text: { type: String, maxlength: 200 },
  created_at: { type: Date, default: Date.now },
  seen_at: { type: Date, default: Date.now },
});

schema.index({ tenant: 1, user_id: 1, id: 1 }, { unique: true });
schema.index({ tenant: 1, user_id: 1, created_at: 1 });
schema.index({ seen_at: 1 }, { expireAfterSeconds: MEMORY_DAYS * 86_400 });

export const MemoryModel = model<MemoryDocument>("Memory", schema);
