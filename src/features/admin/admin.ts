import { timingSafeEqual } from "node:crypto";
import type { AccountStore, AdminAccount, Role } from "../../infrastructure/admin/accounts";
import type { AuditEntry, AuditStore } from "../../infrastructure/admin/audit";
import type { SessionStore } from "../../infrastructure/admin/sessions";
import { logger } from "../../shared/logging/logger";
import type { Settings } from "../settings/settings";

/** An owner defined by ADMIN_USERNAME with ADMIN_PASSWORD or ADMIN_PASSWORD_HASH; it can't change in the panel. */
export interface EnvAdmin {
  username: string;
  verify(password: string): Promise<boolean>;
}

/** What the admin panel's API needs; production builds it at start, tests from in-memory stores. */
export interface AdminDeps {
  accounts: AccountStore;
  sessions: SessionStore;
  audit: AuditStore;
  settings: Settings;
  setup: SetupCodes;
  envAdmin?: EnvAdmin;
  /** SELFHOSTED: setup takes a code from /allay init instead of the log's. */
  selfHosted: boolean;
  limiter: LoginLimiter;
  now: () => Date;
}

export const SESSION_TTL = 7 * 86_400;
export const COOKIE = "allay_admin";

export const USERNAME = /^[a-z0-9][a-z0-9_.-]{1,31}$/;
export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 200;

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const same = (a: string, b: string) => timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));

export const hashPassword = (password: string) => Bun.password.hash(password, { algorithm: "argon2id" });

/** The environment's owner, or none when ADMIN_USERNAME is unset. A plain password is compared by digest. */
export const envAdminOf = (env: Record<string, string | undefined> = process.env): EnvAdmin | undefined => {
  const username = env.ADMIN_USERNAME?.trim().toLowerCase();
  if (!username) return undefined;
  const hash = env.ADMIN_PASSWORD_HASH?.trim();
  const password = env.ADMIN_PASSWORD;
  if (!hash && !password) {
    logger.warn("ADMIN_USERNAME is set without ADMIN_PASSWORD or ADMIN_PASSWORD_HASH; nobody can sign in as it");
    return undefined;
  }
  return {
    username,
    verify: async (given) => (hash ? Bun.password.verify(given, hash).catch(() => false) : same(given, password!)),
  };
};

/** The roles in order of what they may do. */
const RANK: Record<Role, number> = { viewer: 0, admin: 1, owner: 2 };
export const allows = (role: Role, needed: Role) => RANK[role] >= RANK[needed];

/** Who is signed in, whether from MongoDB or the environment. */
export interface Admin {
  username: string;
  role: Role;
  /** Defined in the environment: can't be changed or deleted here. */
  env: boolean;
}

export const adminOf = (account: AdminAccount): Admin => ({ username: account.username, role: account.role, env: false });

/** Whether the panel still needs its first account: none in MongoDB and none in the environment. */
export const needsSetup = async (deps: AdminDeps) => !deps.envAdmin && (await deps.accounts.count()) === 0;

const CODE_TTL = 30 * 60_000;

/**
 * One-time codes that let someone create the first account. A self-hosted backend hands them out through
 * /allay init, one at a time for 30 minutes; a hosted one prints one to its log at start.
 */
export class SetupCodes {
  private pending?: { hash: string; until: number };

  constructor(private readonly now: () => number = Date.now) {}

  /** A new code that replaces any pending one; null keeps it until it's used or the backend restarts. */
  issue(ttl: number | null = CODE_TTL): { code: string; expires: Date | null } {
    const code = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
    const until = ttl === null ? Number.POSITIVE_INFINITY : this.now() + ttl;
    this.pending = { hash: sha256(code), until };
    return { code, expires: ttl === null ? null : new Date(until) };
  }

  /** Whether the code is the pending one and still alive; it doesn't spend it. */
  check(code: string): boolean {
    if (!this.pending || this.pending.until <= this.now()) return false;
    return timingSafeEqual(Buffer.from(sha256(code)), Buffer.from(this.pending.hash));
  }

  /** Spends the pending code once it has made an account. */
  spend() {
    this.pending = undefined;
  }
}

/**
 * Failed sign-ins per address and per name, in memory: 10 failures from one address or 5 for one name
 * within 15 minutes lock that for the rest of the window. A success clears the name.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs = 15 * 60_000,
    private readonly perAddress = 10,
    private readonly perName = 5,
  ) {}

  private left(key: string, max: number): number {
    const entry = this.failures.get(key);
    if (!entry || this.now() - entry.start >= this.windowMs) return 0;
    return entry.count >= max ? Math.ceil((entry.start + this.windowMs - this.now()) / 1000) : 0;
  }

  /** Seconds to wait, or 0 when this sign-in may be tried. */
  blocked(address: string, username: string): number {
    return Math.max(this.left(`ip:${address}`, this.perAddress), this.left(`name:${username}`, this.perName));
  }

  fail(address: string, username: string) {
    for (const key of [`ip:${address}`, `name:${username}`]) {
      const entry = this.failures.get(key);
      if (!entry || this.now() - entry.start >= this.windowMs) this.failures.set(key, { start: this.now(), count: 1 });
      else entry.count++;
    }
    if (this.failures.size > 50_000) this.failures.clear();
  }

  succeed(username: string) {
    this.failures.delete(`name:${username}`);
  }
}

// Spent on unknown names too, so timing doesn't tell which names exist.
let dummyHash: Promise<string> | undefined;

/** The admin these credentials name, or null. */
export const authenticate = async (deps: AdminDeps, username: string, password: string): Promise<Admin | null> => {
  if (deps.envAdmin && username === deps.envAdmin.username) {
    return (await deps.envAdmin.verify(password)) ? { username, role: "owner", env: true } : null;
  }
  const account = await deps.accounts.get(username);
  if (!account) {
    dummyHash ??= hashPassword("not a password of anyone");
    await Bun.password.verify(password, await dummyHash).catch(() => false);
    return null;
  }
  return (await Bun.password.verify(password, account.password_hash).catch(() => false)) ? adminOf(account) : null;
};

/** The admin a session names, if the account still exists. */
export const adminNamed = async (deps: AdminDeps, username: string): Promise<Admin | null> => {
  if (deps.envAdmin?.username === username) return { username, role: "owner", env: true };
  const account = await deps.accounts.get(username);
  return account ? adminOf(account) : null;
};

/** Writes what an admin did; a failed write is logged, never fatal. */
export const record = async (deps: AdminDeps, entry: Omit<AuditEntry, "at">) => {
  try {
    await deps.audit.add({ at: deps.now(), ...entry });
  } catch (error) {
    logger.error(`Couldn't write the audit entry ${entry.action}: ${String(error)}`);
  }
};
