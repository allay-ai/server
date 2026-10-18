import { lookup } from "node:dns/promises";
import type { AllayDeps } from "../agent/allay";
import { newLimits, selfHosted } from "../features/billing/billing";
import { bridge } from "../features/chat/chat.bridge";
import { mongoLicenses } from "../infrastructure/billing/licenses";
import { redisHistory } from "../infrastructure/history/history";
import { mongoMemories } from "../infrastructure/memory/memory";
import { openrouterModels } from "../infrastructure/providers/openrouter/openrouter.client";

const admins = (process.env.TELEGRAM_ADMIN_IDS || "")
  .split(",")
  .map((id) => Number(id.trim()))
  .filter((id) => Number.isInteger(id) && id > 0);

/** The real services; tests build their own with a mock model, in-memory stores, and a fake network. */
export const productionDeps: AllayDeps = {
  models: openrouterModels,
  history: redisHistory,
  memories: mongoMemories,
  bridge,
  perplexity: process.env.PERPLEXITY_API_KEY ? { apiKey: process.env.PERPLEXITY_API_KEY } : undefined,
  billing: {
    enabled: !selfHosted(),
    licenses: mongoLicenses,
    net: {
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }),
      resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
    },
    bot: { admins },
    limits: newLimits(),
    now: () => new Date(),
  },
};
