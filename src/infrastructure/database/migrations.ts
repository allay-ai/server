import { ConsentModel } from "../../entities/consent/consent.model";
import { MemoryModel } from "../../entities/memory/memory.model";
import { DeathModel } from "../../entities/death/death.model";
import { ExportModel } from "../../entities/export/export.model";
import { PlayerModel } from "../../entities/player/player.model";
import { ServerModel } from "../../entities/server/server.model";
import { StateModel } from "../../entities/state/state.model";
import { AuditModel } from "../admin/audit";
import { AdminSessionModel } from "../admin/sessions";
import { OutcomesModel, SessionModel } from "../history/history";
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
 * Brings every collection's indexes in line with the code at start: a changed retention is a changed TTL index, and
 * syncIndexes drops the old one and builds the new. Data stays as it is: since 6.9 nothing is rewritten at start.
 */
export const prepareDatabase = async () => {
  for (const model of [
    MemoryModel, DeathModel, StateModel, ExportModel, ConsentModel, PlayerModel, ServerModel, RunModel, DayModel, AuditModel,
    SessionModel, OutcomesModel, AdminSessionModel,
  ] as Array<{ syncIndexes(): Promise<unknown> }>) {
    await model.syncIndexes();
  }
};

export interface Retagged {
  memories: number;
  deaths: number;
  states: number;
  consents: number;
  runs: number;
  days: number;
  pseudonymised: number;
}

const memoriesOf = (tenant: string) => (tenant === "self" ? { $or: [{ tenant: "self" }, { tenant: { $exists: false } }] } : { tenant });

/**
 * Moves one tenant's data to another, for a self-hosted backend's dump imported into a hosted one: memories, deaths,
 * players' state, consents, and runs from `self` (memories without a tenant count as `self`) become `license:<id>`.
 * Settings, admin accounts, the audit log, and traces belong to the backend, not a tenant, and stay as they are.
 * Sealed data opens only with the key it was sealed with: both backends need the same SECRETS_KEY. Idempotent: a
 * second run finds nothing left to move.
 */
export const retag = async (options: { from: string; to: string; pseudonyms: Pseudonyms; dryRun?: boolean; now?: Date }): Promise<Retagged> => {
  const { from, to } = options;
  const memories = MemoryModel.collection;
  const runs = RunModel.collection;
  const days = DayModel.collection;
  if (options.dryRun) {
    return {
      memories: await memories.countDocuments(memoriesOf(from)),
      deaths: await DeathModel.collection.countDocuments({ tenant: from }),
      states: await StateModel.collection.countDocuments({ tenant: from }),
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
  const movedDeaths = await DeathModel.collection.updateMany({ tenant: from }, { $set: { tenant: to } });
  // A player with a state on both keeps the newer one.
  const states = StateModel.collection;
  let movedStates = 0;
  for await (const state of states.find({ tenant: from })) {
    const there = await states.findOne({ tenant: to, user_id: state.user_id });
    if (there && there.updated_at >= state.updated_at) await states.deleteOne({ _id: state._id });
    else {
      if (there) await states.deleteOne({ _id: there._id });
      await states.updateOne({ _id: state._id }, { $set: { tenant: to } });
      movedStates++;
    }
  }
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
  return { memories: moved, deaths: movedDeaths.modifiedCount, states: movedStates, consents: movedConsents, runs: movedRuns.modifiedCount, days: movedDays.modifiedCount, pseudonymised };
};

/** On a hosted backend: memories nobody can attribute to a tenant are deleted, since they reach nobody. */
export const purgeUntagged = async (): Promise<number> => (await MemoryModel.collection.deleteMany({ tenant: { $exists: false } })).deletedCount;

/** How much each tenant holds, to check a move before and after. */
export const tenantCounts = async () => ({
  memories: await MemoryModel.collection.aggregate([{ $group: { _id: { $ifNull: ["$tenant", "(none)"] }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray(),
  runs: await RunModel.collection.aggregate([{ $group: { _id: "$server", n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray(),
});
