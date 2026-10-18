import { Schema, model } from "mongoose";
import type { SealedSecret } from "./secrets";

/** The settings the panel saved: plain values, and secrets sealed. `version` grows with every save. */
export interface StoredSettings {
  version: number;
  values: Record<string, string | number | boolean>;
  secrets: Record<string, SealedSecret>;
  updated_at?: Date;
  updated_by?: string;
}

export interface SettingsStore {
  load(): Promise<StoredSettings>;
  /** Saves when the stored version is still `expected`; false when someone saved in between. */
  save(next: StoredSettings, expected: number): Promise<boolean>;
}

const EMPTY: StoredSettings = { version: 0, values: {}, secrets: {} };

interface SettingsDocument extends StoredSettings {
  _id: string;
}

const schema = new Schema<SettingsDocument>(
  {
    _id: { type: String },
    version: { type: Number, required: true },
    values: { type: Schema.Types.Mixed, default: {} },
    secrets: { type: Schema.Types.Mixed, default: {} },
    updated_at: Date,
    updated_by: String,
  },
  { minimize: false },
);

const SettingsModel = model<SettingsDocument>("Settings", schema, "settings");

const ID = "settings";

export const mongoSettings: SettingsStore = {
  async load() {
    const doc = await SettingsModel.findById(ID).lean<SettingsDocument>();
    return doc ? { version: doc.version, values: doc.values ?? {}, secrets: doc.secrets ?? {}, updated_at: doc.updated_at, updated_by: doc.updated_by } : { ...EMPTY };
  },
  async save(next, expected) {
    const doc = { version: next.version, values: next.values, secrets: next.secrets, updated_at: next.updated_at, updated_by: next.updated_by };
    if (expected === 0) {
      try {
        await SettingsModel.create({ _id: ID, ...doc });
        return true;
      } catch (error) {
        if ((error as { code?: number }).code === 11000) return false;
        throw error;
      }
    }
    const result = await SettingsModel.updateOne({ _id: ID, version: expected }, { $set: doc });
    return result.modifiedCount === 1;
  },
};

/** For tests and local runs without MongoDB. */
export const memorySettings = (initial: StoredSettings = EMPTY): SettingsStore => {
  let stored = structuredClone(initial);
  return {
    async load() {
      return structuredClone(stored);
    },
    async save(next, expected) {
      if (stored.version !== expected) return false;
      stored = structuredClone(next);
      return true;
    },
  };
};
