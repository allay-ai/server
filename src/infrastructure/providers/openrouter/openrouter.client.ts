import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { openrouterEnv } from "./openrouter.env";

/** A server's own key and models (BYOK), used for one run and never stored. */
export interface ByokProvider {
  baseURL: string;
  apiKey: string;
  /** Empty means the backend's own model, which only OpenRouter has. */
  model?: string;
  /** Empty means no web search for this run. */
  searchModel?: string;
  /** How requests reach it; a hosted backend gives one that refuses private addresses and redirects. */
  fetch?: typeof fetch;
}

/**
 * Without a provider, the run goes on the backend's own key and models: a subscription, or a self-hosted backend.
 * `model` replaces the backend's main model on its own key; the gate passes one only when billing is off.
 */
export type ModelFactory = (options: { provider?: ByokProvider; platform: string; search?: boolean; model?: string }) => LanguageModelV4;

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";

export const isOpenRouter = (baseURL: string) => {
  try {
    return new URL(baseURL).hostname === "openrouter.ai";
  } catch {
    return false;
  }
};

/** The v1 header X-OpenRouter-Token: BYOK on OpenRouter with the backend's models, search included. */
export const openrouterToken = (token: string): ByokProvider => {
  const env = openrouterEnv();
  return { baseURL: OPENROUTER_URL, apiKey: token, model: env.model, searchModel: env.searchModel };
};

const headers = (platform: string) => {
  const env = openrouterEnv();
  return { "HTTP-Referer": env.apiUrl, "X-Title": `${env.apiName}/${platform}` };
};

/**
 * Anthropic's models cache a prompt only when asked; OpenAI's and most others do it by themselves. Each step of a run
 * sends the same system prompt, tools, and history again, so without caching a Claude model costs several times more.
 */
export const cachingOf = (modelId: string): { cache_control?: { type: "ephemeral" } } =>
  /(^|[~/])anthropic\//.test(modelId) ? { cache_control: { type: "ephemeral" } } : {};

/** Which providers OpenRouter may route to: by default only those that don't store or train on requests. */
const routing = () => ({ provider: { data_collection: openrouterEnv().dataCollection } });

/** OpenRouter's own client for OpenRouter, a plain OpenAI-compatible one for any other API. */
const byokModel = (provider: ByokProvider, platform: string, search: boolean): LanguageModelV4 => {
  const modelId = (search ? provider.searchModel : provider.model) || openrouterEnv().model;
  if (isOpenRouter(provider.baseURL)) {
    const client = createOpenRouter({ apiKey: provider.apiKey, baseURL: provider.baseURL, headers: headers(platform), ...(provider.fetch ? { fetch: provider.fetch } : {}) });
    return client.chat(modelId, { usage: { include: true }, ...routing(), ...(search ? {} : cachingOf(modelId)) });
  }
  // Other APIs reject OpenRouter's extra fields, so they get the standard request only.
  return createOpenAICompatible({ name: "byok", baseURL: provider.baseURL, apiKey: provider.apiKey, includeUsage: true, ...(provider.fetch ? { fetch: provider.fetch } : {}) })(modelId);
};

/** The models for a run: the server's own key when it brought one, the backend's otherwise. */
export const openrouterModels: ModelFactory = ({ provider, platform, search, model }) => {
  if (provider) return byokModel(provider, platform, !!search);
  const env = openrouterEnv();
  if (!env.apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const client = createOpenRouter({ apiKey: env.apiKey, baseURL: env.baseURL, headers: headers(platform) });
  if (search) {
    return client.chat(env.searchModel, {
      usage: { include: true },
      ...routing(),
      extraBody: { web_search_options: { search_context_size: env.searchContext } },
    });
  }
  return client.chat(model || env.model, {
    usage: { include: true },
    ...routing(),
    ...cachingOf(model || env.model),
    ...(env.reasoningEffort ? { reasoning: { effort: env.reasoningEffort } } : {}),
  });
};

/** What OpenRouter charged for a generation, from the metadata it returns; other APIs report nothing. */
export const costOf = (metadata: unknown): number => {
  const cost = (metadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage?.cost;
  return typeof cost === "number" ? cost : 0;
};
