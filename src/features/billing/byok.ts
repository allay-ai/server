import { isIP } from "node:net";
import { type ByokProvider, isOpenRouter } from "../../infrastructure/providers/openrouter/openrouter.client";
import { redact } from "../../shared/lib/redact";
import { logger } from "../../shared/logging/logger";
import { API_ERRORS, ApiFailure, apierror } from "../../shared/types/errors";

/** What the checks need from the network; tests pass fakes. */
export interface Net {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Every address a host name resolves to. */
  resolve: (host: string) => Promise<string[]>;
}

const v4 = (ip: string) => ip.split(".").map(Number);

/** Loopback, private, link-local, carrier-grade NAT, multicast and reserved: nothing a public API lives on. */
export const isPrivateAddress = (ip: string): boolean => {
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (isIP(ip) === 4) {
    const [a, b] = v4(ip);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const low = ip.toLowerCase();
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address inside, which may well be a private one.
  return low === "::" || low === "::1" || /^f[cd]/.test(low) || /^fe[89ab]/.test(low) || low.startsWith("ff") || low.startsWith("64:ff9b:") || low.startsWith("2002:");
};

/**
 * On a backend with billing on, a server's base URL must be https and public: the backend calls it,
 * and it must not become a way into the backend's own network (Redis, MongoDB, the cloud's metadata).
 */
export const checkUrl = async (baseURL: string, net: Net): Promise<ApiFailure | undefined> => {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return new ApiFailure(apierror(API_ERRORS.PROVIDER_URL_REJECTED, "not a URL"));
  }
  if (url.protocol !== "https:") return new ApiFailure(apierror(API_ERRORS.PROVIDER_URL_REJECTED, "use https"));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await net.resolve(host);
  } catch {
    return new ApiFailure(apierror(API_ERRORS.PROVIDER_URL_REJECTED, `can't resolve ${host}`));
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    return new ApiFailure(apierror(API_ERRORS.PROVIDER_URL_REJECTED, `${host} isn't a public address`));
  }
  return undefined;
};

/**
 * The fetch a server's own provider gets on a backend with billing on: every request checks its host again, so a
 * name that resolved to a public address at admission can't point inside later, and redirects are refused, so a
 * public host can't bounce a request to a private one. The provider's TLS certificate guards the rest.
 */
export const guardedFetch = (net: Net): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const rejected = await checkUrl(url, net);
    if (rejected) throw rejected;
    return fetch(input, { ...init, redirect: "error" });
  }) as typeof fetch;

interface CatalogModel {
  id: string;
  supported_parameters?: string[];
}

const CATALOG_TTL = 3_600_000;
let catalog: { at: number; models: Map<string, CatalogModel> } | undefined;

/** OpenRouter's public model list, kept for an hour. */
const openrouterCatalog = async (baseURL: string, net: Net): Promise<Map<string, CatalogModel> | undefined> => {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL) return catalog.models;
  const response = await net.fetch(`${baseURL.replace(/\/$/, "")}/models`);
  if (!response.ok) return undefined;
  const body = (await response.json()) as { data?: CatalogModel[] };
  catalog = { at: Date.now(), models: new Map((body.data ?? []).map((m) => [m.id, m])) };
  return catalog.models;
};

/** What OpenRouter's catalog says of a model; unknown when the catalog can't be read. */
export const catalogCheck = async (baseURL: string, model: string, net: Net): Promise<"ok" | "missing" | "no_tools" | "unknown"> => {
  // A ~ alias, like ~openai/gpt-luna-latest, follows the newest model of a line and isn't in the catalog itself.
  if (model.startsWith("~")) return "unknown";
  try {
    const models = await openrouterCatalog(baseURL.replace(/\/$/, ""), net);
    if (!models) return "unknown";
    const found = models.get(model);
    if (!found) return "missing";
    return found.supported_parameters && !found.supported_parameters.includes("tools") ? "no_tools" : "ok";
  } catch {
    return "unknown";
  }
};

const auth = (provider: ByokProvider) => ({ headers: { Authorization: `Bearer ${provider.apiKey}` } });

const refused = (status: number) => status === 401 || status === 403;

/** OpenRouter: the key through /key, the models and their tool support through the public catalog. */
const checkOpenRouter = async (provider: ByokProvider, net: Net): Promise<ApiFailure | undefined> => {
  const base = provider.baseURL.replace(/\/$/, "");
  const key = await net.fetch(`${base}/key`, auth(provider));
  if (refused(key.status)) return new ApiFailure(apierror(API_ERRORS.PROVIDER_AUTH_FAILED));
  const models = await openrouterCatalog(base, net);
  if (!models) return undefined;
  for (const id of [provider.model, provider.searchModel].filter((m): m is string => !!m)) {
    if (!models.has(id)) return new ApiFailure(apierror(API_ERRORS.MODEL_NOT_FOUND, id));
  }
  const main = provider.model ? models.get(provider.model) : undefined;
  if (main?.supported_parameters && !main.supported_parameters.includes("tools")) {
    return new ApiFailure(apierror(API_ERRORS.MODEL_NO_TOOLS, main.id));
  }
  return undefined;
};

/** Any other OpenAI-compatible API: the key and the model through /models when it has one. Tool support shows in the run. */
const checkCompatible = async (provider: ByokProvider, net: Net): Promise<ApiFailure | undefined> => {
  if (!provider.model) return new ApiFailure(apierror(API_ERRORS.MODEL_NOT_FOUND, "name a model for this API"));
  const response = await net.fetch(`${provider.baseURL.replace(/\/$/, "")}/models`, auth(provider));
  if (refused(response.status)) return new ApiFailure(apierror(API_ERRORS.PROVIDER_AUTH_FAILED));
  if (!response.ok) return undefined;
  const body = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
  const ids = (body.data ?? []).map((m) => m.id).filter(Boolean);
  if (ids.length && !ids.includes(provider.model)) return new ApiFailure(apierror(API_ERRORS.MODEL_NOT_FOUND, provider.model));
  return undefined;
};

const PASSED_TTL = 10 * 60_000;
const FAILED_TTL = 60_000;
const checked = new Map<string, { until: number; failure?: ApiFailure }>();

const keyOf = async (provider: ByokProvider) => {
  const raw = [provider.baseURL, provider.apiKey, provider.model ?? "", provider.searchModel ?? ""].join("\n");
  return new Bun.CryptoHasher("sha256").update(raw).digest("hex");
};

/**
 * Checks a server's key and models before the run, so operators get a clear code instead of a failed answer.
 * Results are kept a few minutes by a digest of the key, never the key itself; a network failure here lets the run try.
 */
export const preflight = async (provider: ByokProvider, net: Net): Promise<ApiFailure | undefined> => {
  const key = await keyOf(provider);
  const known = checked.get(key);
  if (known && known.until > Date.now()) return known.failure;
  let failure: ApiFailure | undefined;
  try {
    failure = isOpenRouter(provider.baseURL) ? await checkOpenRouter(provider, net) : await checkCompatible(provider, net);
  } catch (error) {
    logger.warn(`Couldn't check a provider at ${new URL(provider.baseURL).host}: ${redact(String(error), provider.apiKey)}`);
    return undefined;
  }
  checked.set(key, { until: Date.now() + (failure ? FAILED_TTL : PASSED_TTL), failure });
  if (checked.size > 10_000) checked.clear();
  return failure;
};

/** Forgets cached checks and the catalog; for tests. */
export const resetChecks = () => {
  checked.clear();
  catalog = undefined;
};
