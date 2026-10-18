import { Schema, model } from "mongoose";

export const ROLES = ["owner", "admin", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** Someone who signs in to the admin panel. The password is kept as an argon2id hash only. */
export interface AdminAccount {
  username: string;
  password_hash: string;
  role: Role;
  created_at: Date;
  created_by?: string;
  last_login_at?: Date;
}

export interface AccountStore {
  count(): Promise<number>;
  get(username: string): Promise<AdminAccount | null>;
  list(): Promise<AdminAccount[]>;
  /** False when the name is taken. */
  create(account: AdminAccount): Promise<boolean>;
  update(username: string, patch: Partial<Omit<AdminAccount, "username">>): Promise<void>;
  remove(username: string): Promise<boolean>;
}

const schema = new Schema<AdminAccount>({
  username: { type: String, required: true, unique: true },
  password_hash: { type: String, required: true },
  role: { type: String, enum: ROLES, required: true },
  created_at: { type: Date, default: Date.now },
  created_by: String,
  last_login_at: Date,
});

const AccountModel = model<AdminAccount>("AdminAccount", schema, "admin_accounts");

const plain = ({ username, password_hash, role, created_at, created_by, last_login_at }: AdminAccount): AdminAccount => ({
  username,
  password_hash,
  role,
  created_at,
  ...(created_by ? { created_by } : {}),
  ...(last_login_at ? { last_login_at } : {}),
});

export const mongoAccounts: AccountStore = {
  async count() {
    return AccountModel.countDocuments();
  },
  async get(username) {
    const account = await AccountModel.findOne({ username }).lean<AdminAccount>();
    return account ? plain(account) : null;
  },
  async list() {
    return (await AccountModel.find().sort({ created_at: 1 }).lean<AdminAccount[]>()).map(plain);
  },
  async create(account) {
    try {
      await AccountModel.create(account);
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
  },
  async update(username, patch) {
    await AccountModel.updateOne({ username }, { $set: patch });
  },
  async remove(username) {
    return (await AccountModel.deleteOne({ username })).deletedCount > 0;
  },
};

/** For tests and local runs without MongoDB. */
export const memoryAccounts = (): AccountStore => {
  const accounts = new Map<string, AdminAccount>();
  return {
    async count() {
      return accounts.size;
    },
    async get(username) {
      const account = accounts.get(username);
      return account ? { ...account } : null;
    },
    async list() {
      return [...accounts.values()].map((a) => ({ ...a }));
    },
    async create(account) {
      if (accounts.has(account.username)) return false;
      accounts.set(account.username, { ...account });
      return true;
    },
    async update(username, patch) {
      const account = accounts.get(username);
      if (account) accounts.set(username, { ...account, ...patch });
    },
    async remove(username) {
      return accounts.delete(username);
    },
  };
};
