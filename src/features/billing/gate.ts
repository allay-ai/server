import { type ByokProvider, OPENROUTER_URL, openrouterToken } from "../../infrastructure/providers/openrouter/openrouter.client";
import { API_ERRORS, ApiFailure, apierror } from "../../shared/types/errors";
import type { RunPayer } from "../../agent/allay";
import { type Billing, charge, quotaFor, refusal, verifyLicense } from "./billing";
import { checkUrl, preflight } from "./byok";
import type { Take } from "./limits";

/** The provider block of a v2 request; the key itself comes in a header. */
export interface ProviderBlock {
  base_url?: string;
  model?: string;
  search_model?: string;
}

/** Who pays for a run that may start: its provider (none means the backend's), where its costs go, and its slot to give back. */
export interface Admission {
  provider?: ByokProvider;
  /** The plugin's model on the backend's own key: honored only with billing off. */
  model?: string;
  spend?: (usd: number) => void;
  release: () => void;
  /** Who pays, as the statistics name it. */
  payer: RunPayer;
}

const nothing = () => {};

/** Names a server's own key in the statistics without keeping the key: a digest of where it goes and the key. */
const fingerprint = (provider: ByokProvider) => new Bun.CryptoHasher("sha256").update(`${provider.baseURL}\n${provider.apiKey}`).digest("hex").slice(0, 12);

const limited = (take: Take): ApiFailure | undefined =>
  take.ok ? undefined : new ApiFailure({ ...apierror(API_ERRORS.RATE_LIMITED), retry_after: take.retryAfter });

/** The server's own key, from X-Provider-Key with the body's block, or the v1 X-OpenRouter-Token. */
const byokOf = (headers: Headers, block?: ProviderBlock): ByokProvider | undefined => {
  const key = headers.get("X-Provider-Key")?.trim();
  if (key) {
    return {
      baseURL: block?.base_url?.trim() || OPENROUTER_URL,
      apiKey: key,
      model: block?.model?.trim() || undefined,
      searchModel: block?.search_model?.trim() || undefined,
    };
  }
  const token = headers.get("X-OpenRouter-Token")?.trim();
  return token ? openrouterToken(token) : undefined;
};

/**
 * Decides who pays before a run starts. A server's own key wins; without one, a backend with billing on
 * wants a license with money left, and a self-hosted one runs everyone on its own key, as before 5.0.
 * `serverKey` names the server for limits: its `server.id`, or the client address.
 */
export const admit = async (
  billing: Billing,
  headers: Headers,
  block: ProviderBlock | undefined,
  serverKey: string,
): Promise<{ ok: true; admission: Admission } | { ok: false; error: ApiFailure }> => {
  const byok = byokOf(headers, block);
  if (byok) {
    let release = nothing;
    if (billing.enabled) {
      const rejected = await checkUrl(byok.baseURL, billing.net);
      if (rejected) return { ok: false, error: rejected };
      // Before the check, which calls the provider: a server over its limit shouldn't make us call anyone.
      const take = billing.limits.byok.take(serverKey, billing.now().getTime());
      if (!take.ok) return { ok: false, error: limited(take)! };
      release = take.release;
    }
    const failure = await preflight(byok, billing.net);
    if (failure) {
      release();
      return { ok: false, error: failure };
    }
    return { ok: true, admission: { provider: byok, release, payer: { kind: "byok", id: fingerprint(byok) } } };
  }
  // A self-hosted backend serves its own servers, so their plugin may pick a model per player; a hosted one keeps its own.
  if (!billing.enabled) return { ok: true, admission: { release: nothing, payer: { kind: "self" }, ...(block?.model?.trim() ? { model: block.model.trim() } : {}) } };

  const license = await verifyLicense(billing, headers.get("Authorization"));
  if (license instanceof ApiFailure) return { ok: false, error: license };
  if (license.blocked_at) return { ok: false, error: new ApiFailure(apierror(API_ERRORS.SUBSCRIPTION_INACTIVE)) };
  const refused = refusal(await quotaFor(billing, license));
  if (refused) return { ok: false, error: refused };
  const take = billing.limits.hosted.take(license.id, billing.now().getTime());
  if (!take.ok) return { ok: false, error: limited(take)! };
  return {
    ok: true,
    admission: {
      release: take.release,
      payer: { kind: "license", id: license.id },
      spend: (usd) => {
        if (usd > 0) void charge(billing, license.id, usd);
      },
    },
  };
};

/** Logs who pays without the key or the license secret. */
export const payer = (admission: Admission) =>
  admission.provider
    ? `own key at ${new URL(admission.provider.baseURL).host}`
    : admission.spend
      ? "subscription"
      : `backend key${admission.model ? ` with ${admission.model}` : ""}`;
