import { Schema, model } from "mongoose";
import type { Sealed } from "../../infrastructure/crypto/data";

/** How long a chat line stays: long enough to ask about yesterday's talk, short enough to be forgotten. */
export const CHAT_HISTORY_HOURS = 72;

export const CHAT_CHANNELS = ["public", "local", "private"] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];

/**
 * One line of a Minecraft server's chat, since 6.34: what everyone read, what a local chat showed to the players
 * near, or a private message. Who may read it again stays in the clear as pseudonyms; the names and the text are sealed.
 */
export interface ChatLineDocument {
  tenant: string;
  server_id: string;
  /** When it was written; in the clear to sort and page by. */
  at: Date;
  channel: ChatChannel;
  /** The sender's pseudonym on the tenant, for their copy and their erasure. */
  from: string;
  /** The pseudonyms of whoever else saw a local or private line; empty for a public one. */
  audience: string[];
  /** The sender, the addressee of a private line, and the text. */
  sealed: Sealed;
  expires_at: Date;
}

const schema = new Schema<ChatLineDocument>({
  tenant: { type: String, required: true },
  server_id: { type: String, required: true },
  at: { type: Date, required: true },
  channel: { type: String, enum: CHAT_CHANNELS, required: true },
  from: { type: String, required: true },
  audience: { type: [String], default: [] },
  sealed: { type: Schema.Types.Mixed, required: true },
  expires_at: { type: Date, required: true },
});

// One line per sender and moment: the plugin sends a batch again when it isn't sure it arrived.
schema.index({ tenant: 1, server_id: 1, from: 1, at: 1 }, { unique: true });
schema.index({ tenant: 1, server_id: 1, at: -1 });
schema.index({ tenant: 1, from: 1 });
schema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

export const ChatLineModel = model<ChatLineDocument>("ChatLine", schema, "chat_history");
