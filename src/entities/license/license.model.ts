import { Schema, model } from "mongoose";

/** A Minecraft server's subscription: who claimed it in Telegram, and how it renews. The secret is kept as SHA-256 only. */
export interface LicenseDocument {
  id: string;
  secret_hash: string;
  /** The server's name as the plugin sent it, for the bot. */
  name?: string;
  created_at: Date;
  claim_hash?: string;
  claim_expires?: Date;
  telegram_user_id?: number;
  telegram_chat_id?: number;
  language?: string;
  plan?: string;
  renews: boolean;
  subscription_charge_id?: string;
  last_payment_at?: Date;
  /** When the payer stopped the subscription's renewal in the bot. */
  stopped_at?: Date;
  /** Blocked in the admin panel: no questions and no payments until unblocked. */
  blocked_at?: Date;
  /** Refunded and revoked in the admin panel: its key stops working for good, and the server takes a new license. */
  revoked_at?: Date;
}

const licenseSchema = new Schema<LicenseDocument>({
  id: { type: String, required: true, unique: true },
  secret_hash: { type: String, required: true },
  name: { type: String, maxlength: 64 },
  created_at: { type: Date, default: Date.now },
  claim_hash: { type: String, index: { sparse: true } },
  claim_expires: Date,
  telegram_user_id: { type: Number, index: { sparse: true } },
  telegram_chat_id: Number,
  language: String,
  plan: String,
  renews: { type: Boolean, default: false },
  subscription_charge_id: String,
  last_payment_at: Date,
  stopped_at: Date,
  blocked_at: Date,
  revoked_at: Date,
});

/** One budget window a payment opened: dollars the server may spend between `starts` and `ends`. */
export interface GrantDocument {
  id: string;
  license: string;
  payment?: string;
  budget: number;
  spent: number;
  starts: Date;
  ends: Date;
}

const grantSchema = new Schema<GrantDocument>({
  id: { type: String, required: true, unique: true },
  license: { type: String, required: true, index: true },
  payment: { type: String, index: { sparse: true } },
  budget: { type: Number, required: true, min: 0 },
  spent: { type: Number, default: 0 },
  starts: { type: Date, required: true },
  ends: { type: Date, required: true },
});

/** A Telegram Stars payment; the charge id is what a refund needs. */
export interface PaymentDocument {
  charge_id: string;
  license: string;
  plan: string;
  stars: number;
  telegram_user_id: number;
  at: Date;
  recurring: boolean;
  refunded_at?: Date;
}

const paymentSchema = new Schema<PaymentDocument>({
  charge_id: { type: String, required: true, unique: true },
  license: { type: String, required: true, index: true },
  plan: { type: String, required: true },
  stars: { type: Number, required: true },
  telegram_user_id: { type: Number, required: true },
  at: { type: Date, default: Date.now },
  recurring: { type: Boolean, default: false },
  refunded_at: Date,
});

paymentSchema.index({ at: -1 });

export const LicenseModel = model<LicenseDocument>("License", licenseSchema);
export const GrantModel = model<GrantDocument>("Grant", grantSchema);
export const PaymentModel = model<PaymentDocument>("Payment", paymentSchema);
