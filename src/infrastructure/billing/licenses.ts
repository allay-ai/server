import { GrantModel, type LicenseDocument, LicenseModel, PaymentModel } from "../../entities/license/license.model";

export type LicenseRecord = LicenseDocument;

export interface GrantRecord {
  id: string;
  license: string;
  payment?: string;
  budget: number;
  spent: number;
  starts: Date;
  ends: Date;
}

export interface PaymentRecord {
  charge_id: string;
  license: string;
  plan: string;
  stars: number;
  telegram_user_id: number;
  at: Date;
  recurring: boolean;
  refunded_at?: Date;
}

/** Licenses, their budget windows, and the payments that opened them. MongoDB, next to the memories. */
export interface LicenseStore {
  create(license: LicenseRecord): Promise<void>;
  get(id: string): Promise<LicenseRecord | null>;
  update(id: string, patch: Partial<LicenseRecord>): Promise<void>;
  /** Takes a claim code once: returns its license and forgets the code, or null when it's unknown or expired. */
  claim(claimHash: string, now: Date): Promise<LicenseRecord | null>;
  ofTelegram(userId: number): Promise<LicenseRecord[]>;
  grants(license: string): Promise<GrantRecord[]>;
  /** Records a payment with its windows; false when this charge was already counted. */
  pay(payment: PaymentRecord, grants: Array<Omit<GrantRecord, "id" | "spent" | "license" | "payment">>): Promise<boolean>;
  payment(chargeId: string): Promise<PaymentRecord | null>;
  /** Marks a payment refunded and closes the windows it opened. */
  refund(chargeId: string, at: Date): Promise<PaymentRecord | null>;
  charge(grantId: string, usd: number): Promise<void>;
  /** Newest first, for the admin panel; `search` matches the id or the name's start. */
  list(options: { search?: string; limit: number; skip: number }): Promise<{ licenses: LicenseRecord[]; total: number }>;
  /** Newest first. */
  payments(options: { license?: string; from?: Date; before?: Date; limit: number }): Promise<PaymentRecord[]>;
  /** A budget window an admin gave by hand, without a payment. */
  grant(license: string, window: Pick<GrantRecord, "budget" | "starts" | "ends">): Promise<GrantRecord>;
  moveEnd(grantId: string, ends: Date): Promise<void>;
  /** How many licenses stopped renewal since a time. */
  stoppedSince(from: Date): Promise<number>;
}

const id = () => crypto.randomUUID().replace(/-/g, "");

const grantRecord = (g: GrantRecord): GrantRecord => ({
  id: g.id,
  license: g.license,
  payment: g.payment,
  budget: g.budget,
  spent: g.spent,
  starts: g.starts,
  ends: g.ends,
});

export const mongoLicenses: LicenseStore = {
  async create(license) {
    await LicenseModel.create(license);
  },
  async get(licenseId) {
    return LicenseModel.findOne({ id: licenseId }).lean<LicenseRecord>();
  },
  async update(licenseId, patch) {
    await LicenseModel.updateOne({ id: licenseId }, { $set: patch });
  },
  async claim(claimHash, now) {
    return LicenseModel.findOneAndUpdate(
      { claim_hash: claimHash, claim_expires: { $gt: now } },
      { $unset: { claim_hash: 1, claim_expires: 1 } },
      { returnDocument: "after" },
    ).lean<LicenseRecord>();
  },
  async ofTelegram(userId) {
    return LicenseModel.find({ telegram_user_id: userId }).sort({ created_at: 1 }).lean<LicenseRecord[]>();
  },
  async grants(license) {
    return (await GrantModel.find({ license }).lean<GrantRecord[]>()).map(grantRecord);
  },
  async pay(payment, grants) {
    try {
      await PaymentModel.create(payment);
    } catch (error) {
      // The unique charge id: Telegram delivered this payment twice.
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
    await GrantModel.insertMany(grants.map((g) => ({ ...g, id: id(), license: payment.license, payment: payment.charge_id, spent: 0 })));
    return true;
  },
  async payment(chargeId) {
    return PaymentModel.findOne({ charge_id: chargeId }).lean<PaymentRecord>();
  },
  async refund(chargeId, at) {
    const payment = await PaymentModel.findOneAndUpdate(
      { charge_id: chargeId, refunded_at: { $exists: false } },
      { $set: { refunded_at: at } },
      { returnDocument: "after" },
    ).lean<PaymentRecord>();
    if (payment) await GrantModel.deleteMany({ payment: chargeId });
    return payment;
  },
  async charge(grantId, usd) {
    await GrantModel.updateOne({ id: grantId }, { $inc: { spent: usd } });
  },
  async list({ search, limit, skip }) {
    const filter = search ? { $or: [{ id: search }, { name: { $regex: `^${search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, $options: "i" } }] } : {};
    const [licenses, total] = await Promise.all([
      LicenseModel.find(filter, { _id: 0, __v: 0 }).sort({ created_at: -1 }).skip(skip).limit(limit).lean<LicenseRecord[]>(),
      LicenseModel.countDocuments(filter),
    ]);
    return { licenses, total };
  },
  async payments({ license, from, before, limit }) {
    const at = { ...(from ? { $gte: from } : {}), ...(before ? { $lt: before } : {}) };
    return PaymentModel.find({ ...(license ? { license } : {}), ...(from || before ? { at } : {}) }, { _id: 0, __v: 0 })
      .sort({ at: -1 })
      .limit(limit)
      .lean<PaymentRecord[]>();
  },
  async grant(license, window) {
    const grant: GrantRecord = { ...window, id: id(), license, spent: 0 };
    await GrantModel.create(grant);
    return grant;
  },
  async moveEnd(grantId, ends) {
    await GrantModel.updateOne({ id: grantId }, { $set: { ends } });
  },
  async stoppedSince(from) {
    return LicenseModel.countDocuments({ stopped_at: { $gte: from } });
  },
};

/** For tests and local runs without MongoDB. */
export const memoryLicenses = (): LicenseStore => {
  const licenses = new Map<string, LicenseRecord>();
  const grants: GrantRecord[] = [];
  const payments = new Map<string, PaymentRecord>();
  return {
    async create(license) {
      licenses.set(license.id, { ...license });
    },
    async get(licenseId) {
      const license = licenses.get(licenseId);
      return license ? { ...license } : null;
    },
    async update(licenseId, patch) {
      const license = licenses.get(licenseId);
      if (license) licenses.set(licenseId, { ...license, ...patch });
    },
    async claim(claimHash, now) {
      const license = [...licenses.values()].find((l) => l.claim_hash === claimHash && l.claim_expires && l.claim_expires > now);
      if (!license) return null;
      const { claim_hash: _, claim_expires: __, ...rest } = license;
      licenses.set(license.id, rest);
      return { ...rest };
    },
    async ofTelegram(userId) {
      return [...licenses.values()].filter((l) => l.telegram_user_id === userId).map((l) => ({ ...l }));
    },
    async grants(license) {
      return grants.filter((g) => g.license === license).map((g) => ({ ...g }));
    },
    async pay(payment, windows) {
      if (payments.has(payment.charge_id)) return false;
      payments.set(payment.charge_id, { ...payment });
      for (const w of windows) grants.push({ ...w, id: id(), license: payment.license, payment: payment.charge_id, spent: 0 });
      return true;
    },
    async payment(chargeId) {
      const payment = payments.get(chargeId);
      return payment ? { ...payment } : null;
    },
    async refund(chargeId, at) {
      const payment = payments.get(chargeId);
      if (!payment || payment.refunded_at) return null;
      payment.refunded_at = at;
      for (let i = grants.length - 1; i >= 0; i--) if (grants[i].payment === chargeId) grants.splice(i, 1);
      return { ...payment };
    },
    async charge(grantId, usd) {
      const grant = grants.find((g) => g.id === grantId);
      if (grant) grant.spent += usd;
    },
    async list({ search, limit, skip }) {
      const found = [...licenses.values()]
        .filter((l) => !search || l.id === search || l.name?.toLowerCase().startsWith(search.toLowerCase()))
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      return { licenses: found.slice(skip, skip + limit).map((l) => ({ ...l })), total: found.length };
    },
    async payments({ license, from, before, limit }) {
      return [...payments.values()]
        .filter((p) => (!license || p.license === license) && (!from || p.at >= from) && (!before || p.at < before))
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, limit)
        .map((p) => ({ ...p }));
    },
    async grant(license, window) {
      const grant: GrantRecord = { ...window, id: id(), license, spent: 0 };
      grants.push(grant);
      return { ...grant };
    },
    async moveEnd(grantId, ends) {
      const grant = grants.find((g) => g.id === grantId);
      if (grant) grant.ends = ends;
    },
    async stoppedSince(from) {
      return [...licenses.values()].filter((l) => l.stopped_at && l.stopped_at >= from).length;
    },
  };
};
