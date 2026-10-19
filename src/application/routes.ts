import type { Server } from "bun";
import type { AllayDeps } from "../agent/allay";
import type { handleAdmin } from "../features/admin/admin.controller";
import type { handleAdminInit } from "../features/admin/init.controller";
import type { handleAsk } from "../features/ask/ask.controller";
import type { handleAskX } from "../features/askx/askx.controller";
import type { handleChat, handleToolResult } from "../features/chat/chat.controller";
import type { handleLicense } from "../features/billing/license.controller";
import type { handleHealth } from "../features/health/health.controller";
import type { handleTelegram } from "../features/telegram/telegram.controller";
import type { handleMemories, handleMemory, handleSession } from "../features/users/users.controller";

interface Handlers {
  handleAsk: typeof handleAsk;
  handleAskX: typeof handleAskX;
  handleChat: typeof handleChat;
  handleToolResult: typeof handleToolResult;
  handleHealth: typeof handleHealth;
  handleSession: typeof handleSession;
  handleMemories: typeof handleMemories;
  handleMemory: typeof handleMemory;
  handleLicense: typeof handleLicense;
  handleTelegram: typeof handleTelegram;
  handleAdminInit?: typeof handleAdminInit;
  handleAdmin?: typeof handleAdmin;
  /** The panel's built pages, served at /admin. */
  adminPages?: (req: Request) => Promise<Response>;
}

type Route = (req: Request, server: Server<undefined>) => Promise<Response>;

/** The HTTP routes, built from injected services so tests can serve them with fakes. */
export const routes = (deps: AllayDeps, h: Handlers): Record<string, Route> => ({
  "/api/health": h.handleHealth(deps),
  "/api/ask": h.handleAsk(deps),
  "/api/askx": h.handleAskX(deps),
  "/api/v2/chat": h.handleChat(deps),
  "/api/v2/chat/:runId/tools/:callId": h.handleToolResult(deps),
  "/api/v2/users/:userId/session": h.handleSession(deps),
  "/api/v2/users/:userId/memories": h.handleMemories(deps),
  "/api/v2/users/:userId/memories/:memoryId": h.handleMemory(deps),
  "/api/v2/license": h.handleLicense(deps),
  "/api/telegram/webhook": h.handleTelegram(deps),
  ...(h.handleAdminInit ? { "/api/v2/admin/init": h.handleAdminInit(deps) } : {}),
  ...(h.handleAdmin ? { "/api/admin/*": h.handleAdmin(deps) } : {}),
  ...(h.adminPages ? { "/admin": h.adminPages, "/admin/*": h.adminPages } : {}),
});
