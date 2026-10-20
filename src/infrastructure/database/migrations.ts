import { ConsentModel } from "../../entities/consent/consent.model";
import { MemoryModel } from "../../entities/memory/memory.model";
import { logger } from "../../shared/logging/logger";
import { AuditModel } from "../admin/audit";
import { dropLegacySessions } from "../history/history";
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
 * lose players' ids and names, sessions without a tenant go, and days past RUN_DAYS forget who played.
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
  const dropped = await dropLegacySessions();
  if (dropped) logger.info(`Dropped ${dropped} chat sessions from before 6.0, which carry no tenant`);
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
