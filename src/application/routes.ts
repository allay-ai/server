import type { Server } from "bun";
import type { AllayDeps } from "../agent/allay";
import type { handleAdmin } from "../features/admin/admin.controller";
import type { handleAdminInit } from "../features/admin/init.controller";
import type { handleServer } from "../features/servers/server.controller";
import type { handleAsk } from "../features/ask/ask.controller";
import type { handleAskX } from "../features/askx/askx.controller";
import type { handleChat, handleToolResult } from "../features/chat/chat.controller";
import type { handleLicense } from "../features/billing/license.controller";
import type { handleHealth } from "../features/health/health.controller";
import type { handleTelegram } from "../features/telegram/telegram.controller";
import type { handleConsent, handleMemories, handleMemory, handlePrivacy, handleSession, handleUser } from "../features/users/users.controller";

interface Handlers {
  handleAsk: typeof handleAsk;
  handleAskX: typeof handleAskX;
  handleChat: typeof handleChat;
  handleToolResult: typeof handleToolResult;
  handleHealth: typeof handleHealth;
  handleUser: typeof handleUser;
  handleSession: typeof handleSession;
  handleConsent: typeof handleConsent;
  handleMemories: typeof handleMemories;
  handleMemory: typeof handleMemory;
  handleLicense: typeof handleLicense;
  handleTelegram: typeof handleTelegram;
  handleAdminInit?: typeof handleAdminInit;
  /** Since 6.5; tests that don't touch it leave it out. */
  handlePrivacy?: typeof handlePrivacy;
  /** Since 6.7. */
  handleServer?: typeof handleServer;
  handleAdmin?: typeof handleAdmin;
  /** The panel's built pages, served at /admin. */
  adminPages?: (req: Request) => Promise<Response>;
}

type Route = (req: Request, server: Server<undefined>) => Promise<Response>;

/** Headers every API answer carries: nothing sniffs its type, nothing frames it, and no page it's on learns where it came from. */
const API_HEADERS = { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" };

const secured =
  (route: Route): Route =>
  async (req, server) => {
    const response = await route(req, server);
    for (const [name, value] of Object.entries(API_HEADERS)) if (!response.headers.has(name)) response.headers.set(name, value);
    return response;
  };

/**
 * The HTTP routes, built from injected services so tests can serve them with fakes. Every route identifies its
 * caller (a plugin's license or token, or a panel session) except health, the Telegram webhook (its own secret),
 * license creation, and the panel's pages and sign-in; `test/access.test.ts` walks this table to keep it so.
 */
export const routes = (deps: AllayDeps, h: Handlers): Record<string, Route> => {
  const api: Record<string, Route> = {
    "/api/health": h.handleHealth(deps),
    "/api/ask": h.handleAsk(deps),
    "/api/askx": h.handleAskX(deps),
    "/api/v2/chat": h.handleChat(deps),
    "/api/v2/chat/:runId/tools/:callId": h.handleToolResult(deps),
    "/api/v2/users/:userId": h.handleUser(deps),
    "/api/v2/users/:userId/session": h.handleSession(deps),
    "/api/v2/users/:userId/consent": h.handleConsent(deps),
    ...(h.handleServer ? { "/api/v2/server": h.handleServer(deps) } : {}),
    ...(h.handlePrivacy ? { "/api/v2/users/:userId/privacy": h.handlePrivacy(deps) } : {}),
    "/api/v2/users/:userId/memories": h.handleMemories(deps),
    "/api/v2/users/:userId/memories/:memoryId": h.handleMemory(deps),
    "/api/v2/license": h.handleLicense(deps),
    "/api/telegram/webhook": h.handleTelegram(deps),
    ...(h.handleAdminInit ? { "/api/v2/admin/init": h.handleAdminInit(deps) } : {}),
    ...(h.handleAdmin ? { "/api/admin/*": h.handleAdmin(deps) } : {}),
  };
  return {
    ...Object.fromEntries(Object.entries(api).map(([path, route]) => [path, secured(route)])),
    ...(h.adminPages ? { "/admin": h.adminPages, "/admin/*": h.adminPages } : {}),
  };
};
