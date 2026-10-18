import { redis } from "bun";

/** Who a panel session belongs to; the account itself is read on every request, so a new role applies at once. */
export interface AdminSession {
  username: string;
  created_at: string;
}

/** Panel sessions by a random id; only the id's digest is a key, so Redis never holds a usable cookie. */
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

const key = (hash: string) => `admin_session:${hash}`;
const indexKey = (username: string) => `admin_sessions_of:${username}`;

export const redisSessions: SessionStore = {
  async create(username, ttl) {
    const id = newId();
    const hash = digest(id);
    const session: AdminSession = { username, created_at: new Date().toISOString() };
    await redis.set(key(hash), JSON.stringify(session), "EX", ttl);
    await redis.send("SADD", [indexKey(username), hash]);
    await redis.expire(indexKey(username), ttl);
    return id;
  },
  async touch(id, ttl) {
    const hash = digest(id);
    const raw = await redis.get(key(hash));
    if (!raw) return null;
    await redis.expire(key(hash), ttl);
    const session = JSON.parse(raw) as AdminSession;
    await redis.expire(indexKey(session.username), ttl);
    return session;
  },
  async remove(id) {
    const hash = digest(id);
    const raw = await redis.get(key(hash));
    await redis.del(key(hash));
    if (raw) await redis.send("SREM", [indexKey((JSON.parse(raw) as AdminSession).username), hash]);
  },
  async removeAll(username) {
    const hashes = (await redis.send("SMEMBERS", [indexKey(username)])) as string[];
    if (hashes?.length) await redis.del(...hashes.map(key));
    await redis.del(indexKey(username));
  },
};

/** For tests: same rules, a clock instead of Redis expiry. */
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
      if (!session || session.until <= now()) return null;
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
