import { z } from "zod";
import { ROLES } from "../../infrastructure/admin/accounts";
import { isOpenRouter } from "../../infrastructure/providers/openrouter/openrouter.client";
import { logger } from "../../shared/logging/logger";
import { catalogCheck } from "../billing/byok";
import { HOSTED_GROUPS } from "../settings/settings.definitions";
import {
  type AdminDeps,
  MAX_PASSWORD,
  MIN_PASSWORD,
  SESSION_TTL,
  USERNAME,
  adminNamed,
  authenticate,
  hashPassword,
  needsSetup,
  record,
} from "./admin";
import { checkBot, checkModel, checkPerplexity } from "./admin.checks";
import { type Context, type Route, body, cookieOf, error, sessionCookie } from "./admin.http";

const VERSION = process.env.APP_VERSION || "dev";

const username = z.string().trim().toLowerCase().regex(USERNAME, "2–32 lowercase letters, digits, . _ or -");
const password = z.string().min(MIN_PASSWORD, `at least ${MIN_PASSWORD} characters`).max(MAX_PASSWORD);

const invalid = (issues: z.core.$ZodIssue[]) =>
  error(400, "BAD_REQUEST", issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), {
    fields: Object.fromEntries(issues.map((i) => [i.path.join("."), i.message])),
  });

const parse = async <T extends z.ZodType>(ctx: Context, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: Response }> => {
  const parsed = schema.safeParse(await body(ctx.req));
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, response: invalid(parsed.error.issues) };
};

/** Signs in: a fresh session and its cookie. */
const signIn = async (ctx: Context, name: string, status = 200) => {
  const id = await ctx.admin.sessions.create(name, SESSION_TTL);
  const me = await adminNamed(ctx.admin, name);
  return Response.json({ me }, { status, headers: { "Set-Cookie": sessionCookie(ctx.req, id) } });
};

/** The owners left if `username` stopped being one; the environment's owner counts. */
const otherOwners = async (admin: AdminDeps, username: string) =>
  (admin.envAdmin ? 1 : 0) + (await admin.accounts.list()).filter((a) => a.role === "owner" && a.username !== username).length;

const setupSchema = z.object({ code: z.string().min(1).max(100), username, password });
const loginSchema = z.object({ username: z.string().trim().toLowerCase().min(1).max(64), password: z.string().min(1).max(MAX_PASSWORD) });
const recoverSchema = z.object({ code: z.string().min(1).max(100), username: z.string().trim().toLowerCase().min(1).max(64), password });

export const accessRoutes: Route[] = [
  {
    method: "GET",
    path: "/state",
    access: "public",
    async handle({ req, admin, deps }) {
      const id = cookieOf(req);
      const session = id ? await admin.sessions.touch(id, SESSION_TTL) : null;
      const setup = await needsSetup(admin);
      return Response.json({
        version: VERSION,
        selfhosted: admin.selfHosted,
        billing: deps.billing.enabled,
        // What the first account needs: the code from /allay init, or the one in the backend's log.
        setup: setup ? (admin.selfHosted ? "init" : "log") : null,
        me: session ? await adminNamed(admin, session.username) : null,
      });
    },
  },
  {
    method: "POST",
    path: "/setup",
    access: "public",
    async handle(ctx) {
      const { admin } = ctx;
      if (!(await needsSetup(admin))) return error(409, "ADMIN_EXISTS", "An admin exists already; sign in");
      const wait = admin.limiter.blocked(ctx.ip, "(setup)");
      if (wait) return error(429, "RATE_LIMITED", "Too many tries; wait a little", { retry_after: wait });
      const input = await parse(ctx, setupSchema);
      if (!input.ok) return input.response;
      if (!admin.setup.check(input.data.code)) {
        admin.limiter.fail(ctx.ip, "(setup)");
        return error(400, "BAD_CODE", admin.selfHosted ? "The code is wrong or expired; run /allay init again" : "The code is wrong; take it from the backend's log");
      }
      if (admin.envAdmin?.username === input.data.username) return error(409, "NAME_TAKEN", "That name belongs to the environment's admin");
      const created = await admin.accounts.create({
        username: input.data.username,
        password_hash: await hashPassword(input.data.password),
        role: "owner",
        created_at: admin.now(),
        last_login_at: admin.now(),
      });
      if (!created) return error(409, "ADMIN_EXISTS", "An admin exists already; sign in");
      admin.setup.spend();
      logger.info(`Admin ${input.data.username} created through setup`);
      await record(admin, { actor: input.data.username, action: "setup", target: input.data.username, ip: ctx.ip });
      return signIn(ctx, input.data.username, 201);
    },
  },
  {
    method: "POST",
    path: "/recover",
    access: "public",
    async handle(ctx) {
      const { admin } = ctx;
      if (!admin.selfHosted) return error(404, "NOT_SELFHOSTED", "This backend has no recovery from the game; ask another owner to reset your password");
      const wait = admin.limiter.blocked(ctx.ip, "(recover)");
      if (wait) return error(429, "RATE_LIMITED", "Too many tries; wait a little", { retry_after: wait });
      const input = await parse(ctx, recoverSchema);
      if (!input.ok) return input.response;
      if (!admin.recovery.check(input.data.code)) {
        admin.limiter.fail(ctx.ip, "(recover)");
        return error(400, "BAD_CODE", "The code is wrong or expired; run /allay init again");
      }
      const name = input.data.username;
      // The code stays alive for these two, so whoever holds it can fix the name and try again.
      if (admin.envAdmin?.username === name) return error(409, "ENV_ADMIN", "This account is defined by the environment; change ADMIN_PASSWORD or ADMIN_PASSWORD_HASH there");
      if (!(await admin.accounts.get(name))) return error(404, "NO_ACCOUNT", "No account has that name");
      await admin.accounts.update(name, { password_hash: await hashPassword(input.data.password), last_login_at: admin.now() });
      admin.recovery.spend();
      await admin.sessions.removeAll(name);
      admin.limiter.succeed(name);
      logger.info(`Admin ${name} set a new password through recovery`);
      await record(admin, { actor: name, action: "recover", target: name, ip: ctx.ip });
      return signIn(ctx, name);
    },
  },
  {
    method: "POST",
    path: "/login",
    access: "public",
    async handle(ctx) {
      const { admin } = ctx;
      const input = await parse(ctx, loginSchema);
      if (!input.ok) return input.response;
      const name = input.data.username;
      const wait = admin.limiter.blocked(ctx.ip, name);
      if (wait) return error(429, "RATE_LIMITED", "Too many failed sign-ins; wait a little", { retry_after: wait });
      const me = await authenticate(admin, name, input.data.password);
      if (!me) {
        admin.limiter.fail(ctx.ip, name);
        return error(401, "BAD_CREDENTIALS", "Wrong name or password");
      }
      admin.limiter.succeed(name);
      if (!me.env) await admin.accounts.update(name, { last_login_at: admin.now() });
      await record(admin, { actor: name, action: "sign_in", ip: ctx.ip });
      return signIn(ctx, name);
    },
  },
  {
    method: "POST",
    path: "/logout",
    access: "signed",
    async handle(ctx) {
      if (ctx.sessionId) await ctx.admin.sessions.remove(ctx.sessionId);
      return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(ctx.req, "", 0) } });
    },
  },
  {
    method: "GET",
    path: "/me",
    access: "signed",
    async handle({ me }) {
      return Response.json({ me });
    },
  },
  {
    method: "POST",
    path: "/me/password",
    access: "signed",
    async handle(ctx) {
      const { admin, me } = ctx;
      if (me!.env) return error(409, "ENV_ADMIN", "This account is defined by the environment; change ADMIN_PASSWORD there");
      const input = await parse(ctx, z.object({ current: z.string().min(1).max(MAX_PASSWORD), password }));
      if (!input.ok) return input.response;
      if (!(await authenticate(admin, me!.username, input.data.current))) return error(401, "BAD_CREDENTIALS", "The current password is wrong");
      await admin.accounts.update(me!.username, { password_hash: await hashPassword(input.data.password) });
      await admin.sessions.removeAll(me!.username);
      await record(admin, { actor: me!.username, action: "password", target: me!.username, ip: ctx.ip });
      return signIn(ctx, me!.username);
    },
  },
];

const accountView = (a: { username: string; role: string; created_at?: Date; created_by?: string; last_login_at?: Date }, env = false) => ({
  username: a.username,
  role: a.role,
  env,
  created_at: a.created_at?.toISOString() ?? null,
  created_by: a.created_by ?? null,
  last_login_at: a.last_login_at?.toISOString() ?? null,
});

export const accountRoutes: Route[] = [
  {
    method: "GET",
    path: "/accounts",
    access: "owner",
    async handle({ admin }) {
      const accounts = (await admin.accounts.list()).map((a) => accountView(a));
      return Response.json({ accounts: admin.envAdmin ? [accountView({ username: admin.envAdmin.username, role: "owner" }, true), ...accounts] : accounts });
    },
  },
  {
    method: "POST",
    path: "/accounts",
    access: "owner",
    async handle(ctx) {
      const { admin, me } = ctx;
      const input = await parse(ctx, z.object({ username, password, role: z.enum(ROLES) }));
      if (!input.ok) return input.response;
      if (admin.envAdmin?.username === input.data.username) return error(409, "NAME_TAKEN", "That name belongs to the environment's admin");
      const created = await admin.accounts.create({
        username: input.data.username,
        password_hash: await hashPassword(input.data.password),
        role: input.data.role,
        created_at: admin.now(),
        created_by: me!.username,
      });
      if (!created) return error(409, "NAME_TAKEN", "That name is taken");
      await record(admin, { actor: me!.username, action: "account.create", target: input.data.username, changes: [{ field: "role", old: "", new: input.data.role }], ip: ctx.ip });
      return Response.json({ account: accountView((await admin.accounts.get(input.data.username))!) }, { status: 201 });
    },
  },
  {
    method: "PATCH",
    path: "/accounts/:username",
    access: "owner",
    async handle(ctx) {
      const { admin, me, params } = ctx;
      if (admin.envAdmin?.username === params.username) return error(409, "ENV_ADMIN", "This account is defined by the environment");
      const account = await admin.accounts.get(params.username);
      if (!account) return error(404, "NOT_FOUND", "No such account");
      const input = await parse(ctx, z.object({ role: z.enum(ROLES).optional(), password: password.optional() }));
      if (!input.ok) return input.response;
      const { role, password: fresh } = input.data;
      if (role && role !== "owner" && account.role === "owner" && (await otherOwners(admin, account.username)) === 0) {
        return error(409, "LAST_OWNER", "Someone must stay an owner");
      }
      const changes: Array<{ field: string; old: string; new: string }> = [];
      if (role && role !== account.role) changes.push({ field: "role", old: account.role, new: role });
      if (fresh) changes.push({ field: "password", old: "…", new: "reset" });
      if (!changes.length) return Response.json({ account: accountView(account) });
      await admin.accounts.update(account.username, { ...(role ? { role } : {}), ...(fresh ? { password_hash: await hashPassword(fresh) } : {}) });
      // A new password or a smaller role takes effect everywhere at once.
      if (fresh || role) await admin.sessions.removeAll(account.username);
      await record(admin, { actor: me!.username, action: "account.update", target: account.username, changes, ip: ctx.ip });
      return Response.json({ account: accountView((await admin.accounts.get(account.username))!) });
    },
  },
  {
    method: "DELETE",
    path: "/accounts/:username",
    access: "owner",
    async handle(ctx) {
      const { admin, me, params } = ctx;
      if (admin.envAdmin?.username === params.username) return error(409, "ENV_ADMIN", "This account is defined by the environment");
      const account = await admin.accounts.get(params.username);
      if (!account) return error(404, "NOT_FOUND", "No such account");
      if (account.role === "owner" && (await otherOwners(admin, account.username)) === 0) return error(409, "LAST_OWNER", "Someone must stay an owner");
      await admin.accounts.remove(account.username);
      await admin.sessions.removeAll(account.username);
      await record(admin, { actor: me!.username, action: "account.delete", target: account.username, ip: ctx.ip });
      return Response.json({ deleted: true });
    },
  },
];

/** What stays in the environment, shown read-only so an operator knows where each thing comes from. */
const environment = (admin: AdminDeps) => ({
  selfhosted: admin.selfHosted,
  port: Number(process.env.PORT) || 3000,
  mongodb_database: process.env.MONGODB_DATABASE ?? null,
  secrets_key: process.env.SECRETS_KEY ? "env" : "file",
  env_admin: !!admin.envAdmin,
  version: VERSION,
});

const testValue = (ctx: Context, values: Record<string, unknown>, key: Parameters<AdminDeps["settings"]["get"]>[0]) => {
  const given = values[key];
  // A blank secret field means “the one already set”.
  return typeof given === "string" && given.trim() ? given.trim() : ctx.admin.settings.get(key);
};

export const settingsRoutes: Route[] = [
  {
    method: "GET",
    path: "/settings",
    access: "viewer",
    async handle({ admin }) {
      const view = admin.settings.view();
      const hidden = admin.selfHosted ? HOSTED_GROUPS : [];
      return Response.json({ ...view, fields: view.fields.filter((f) => !hidden.includes(f.group)), environment: environment(admin) });
    },
  },
  {
    method: "PUT",
    path: "/settings",
    access: "admin",
    async handle(ctx) {
      const { admin, me, deps } = ctx;
      const input = await parse(ctx, z.object({ version: z.number().int().min(0), values: z.record(z.string(), z.unknown()) }));
      if (!input.ok) return input.response;
      const { values, version } = input.data;
      const model = values.OPENROUTER_API_MODEL;
      if (typeof model === "string" && model.trim()) {
        const base = typeof values.OPENROUTER_API_URL === "string" && values.OPENROUTER_API_URL.trim() ? values.OPENROUTER_API_URL : admin.settings.get("OPENROUTER_API_URL");
        if (isOpenRouter(base)) {
          const known = await catalogCheck(base, model.trim(), deps.billing.net);
          if (known === "missing") return error(400, "INVALID", "Some settings aren't valid", { fields: { OPENROUTER_API_MODEL: "OpenRouter doesn't know this model" } });
          if (known === "no_tools") return error(400, "INVALID", "Some settings aren't valid", { fields: { OPENROUTER_API_MODEL: "This model can't call tools, and Allay needs them" } });
        }
      }
      const result = await admin.settings.update(values, version, me!.username);
      if (!result.ok) {
        const status = result.code === "CONFLICT" ? 409 : result.code === "VAULT" ? 500 : 400;
        return error(status, result.code, result.message, result.errors ? { fields: result.errors } : {});
      }
      if (result.changes.length) {
        logger.info(`${me!.username} changed settings: ${result.changes.map((c) => c.key).join(", ")}`);
        await record(admin, { actor: me!.username, action: "settings.update", changes: result.changes.map((c) => ({ field: c.key, old: c.old, new: c.new })), ip: ctx.ip });
      }
      return Response.json({ version: result.version, changed: result.changes.map((c) => c.key) });
    },
  },
  {
    method: "POST",
    path: "/settings/import",
    access: "admin",
    async handle(ctx) {
      const { admin, me } = ctx;
      const result = await admin.settings.importEnv(me!.username);
      if (!result.ok) return error(result.code === "VAULT" ? 500 : 409, result.code, result.message);
      if (result.changes.length) {
        await record(admin, { actor: me!.username, action: "settings.import", changes: result.changes.map((c) => ({ field: c.key, old: c.old, new: c.new })), ip: ctx.ip });
      }
      return Response.json({ version: result.version, imported: result.changes.map((c) => c.key) });
    },
  },
  {
    method: "POST",
    path: "/settings/test/:kind",
    access: "admin",
    async handle(ctx) {
      const values = ((await body(ctx.req)) as { values?: Record<string, unknown> } | null)?.values ?? {};
      switch (ctx.params.kind) {
        case "model":
          return Response.json(
            await checkModel(
              {
                apiKey: testValue(ctx, values, "OPENROUTER_API_KEY") as string | undefined,
                baseURL: String(testValue(ctx, values, "OPENROUTER_API_URL")),
                model: String(testValue(ctx, values, "OPENROUTER_API_MODEL")),
              },
              ctx.deps.billing.net,
            ),
          );
        case "perplexity":
          return Response.json(await checkPerplexity(testValue(ctx, values, "PERPLEXITY_API_KEY") as string | undefined));
        case "bot": {
          const test = values.TELEGRAM_TEST_ENV;
          return Response.json(
            await checkBot({
              token: testValue(ctx, values, "TELEGRAM_BOT_TOKEN") as string | undefined,
              base: String(testValue(ctx, values, "TELEGRAM_API_URL")),
              test: typeof test === "boolean" ? test : ctx.admin.settings.get("TELEGRAM_TEST_ENV"),
            }),
          );
        }
        default:
          return error(404, "NOT_FOUND", "No such check");
      }
    },
  },
];

export const auditRoutes: Route[] = [
  {
    method: "GET",
    path: "/audit",
    access: "admin",
    async handle({ admin, url }) {
      const before = url.searchParams.get("before");
      const entries = await admin.audit.list({ limit: 100, before: before ? new Date(before) : undefined });
      return Response.json({ entries: entries.map((e) => ({ ...e, at: e.at.toISOString() })) });
    },
  },
];
