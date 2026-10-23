import type { Pseudonyms } from "../../infrastructure/privacy/pseudonyms";
import { logger } from "../../shared/logging/logger";
import { API_ERRORS, ApiFailure, apierror } from "../../shared/types/errors";
import type { Caller } from "../auth/caller";
import type { Billing } from "./billing";
import { kindOf } from "./plans";

/**
 * A Solo license serves one player: the first who asks takes it, and anyone else gets `SOLO_PLAYER_TAKEN` before
 * anything runs or costs. The license keeps that player by pseudonym only. The payer hands it to another player in
 * the bot, an admin in the panel. A server's license and a self-hosted backend pass through.
 */
export const soloRefusal = async (billing: Billing, pseudonyms: Pseudonyms, caller: Caller, userId: string): Promise<ApiFailure | undefined> => {
  const license = caller.license;
  if (!billing.enabled || !license || kindOf(license) !== "solo") return undefined;
  const player = pseudonyms.of(caller.tenant, userId);
  if (license.player === player) return undefined;
  if (license.player || !(await billing.licenses.bind(license.id, player, billing.now()))) return new ApiFailure(apierror(API_ERRORS.SOLO_PLAYER_TAKEN));
  logger.info(`Solo license ${license.id} now belongs to its first player`);
  return undefined;
};
