import type { AllayDeps } from "../../agent/allay";
import { jsonError } from "../../shared/lib/http";
import { API_ERRORS, apierror } from "../../shared/types/errors";
import { POLICY_REVISION } from "../../shared/policy";

// The image gets its version at build time: the release tag, dev-<sha> on master, dev locally.
const VERSION = process.env.APP_VERSION || "dev";

/**
 * Open to anyone: says the backend is up, its version, and whether billing is on, so a plugin knows if it needs a
 * license or a token, and since 6.9 the privacy policy's revision. Nothing about the process or the machine.
 */
export const handleHealth = (deps: AllayDeps) => async (req: Request) =>
  req.method === "GET" || req.method === "HEAD"
    ? Response.json({ name: "Allay", status: "ok", version: VERSION, billing: deps.billing.enabled, policy_revision: POLICY_REVISION })
    : jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));