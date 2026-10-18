import type { Server } from "bun";
import type { AllayDeps } from "../../agent/allay";
import { isPrivateAddress } from "../billing/byok";
import { logger } from "../../shared/logging/logger";
import type { Role } from "../../infrastructure/admin/accounts";
import { type Admin, type AdminDeps, COOKIE, SESSION_TTL, adminNamed, allows } from "./admin";

/** The path prefix a proxy put in front of the backend, like /allay on Moonlands; nginx sends it as X-Forwarded-Prefix. */
export const prefixOf = (req: Request) => {
  const prefix = req.headers.get("X-Forwarded-Prefix")?.trim().replace(/\/+$/, "") ?? "";
  return /^(\/[A-Za-z0-9._~-]+)*$/.test(prefix) ? prefix : "";
};

/** The browser's address: behind a proxy on a private address, the one it forwards; otherwise the peer's. */
export const clientAddress = (req: Request, server?: Server) => {
  const peer = server?.requestIP(req)?.address ?? "unknown";
  if (peer !== "unknown" && !isPrivateAddress(peer)) return peer;
  const forwarded = req.headers.get("X-Real-IP") ?? req.headers.get("X-Forwarded-For")?.split(",")[0];
  return forwarded?.trim() || peer;
};

const hostOf = (req: Request) => req.headers.get("X-Forwarded-Host") ?? req.headers.get("Host") ?? new URL(req.url).host;

const httpsOf = (req: Request) => (req.headers.get("X-Forwarded-Proto") ?? new URL(req.url).protocol.replace(":", "")) === "https";

/** Browsers keep Secure cookies over https and on localhost; plain http elsewhere would never sign in. */
const secureOf = (req: Request) => httpsOf(req) || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(hostOf(req));

export const sessionCookie = (req: Request, value: string, maxAge = SESSION_TTL) =>
  [`${COOKIE}=${value}`, `Path=${prefixOf(req) || "/"}`, "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`, ...(secureOf(req) ? ["Secure"] : [])].join("; ");

export const cookieOf = (req: Request): string | undefined =>
  req.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === COOKIE)?.[1];

/**
 * A state-changing request must come from the panel's own page: its Origin is the address the browser used,
 * or PUBLIC_URL. SameSite=Strict already keeps the cookie off other sites; this closes what it doesn't.
 */
export const sameOrigin = (req: Request, publicUrl: string) => {
  const origin = req.headers.get("Origin");
  if (!origin) return false;
  try {
    const given = new URL(origin);
    if (given.host === hostOf(req)) return true;
    return given.origin === new URL(publicUrl).origin;
  } catch {
    return false;
  }
};

export const error = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  Response.json({ error: { code, message }, ...extra }, { status });

export const notFound = () => error(404, "NOT_FOUND", "No such page");

/** Everything a panel endpoint gets. */
export interface Context {
  req: Request;
  url: URL;
  params: Record<string, string>;
  deps: AllayDeps;
  admin: AdminDeps;
  ip: string;
  /** Who is signed in, for routes that need it. */
  me?: Admin;
  sessionId?: string;
}

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** public: anyone; signed: any role; or the least role it needs. */
  access: "public" | "signed" | Role;
  handle: (ctx: Context) => Promise<Response>;
}

interface Compiled extends Route {
  pattern: RegExp;
  names: string[];
}

const compile = (route: Route): Compiled => {
  const names: string[] = [];
  const pattern = new RegExp(
    `^${route.path.replace(/:([a-zA-Z]+)/g, (_, name) => {
      names.push(name);
      return "([^/]+)";
    })}$`,
  );
  return { ...route, pattern, names };
};

/** Reads a JSON body; null when it isn't one. */
export const body = async (req: Request): Promise<unknown> => req.json().catch(() => null);

/** Serves /api/admin/* from a table of routes: finds the route, checks the origin and the role, then hands over. */
export const adminRouter = (routes: Route[]) => {
  const table = routes.map(compile);
  return (deps: AllayDeps) =>
    async (req: Request, server?: Server): Promise<Response> => {
      const admin = deps.admin;
      if (!admin) return notFound();
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/api\/admin/, "") || "/";
      let allowed = false;
      for (const route of table) {
        const match = route.pattern.exec(path);
        if (!match) continue;
        allowed = true;
        if (route.method !== req.method) continue;
        if (req.method !== "GET" && !sameOrigin(req, admin.settings.get("PUBLIC_URL"))) {
          return error(403, "BAD_ORIGIN", "This request didn't come from the panel");
        }
        const ctx: Context = {
          req,
          url,
          params: Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])])),
          deps,
          admin,
          ip: clientAddress(req, server),
        };
        if (route.access !== "public") {
          const id = cookieOf(req);
          const session = id ? await admin.sessions.touch(id, SESSION_TTL) : null;
          const me = session ? await adminNamed(admin, session.username) : null;
          if (!me) return error(401, "SIGNED_OUT", "Sign in first");
          if (route.access !== "signed" && !allows(me.role, route.access)) return error(403, "FORBIDDEN", "Your role can't do this");
          ctx.me = me;
          ctx.sessionId = id;
        }
        try {
          const response = await route.handle(ctx);
          response.headers.set("Cache-Control", "no-store");
          return response;
        } catch (failure) {
          logger.error(`Admin ${req.method} ${path} failed: ${failure instanceof Error ? failure.message : String(failure)}`);
          return error(500, "ADMIN_ERROR", "Something went wrong on the backend; its log says what");
        }
      }
      return allowed ? error(405, "METHOD_NOT_SUPPORTED", "Method not supported") : notFound();
    };
};
