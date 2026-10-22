import { Schema, model } from "mongoose";

/** One thing an admin did: who, what, to what, and the values before and after (secrets masked). */
export interface AuditEntry {
  at: Date;
  actor: string;
  action: string;
  target?: string;
  changes?: Array<{ field: string; old: string; new: string }>;
  ip?: string;
}

export interface AuditStore {
  add(entry: AuditEntry): Promise<void>;
  /** Newest first, `before` pages back; `actor` and `area` (the action's first part, like `license`) narrow it. */
  list(options: { limit: number; before?: Date; actor?: string; area?: string }): Promise<AuditEntry[]>;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Entries hold addresses, so they don't stay forever: two years cover any question about who changed what. */
export const AUDIT_DAYS = 730;

const schema = new Schema<AuditEntry>({
  at: { type: Date, required: true },
  actor: { type: String, required: true },
  action: { type: String, required: true },
  target: String,
  changes: [{ _id: false, field: String, old: String, new: String }],
  ip: String,
});

schema.index({ at: 1 }, { expireAfterSeconds: AUDIT_DAYS * 86_400 });

export const AuditModel = model<AuditEntry>("AuditEntry", schema, "admin_audit");

export const mongoAudit: AuditStore = {
  async add(entry) {
    await AuditModel.create(entry);
  },
  async list({ limit, before, actor, area }) {
    const filter = { ...(before ? { at: { $lt: before } } : {}), ...(actor ? { actor } : {}), ...(area ? { action: { $regex: `^${escape(area)}\\.` } } : {}) };
    return AuditModel.find(filter, { _id: 0, __v: 0 })
      .sort({ at: -1 })
      .limit(limit)
      .lean<AuditEntry[]>();
  },
};

export const memoryAudit = (): AuditStore & { entries: AuditEntry[] } => {
  const entries: AuditEntry[] = [];
  return {
    entries,
    async add(entry) {
      entries.push({ ...entry });
    },
    async list({ limit, before, actor, area }) {
      return entries
        .filter((e) => (!before || e.at < before) && (!actor || e.actor === actor) && (!area || e.action.startsWith(`${area}.`)))
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, limit);
    },
  };
};
