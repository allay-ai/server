import { createHash, randomBytes } from "node:crypto";
import { EXPORT_HOURS, ExportModel } from "../../entities/export/export.model";
import type { Owner } from "../../shared/types/owner";

export interface IssuedExport {
  token: string;
  expires_at: string;
}

/**
 * One-day links to a player's copy of their data. The token is the only key, 32 random bytes; the backend keeps its
 * SHA-256, so neither a dump nor the panel can rebuild a link.
 */
export interface ExportStore {
  issue(owner: Owner): Promise<IssuedExport>;
  /** Whose copy [token] opens, counting the download; null once expired or unknown. */
  redeem(token: string): Promise<Owner | null>;
  /** Erasure: the player's open links stop working. */
  revoke(owner: Owner): Promise<number>;
}

const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const mongoExports = (now: () => number = Date.now): ExportStore => ({
  async issue(owner) {
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(now() + EXPORT_HOURS * 3_600_000);
    await ExportModel.create({ hash: digest(token), tenant: owner.tenant, user_id: owner.userId, created_at: new Date(now()), expires_at: expires });
    return { token, expires_at: expires.toISOString() };
  },
  async redeem(token) {
    if (!TOKEN.test(token)) return null;
    const doc = await ExportModel.findOneAndUpdate({ hash: digest(token), expires_at: { $gt: new Date(now()) } }, { $inc: { downloads: 1 } }).lean();
    return doc ? { tenant: doc.tenant, userId: doc.user_id } : null;
  },
  async revoke(owner) {
    return (await ExportModel.deleteMany({ tenant: owner.tenant, user_id: owner.userId })).deletedCount;
  },
});

/** For tests and local runs without MongoDB. */
export const memoryExports = (now: () => number = Date.now): ExportStore & { issued: () => number } => {
  const store = new Map<string, { owner: Owner; until: number }>();
  return {
    issued: () => store.size,
    async issue(owner) {
      const token = randomBytes(32).toString("base64url");
      const until = now() + EXPORT_HOURS * 3_600_000;
      store.set(digest(token), { owner, until });
      return { token, expires_at: new Date(until).toISOString() };
    },
    async redeem(token) {
      if (!TOKEN.test(token)) return null;
      const found = store.get(digest(token));
      return found && found.until > now() ? found.owner : null;
    },
    async revoke(owner) {
      let count = 0;
      for (const [hash, link] of store) {
        if (link.owner.tenant === owner.tenant && link.owner.userId === owner.userId) {
          store.delete(hash);
          count++;
        }
      }
      return count;
    },
  };
};
