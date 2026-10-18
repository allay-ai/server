import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { perplexitySearchRequest } from "@mastra/perplexity";
import { generateText } from "ai";
import { costOf, isOpenRouter } from "../../infrastructure/providers/openrouter/openrouter.client";
import { redact } from "../../shared/lib/redact";
import { type Net, catalogCheck } from "../billing/byok";
import { telegramApi } from "../telegram/telegram.client";

export type CheckResult = { ok: true; detail: string; ms: number } | { ok: false; error: string; ms: number };

const timed = async (run: () => Promise<string>, secret?: string): Promise<CheckResult> => {
  const started = Date.now();
  try {
    return { ok: true, detail: await run(), ms: Date.now() - started };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { ok: false, error: redact(text, secret).slice(0, 500), ms: Date.now() - started };
  }
};

/** “Test key and model”: the catalog's word on tools, then one tiny completion on the given key. */
export const checkModel = (input: { apiKey?: string; baseURL: string; model: string }, net: Net) =>
  timed(async () => {
    if (!input.apiKey) throw new Error("No OpenRouter key is set");
    if (isOpenRouter(input.baseURL)) {
      const catalog = await catalogCheck(input.baseURL, input.model, net);
      if (catalog === "missing") throw new Error(`OpenRouter doesn't know ${input.model}`);
      if (catalog === "no_tools") throw new Error(`${input.model} can't call tools, and Allay needs them`);
    }
    const model = isOpenRouter(input.baseURL)
      ? createOpenRouter({ apiKey: input.apiKey, baseURL: input.baseURL }).chat(input.model, { usage: { include: true } })
      : createOpenAICompatible({ name: "check", baseURL: input.baseURL, apiKey: input.apiKey, includeUsage: true })(input.model);
    const result = await generateText({ model, prompt: "Reply with the single word OK.", maxRetries: 0, abortSignal: AbortSignal.timeout(30_000) });
    const cost = costOf(result.providerMetadata);
    return `${input.model} answered “${result.text.trim().slice(0, 40)}”${cost ? ` for $${cost.toFixed(6)}` : ""}`;
  }, input.apiKey);

/** “Test Perplexity”: one search with a single result, which costs $0.005. */
export const checkPerplexity = (apiKey: string | undefined) =>
  timed(async () => {
    if (!apiKey) throw new Error("No Perplexity key is set");
    const response = await perplexitySearchRequest(
      { query: "Minecraft Java Edition latest version", max_results: 1, max_tokens_per_page: 64 },
      { apiKey, fetch: ((url: string, init: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })) as typeof fetch },
    );
    return `found ${response.results.length} result${response.results.length === 1 ? "" : "s"}`;
  }, apiKey);

/** “Test bot”: getMe with the token. */
export const checkBot = (input: { token?: string; base: string; test: boolean }) =>
  timed(async () => {
    if (!input.token) throw new Error("No bot token is set");
    const me = await telegramApi(input.token, { base: input.base, test: input.test }).call<{ username: string }>("getMe");
    return `@${me.username}`;
  }, input.token);
