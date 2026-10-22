import { ConsentModel } from "../../entities/consent/consent.model";
import { MemoryModel } from "../../entities/memory/memory.model";
import { logger } from "../../shared/logging/logger";
import { AuditModel } from "../admin/audit";
import { RedisClient } from "bun";
import mongoose from "mongoose";
import { AdminSessionModel } from "../admin/sessions";
import { OutcomesModel, SessionModel, sessionTtl, publicTtl, taskTtl } from "../history/history";
import { ERASED, PSEUDONYM, type Pseudonyms } from "../privacy/pseudonyms";
import { DayModel, RunModel } from "../runs/runs";

/** Runs and days from before 6.0 name players by id, and runs by name too: both become pseudonyms. Idempotent. */
export const pseudonymiseRuns = async (pseudonyms: Pseudonyms): Promise<number> => {
  const runs = RunModel.collection;
  const raw = (await runs.distinct("user_id", { user_id: { $not: PSEUDONYM, $ne: ERASED } })) as string[];
  for (const userId of raw) await runs.updateMany({ user_id: userId }, { $set: { user_id: pseudonyms.of(userId) } });
  // Not in the schema anymore, so only the driver itself can take it out.
  await runs.updateMany({ player: { $exists: true } }, { $unset: { player: "" } });
  const days = DayModel.collection;
  for await (const day of days.find({ players: { $elemMatch: { $not: PSEUDONYM } } }, { projection: { _id: 1, players: 1 } })) {
    const players = [...new Set((day.players as string[]).map((p) => (PSEUDONYM.test(p) ? p : pseudonyms.of(p))))];
    await days.updateOne({ _id: day._id }, { $set: { players } });
  }
  return raw.length;
};

/**
 * Brings data from before 6.0 up to date on every start; each step does nothing once done. Memories get their
 * tenant (`self` on a self-hosted backend, where everything is the operator's own) and a last-seen date, runs
 * lose players' ids and names, sessions move out of Redis once, and days past RUN_DAYS forget who played.
 */
export const migrate = async (options: { selfHosted: boolean; pseudonyms: Pseudonyms; now: Date }) => {
  const memories = MemoryModel.collection;
  if (options.selfHosted) {
    const tagged = await memories.updateMany({ tenant: { $exists: false } }, { $set: { tenant: "self" } });
    if (tagged.modifiedCount) logger.info(`Moved ${tagged.modifiedCount} memories to the tenant self`);
  } else {
    const untagged = await memories.countDocuments({ tenant: { $exists: false } });
    // Nobody can tell whose they are on a hosted backend: they wait for `migrate retag`, or `migrate purge-untagged`.
    if (untagged) logger.warn(`${untagged} memories have no tenant and reach nobody; see “Moving a self-hosted backend” in the wiki`);
  }
  await memories.updateMany({ seen_at: { $exists: false } }, { $set: { seen_at: options.now } });
  await MemoryModel.syncIndexes();
  await ConsentModel.syncIndexes();
  await AuditModel.syncIndexes();

  const pseudonymised = await pseudonymiseRuns(options.pseudonyms);
  if (pseudonymised) logger.info(`Replaced ${pseudonymised} players' ids in the statistics with pseudonyms`);
  await SessionModel.syncIndexes();
  await OutcomesModel.syncIndexes();
  await AdminSessionModel.syncIndexes();
  await moveRedisSessions();
};

/** Where Redis was, for the one move out of it: REDIS_URL, or the parts docker-compose used to pass. */
const redisUrl = (): string | undefined => {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  if (!process.env.REDIS_HOST) return undefined;
  const password = process.env.REDIS_PASSWORD ? `:${encodeURIComponent(process.env.REDIS_PASSWORD)}@` : "";
  return `redis://${password}${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}/${process.env.REDIS_DB || 0}`;
};

const MOVED_FROM_REDIS = "redis-sessions";

export interface MovedFromRedis {
  sessions: number;
  outcomes: number;
  admin_sessions: number;
}

/**
 * Before 6.8 sessions lived in Redis. Once, when Redis is still configured, the sessions of players, public threads,
 * and agents (only keys with a tenant), the pending outcomes, and the panel's sessions move to MongoDB with the time
 * they had left; MongoDB's copy wins where both exist, so a second run changes nothing. A mark in `migrations` keeps
 * later starts from touching Redis at all. When Redis can't be reached, the backend starts without the old sessions
 * and tries again next time.
 */
export const moveRedisSessions = async (url = redisUrl(), now = Date.now()): Promise<MovedFromRedis | undefined> => {
  if (!url) return undefined;
  const marks = mongoose.connection.collection<{ _id: string; at: Date }>("migrations");
  if (await marks.findOne({ _id: MOVED_FROM_REDIS })) return undefined;
  const redis = new RedisClient(url, { connectionTimeout: 5_000, autoReconnect: false });
  const moved: MovedFromRedis = { sessions: 0, outcomes: 0, admin_sessions: 0 };
  try {
    const scan = async (pattern: string): Promise<string[]> => {
      const found: string[] = [];
      let cursor = "0";
      do {
        const [next, keys] = (await redis.send("SCAN", [cursor, "MATCH", pattern, "COUNT", "500"])) as [string, string[]];
        found.push(...keys);
        cursor = next;
      } while (cursor !== "0");
      return found;
    };
    const tagged = (key: string) => key.startsWith("self:") || key.startsWith("license:");
    /** When a key expires, from its PTTL; a key without one gets the default its kind lives. */
    const until = async (key: string, fallback: number) => {
      const left = Number(await redis.send("PTTL", [key]));
      return left === -2 ? undefined : new Date(now + (left > 0 ? left : fallback * 1000));
    };
    const ttlFor = (key: string) => (key.includes(":t:") ? taskTtl() : key.includes(":p:") ? publicTtl() : sessionTtl());

    const threads = new Set(
      [...(await scan("chat_history:*")), ...(await scan("chat_summary:*"))].map((key) => key.slice(key.indexOf(":") + 1)).filter(tagged),
    );
    for (const thread of threads) {
      const exchanges = ((await redis.send("LRANGE", [`chat_history:${thread}`, "0", "-1"])) as string[] | null) ?? [];
      const summary = await redis.get(`chat_summary:${thread}`);
      const expires = (await until(`chat_history:${thread}`, ttlFor(thread))) ?? (await until(`chat_summary:${thread}`, ttlFor(thread)));
      if (!expires) continue;
      const done = await SessionModel.collection.updateOne(
        { key: thread },
        { $setOnInsert: { key: thread, started: crypto.randomUUID(), exchanges, ...(summary ? { summary } : {}), expires_at: expires } },
        { upsert: true },
      );
      moved.sessions += done.upsertedCount;
    }
    for (const found of await scan("task_outcomes:*")) {
      const thread = found.slice("task_outcomes:".length);
      if (!tagged(thread)) continue;
      const outcomes = ((await redis.send("LRANGE", [found, "0", "-1"])) as string[] | null) ?? [];
      const expires = await until(found, sessionTtl());
      if (!expires || outcomes.length === 0) continue;
      const done = await OutcomesModel.collection.updateOne({ key: thread }, { $setOnInsert: { key: thread, outcomes, expires_at: expires } }, { upsert: true });
      moved.outcomes += done.upsertedCount;
    }
    for (const found of await scan("admin_session:*")) {
      const raw = await redis.get(found);
      const expires = await until(found, 0);
      if (!raw || !expires || expires.getTime() <= now) continue;
      const session = JSON.parse(raw) as { username?: string; created_at?: string };
      if (!session.username) continue;
      const hash = found.slice("admin_session:".length);
      const done = await AdminSessionModel.collection.updateOne(
        { hash },
        { $setOnInsert: { hash, username: session.username, created_at: new Date(session.created_at ?? now), expires_at: expires } },
        { upsert: true },
      );
      moved.admin_sessions += done.upsertedCount;
    }
    await marks.updateOne({ _id: MOVED_FROM_REDIS }, { $set: { at: new Date(now) } }, { upsert: true });
    logger.info(`Moved from Redis to MongoDB: ${moved.sessions} chat sessions, ${moved.outcomes} pending outcomes, ${moved.admin_sessions} panel sessions; Redis is no longer used`);
    return moved;
  } catch (error) {
    logger.warn(`Couldn't move sessions from Redis, starting without them; trying again on the next start: ${String(error)}`);
    return undefined;
  } finally {
    redis.close();
  }
};

export interface Retagged {
  memories: number;
  consents: number;
  runs: number;
  days: number;
  pseudonymised: number;
}

const memoriesOf = (tenant: string) => (tenant === "self" ? { $or: [{ tenant: "self" }, { tenant: { $exists: false } }] } : { tenant });

/**
 * Moves one tenant's data to another, for a self-hosted backend's dump imported into a hosted one: memories, consents,
 * and runs from `self` (memories without a tenant count as `self`) become `license:<id>`. Settings, admin accounts, the
 * audit log, and traces belong to the backend, not a tenant, and stay as they are. Idempotent: a second run finds
 * nothing left to move.
 */
export const retag = async (options: { from: string; to: string; pseudonyms: Pseudonyms; dryRun?: boolean; now?: Date }): Promise<Retagged> => {
  const { from, to } = options;
  const memories = MemoryModel.collection;
  const runs = RunModel.collection;
  const days = DayModel.collection;
  if (options.dryRun) {
    return {
      memories: await memories.countDocuments(memoriesOf(from)),
      consents: await ConsentModel.collection.countDocuments({ tenant: from }),
      runs: await runs.countDocuments({ server: from }),
      days: await days.countDocuments({ servers: from }),
      pseudonymised: (await runs.distinct("user_id", { user_id: { $not: PSEUDONYM, $ne: ERASED } })).length,
    };
  }
  let moved = 0;
  // One by one: a memory whose short id the target already holds for that player gets a new one instead of failing.
  for await (const memory of memories.find(memoriesOf(from), { projection: { _id: 1, user_id: 1 } })) {
    for (let attempt = 0; ; attempt++) {
      try {
        const id = attempt ? { id: crypto.randomUUID().replace(/-/g, "").slice(0, 5) } : {};
        await memories.updateOne({ _id: memory._id }, { $set: { tenant: to, ...id } });
        moved++;
        break;
      } catch (error) {
        if ((error as { code?: number }).code !== 11000 || attempt >= 5) throw error;
      }
    }
  }
  await memories.updateMany({ seen_at: { $exists: false } }, { $set: { seen_at: options.now ?? new Date() } });
  // A player who agreed on both keeps the newer agreement.
  const consents = ConsentModel.collection;
  let movedConsents = 0;
  for await (const consent of consents.find({ tenant: from })) {
    const there = await consents.findOne({ tenant: to, user_id: consent.user_id });
    if (there && there.accepted_at >= consent.accepted_at) await consents.deleteOne({ _id: consent._id });
    else {
      if (there) await consents.deleteOne({ _id: there._id });
      await consents.updateOne({ _id: consent._id }, { $set: { tenant: to } });
      movedConsents++;
    }
  }
  const movedRuns = await runs.updateMany({ server: from }, { $set: { server: to } });
  const movedDays = await days.updateMany({ servers: from }, [{ $set: { servers: { $setUnion: [{ $setDifference: ["$servers", [from]] }, [to]] } } }]);
  const pseudonymised = await pseudonymiseRuns(options.pseudonyms);
  return { memories: moved, consents: movedConsents, runs: movedRuns.modifiedCount, days: movedDays.modifiedCount, pseudonymised };
};

/** On a hosted backend: memories nobody can attribute to a tenant are deleted, since they reach nobody. */
export const purgeUntagged = async (): Promise<number> => (await MemoryModel.collection.deleteMany({ tenant: { $exists: false } })).deletedCount;

/** How much each tenant holds, to check a move before and after. */
export const tenantCounts = async () => ({
  memories: await MemoryModel.collection.aggregate([{ $group: { _id: { $ifNull: ["$tenant", "(none)"] }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray(),
  runs: await RunModel.collection.aggregate([{ $group: { _id: "$server", n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray(),
});
