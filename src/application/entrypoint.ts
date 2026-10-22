import { serve } from "bun";
import { needsSetup } from "../features/admin/admin";
import { handleAdmin } from "../features/admin/admin.controller";
import { adminPages } from "../features/admin/admin.pages";
import { handleAdminInit, panelUrl } from "../features/admin/init.controller";
import { handleServer } from "../features/servers/server.controller";
import { handleAsk } from "../features/ask/ask.controller";
import { handleAskX } from "../features/askx/askx.controller";
import { handleChat, handleToolResult } from "../features/chat/chat.controller";
import { handleLicense } from "../features/billing/license.controller";
import { handleHealth } from "../features/health/health.controller";
import { handleTelegram, startTelegram, watchTelegram } from "../features/telegram/telegram.controller";
import {
  handleConsent, handleDeaths, handleExport, handleExportDownload, handleMemories, handleMemory, handlePrivacy, handleSession, handleState, handleUser,
} from "../features/users/users.controller";
import { logger } from "../shared/logging/logger";
import { connect as mongoConnect, disconnect as mongoDisconnect } from "../infrastructure/database/mongodb.client";
import { settings } from "../features/settings/settings";
import { productionVault } from "../infrastructure/settings/secrets";
import { DATA_KEY_LABEL, useDataKey } from "../infrastructure/crypto/data";
import { mongoSettings } from "../infrastructure/settings/store";
import { migrate } from "../infrastructure/database/migrations";
import { PSEUDONYM_LABEL, pseudonymsWith } from "../infrastructure/privacy/pseudonyms";
import { mongoRuns } from "../infrastructure/runs/runs";
import { selfHosted } from "../features/billing/billing";
import { productionDeps } from "./deps";
import { routes } from "./routes";

logger.info("Allay Server is starting...");

await mongoConnect();
const vault = productionVault();
await settings.attach(mongoSettings, vault);
const pseudonyms = pseudonymsWith(await vault.derive(PSEUDONYM_LABEL));
// Players' memories, sessions, deaths, state, and traces are sealed with a key of their own, derived from the vault's.
useDataKey(await vault.derive(DATA_KEY_LABEL));
await migrate({ selfHosted: selfHosted(), pseudonyms, now: new Date() });
const deps = productionDeps(pseudonyms);

// Days past RUN_DAYS keep how many played, not who; once at start and then daily.
const prune = () => mongoRuns.prune(new Date()).catch((error) => logger.warn(`Couldn't prune old statistics: ${String(error)}`));
void prune();
setInterval(prune, 86_400_000).unref();

if (selfHosted() && (settings.get("PLUGIN_TOKEN")?.trim().length ?? 0) < 24) {
  logger.warn("PLUGIN_TOKEN is not set (or shorter than 24 characters): this self-hosted backend answers no plugin until it is");
}

const server = serve({
  port: Number(process.env.PORT) || 3000,
  // In a container the port must listen on every interface; compose publishes it on 127.0.0.1 only.
  hostname: process.env.HOST || "0.0.0.0",
  // Questions are 2000 characters, tool results a few dozen kilobytes; nothing needs Bun's 128 MB default.
  maxRequestBodySize: 2 * 1024 * 1024,
  routes: routes(deps, {
    handleAsk, handleAskX, handleChat, handleToolResult, handleHealth, handleUser, handleSession, handleConsent, handleMemories, handleMemory, handlePrivacy, handleServer,
    handleDeaths, handleState, handleExport, handleExportDownload,
    handleLicense, handleTelegram, handleAdminInit, handleAdmin, adminPages: adminPages(),
  }),
  error: (error: Error) => {
    logger.error("Server error:", error);
    return Response.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, { status: 500 });
  },
});

logger.info(deps.billing.enabled ? "Billing is on: servers pay with a subscription or bring their own key" : "Billing is off (SELFHOSTED): everyone runs on this backend's key");
await startTelegram(deps.billing).catch((error) => logger.error(`The Telegram bot didn't start: ${String(error)}`));
watchTelegram(deps.billing);

// A hosted backend has no /allay init: its first admin comes from a code only the operator sees, in this log.
if (deps.admin && !deps.admin.selfHosted && (await needsSetup(deps.admin))) {
  const { code } = deps.admin.setup.issue(null);
  logger.info(`No admin yet: open ${panelUrl(settings.get("PUBLIC_URL"))}/setup and enter the setup code ${code}`);
}

const shutdown = (signal: string) => async () => {
  logger.info(`Graceful shutdown: received ${signal}, closing connections...`);
  server.stop();
  await mongoDisconnect();
  logger.info("All connections closed");
  process.exitCode = 0;
};

process.on("SIGINT", shutdown("SIGINT"));
process.on("SIGTERM", shutdown("SIGTERM"));
