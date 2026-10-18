import type { AllayDeps } from "../../agent/allay";
import { needsSetup } from "./admin";
import { error } from "./admin.http";

/** Where the panel lives for people: PUBLIC_URL with /admin. */
export const panelUrl = (publicUrl: string) => `${publicUrl.replace(/\/+$/, "")}/admin`;

/**
 * POST /api/v2/admin/init: `/allay init` in the game. On a self-hosted backend without an admin it hands out
 * a one-time setup link for 30 minutes; a new call replaces the pending code. The code is never logged.
 */
export const handleAdminInit = (deps: AllayDeps) => async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return error(405, "METHOD_NOT_SUPPORTED", "Method not supported");
  const admin = deps.admin;
  if (!admin || !admin.selfHosted) return error(404, "NOT_SELFHOSTED", "Only a self-hosted backend sets up its panel from the game");
  const url = panelUrl(admin.settings.get("PUBLIC_URL"));
  if (!(await needsSetup(admin))) return error(409, "ADMIN_EXISTS", "The panel has an admin already", { url });
  const { code, expires } = admin.setup.issue();
  return Response.json({ url: `${url}/setup?code=${encodeURIComponent(code)}`, expires_at: expires!.toISOString() });
};
