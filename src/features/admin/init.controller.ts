import type { AllayDeps } from "../../agent/allay";
import { jsonError } from "../../shared/lib/http";
import { ApiFailure } from "../../shared/types/errors";
import { identify } from "../auth/caller";
import { needsSetup } from "./admin";
import { error } from "./admin.http";

/** Where the panel lives for people: PUBLIC_URL with /admin. */
export const panelUrl = (publicUrl: string) => `${publicUrl.replace(/\/+$/, "")}/admin`;

/**
 * POST /api/v2/admin/init: `/allay init` in the game, self-hosted backends only. Without an admin it hands out
 * a one-time setup link; once an account exists, a one-time recovery link that sets a new password for one.
 * Both last 30 minutes, a new call replaces the pending code of its kind, and neither code is ever logged.
 * With only the environment's admin there's nothing to recover: its password lives in the environment.
 * A recovery code resets any account's password, so only a plugin with the backend's PLUGIN_TOKEN gets one.
 */
export const handleAdminInit = (deps: AllayDeps) => async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return error(405, "METHOD_NOT_SUPPORTED", "Method not supported");
  const caller = await identify(deps.billing, req);
  if (caller instanceof ApiFailure) return jsonError(caller.toApiError());
  const admin = deps.admin;
  if (!admin || !admin.selfHosted) return error(404, "NOT_SELFHOSTED", "Only a self-hosted backend sets up its panel from the game");
  const url = panelUrl(admin.settings.get("PUBLIC_URL"));
  if (await needsSetup(admin)) {
    const { code, expires } = admin.setup.issue();
    return Response.json({ url: `${url}/setup?code=${encodeURIComponent(code)}`, expires_at: expires!.toISOString(), mode: "setup" });
  }
  if ((await admin.accounts.count()) === 0) return error(409, "ADMIN_EXISTS", "The panel's only admin is defined by the environment", { url });
  const { code, expires } = admin.recovery.issue();
  return Response.json({ url: `${url}/recover?code=${encodeURIComponent(code)}`, expires_at: expires!.toISOString(), mode: "recover" });
};
