import type { AllayDeps } from "../../agent/allay";

/** Callers that aren't a player: the server's console, and v1 requests that name nobody. */
const NOBODY = new Set(["console", "anonymous"]);

/**
 * Whether the backend may take this player's data. On a hosted backend (billing on) a player needs an agreement in
 * force: the backend refuses rather than trust a plugin whose notice was switched off or is too old to ask (GDPR art.
 * 7(1), COPPA). A self-hosted backend leaves it to its operator, as the plugin's `privacy.consent` does.
 */
export const mayKeep = async (deps: Pick<AllayDeps, "billing" | "consents">, tenant: string, userId: string): Promise<boolean> => {
  if (!deps.billing.enabled || NOBODY.has(userId)) return true;
  return (await deps.consents.get({ tenant, userId })) !== null;
};
