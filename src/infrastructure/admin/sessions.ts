import { Schema, model } from "mongoose";

/** Who a panel session belongs to; the account itself is read on every request, so a new role applies at once. */
export interface AdminSession {
  username: string;
  created_at: string;
}

/** Panel sessions by a random id; only the id's digest is stored, so the database never holds a usable cookie. */
export interface SessionStore {
  create(username: string, ttlSeconds: number): Promise<string>;
  /** The session, its lifetime renewed, or null. */
  touch(id: string, ttlSeconds: number): Promise<AdminSession | null>;
  remove(id: string): Promise<void>;
  /** Signs an account out everywhere: after a new password, a new role, or deletion. */
  removeAll(username: string): Promise<void>;
}

const digest = (id: string) => new Bun.CryptoHasher("sha256").update(id).digest("hex");
const newId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

interface SessionDoc {
  hash: string;
  username: string;
  created_at: Date;
  expires_at: Date;
}

const schema = new Schema<SessionDoc>({
  hash: { type: String, required: true, unique: true },
  username: { type: String, required: true, index: true },
  created_at: { type: Date, required: true },
  expires_at: { type: Date, required: true },
});
// Only garbage collection: the monitor runs about once a minute, so touch checks expires_at itself.
schema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

export const AdminSessionModel = model<SessionDoc>("AdminSession", schema, "admin_sessions");

/** Panel sessions in MongoDB, exact to the second: an expired one never renews, and a touch that meets it deletes it. */
export const mongoSessions = (now: () => number = Date.now): SessionStore => {
  const sessions = () => AdminSessionModel.collection;
  return {
    async create(username, ttl) {
      const id = newId();
      const at = new Date(now());
      await sessions().insertOne({ hash: digest(id), username, created_at: at, expires_at: new Date(at.getTime() + ttl * 1000) });
      return id;
    },
    async touch(id, ttl) {
      const hash = digest(id);
      const at = new Date(now());
      const doc = await sessions().findOneAndUpdate({ hash, expires_at: { $gt: at } }, { $set: { expires_at: new Date(at.getTime() + ttl * 1000) } });
      if (!doc) {
        void sessions().deleteOne({ hash, expires_at: { $lte: at } }).catch(() => {});
        return null;
      }
      return { username: doc.username as string, created_at: (doc.created_at as Date).toISOString() };
    },
    async remove(id) {
      await sessions().deleteOne({ hash: digest(id) });
    },
    async removeAll(username) {
      await sessions().deleteMany({ username });
    },
  };
};

/** For tests: same rules, by the same clock. */
export const memorySessions = (now: () => number = Date.now): SessionStore => {
  const sessions = new Map<string, AdminSession & { until: number }>();
  return {
    async create(username, ttl) {
      const id = newId();
      sessions.set(digest(id), { username, created_at: new Date(now()).toISOString(), until: now() + ttl * 1000 });
      return id;
    },
    async touch(id, ttl) {
      const session = sessions.get(digest(id));
      if (!session || session.until <= now()) {
        sessions.delete(digest(id));
        return null;
      }
      session.until = now() + ttl * 1000;
      return { username: session.username, created_at: session.created_at };
    },
    async remove(id) {
      sessions.delete(digest(id));
    },
    async removeAll(username) {
      for (const [hash, session] of sessions) if (session.username === username) sessions.delete(hash);
    },
  };
};
