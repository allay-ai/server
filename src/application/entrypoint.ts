import { redis, serve } from "bun";
import { handleAsk } from "../features/ask/ask.controller";
import { handleAskX } from "../features/askx/askx.controller";
import { handleChat, handleToolResult } from "../features/chat/chat.controller";
import { handleLicense } from "../features/billing/license.controller";
import { handleHealth } from "../features/health/health.controller";
import { handleTelegram, startTelegram, watchTelegram } from "../features/telegram/telegram.controller";
import { handleMemories, handleMemory, handleSession } from "../features/users/users.controller";
import { logger } from "../shared/logging/logger";
import { connect as mongoConnect, disconnect as mongoDisconnect } from "../infrastructure/database/mongodb.client";
import { settings } from "../features/settings/settings";
import { productionVault } from "../infrastructure/settings/secrets";
import { mongoSettings } from "../infrastructure/settings/store";
import { productionDeps } from "./deps";
import { routes } from "./routes";

logger.info("Allay Server is starting...");

await redis.ping();
await mongoConnect();
await settings.attach(mongoSettings, productionVault());
const deps = productionDeps();

const server = serve({
  port: Number(process.env.PORT) || 3000,
  hostname: "0.0.0.0",
  routes: routes(deps, {
    handleAsk, handleAskX, handleChat, handleToolResult, handleHealth, handleSession, handleMemories, handleMemory,
    handleLicense, handleTelegram,
  }),
  error: (error: Error) => {
    logger.error("Server error:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  },
});

logger.info(deps.billing.enabled ? "Billing is on: servers pay with a subscription or bring their own key" : "Billing is off (SELFHOSTED): everyone runs on this backend's key");
await startTelegram(deps.billing).catch((error) => logger.error(`The Telegram bot didn't start: ${String(error)}`));
watchTelegram(deps.billing);

const shutdown = (signal: string) => async () => {
  logger.info(`Graceful shutdown: received ${signal}, closing connections...`);
  server.stop();
  redis.close();
  await mongoDisconnect();
  logger.info("All connections closed");
  process.exitCode = 0;
};

process.on("SIGINT", shutdown("SIGINT"));
process.on("SIGTERM", shutdown("SIGTERM"));
