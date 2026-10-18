import { lookup } from "node:dns/promises";
import type { AllayDeps } from "../agent/allay";
import { newLimits, selfHosted } from "../features/billing/billing";
import { bridge } from "../features/chat/chat.bridge";
import { mongoLicenses } from "../infrastructure/billing/licenses";
import { MONGODB_DATABASE, MONGODB_URI } from "../infrastructure/database/mongodb.env";
import { redisHistory } from "../infrastructure/history/history";
import { tracing } from "../infrastructure/observability/tracing";
import { mongoMemories } from "../infrastructure/memory/memory";
import { openrouterModels } from "../infrastructure/providers/openrouter/openrouter.client";
import { settings } from "../features/settings/settings";
import { LoginLimiter, SetupCodes, envAdminOf } from "../features/admin/admin";
import { mongoAccounts } from "../infrastructure/admin/accounts";
import { mongoAudit } from "../infrastructure/admin/audit";
import { redisSessions } from "../infrastructure/admin/sessions";

const admins = () =>
  (settings.get("TELEGRAM_ADMIN_IDS") ?? "")
    .split(",")
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);

/**
 * The real services; tests build their own with a mock model, in-memory stores, and a fake network.
 * Built once the stored settings are loaded, since tracing reads them at start.
 */
export const productionDeps = (): AllayDeps => ({
  models: openrouterModels,
  history: redisHistory,
  memories: mongoMemories,
  bridge,
  get perplexity() {
    const apiKey = settings.get("PERPLEXITY_API_KEY");
    return apiKey ? { apiKey } : undefined;
  },
  mastra: tracing(MONGODB_URI, MONGODB_DATABASE),
  billing: {
    enabled: !selfHosted(),
    licenses: mongoLicenses,
    net: {
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }),
      resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
    },
    bot: {
      get admins() {
        return admins();
      },
    },
    limits: newLimits(),
    now: () => new Date(),
  },
  admin: {
    accounts: mongoAccounts,
    sessions: redisSessions,
    audit: mongoAudit,
    settings,
    setup: new SetupCodes(),
    envAdmin: envAdminOf(),
    selfHosted: selfHosted(),
    limiter: new LoginLimiter(),
    now: () => new Date(),
  },
});
