import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { AllayDeps } from "../src/agent/allay";
import { ToolBridge } from "../src/features/chat/chat.bridge";
import { memoryHistory } from "../src/infrastructure/history/history";
import { memoryMemories } from "../src/infrastructure/memory/memory";
import type { ModelFactory } from "../src/infrastructure/providers/openrouter/openrouter.client";
import { type Billing, newLimits } from "../src/features/billing/billing";
import type { Net } from "../src/features/billing/byok";
import { memoryLicenses } from "../src/infrastructure/billing/licenses";

const usage = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 5, reasoning: 2 },
};

export const finish = (reason: "stop" | "tool-calls" = "stop"): LanguageModelV4StreamPart => ({
  type: "finish",
  usage,
  finishReason: { unified: reason, raw: reason },
  providerMetadata: { openrouter: { usage: { cost: 0.0005 } } },
});

export const text = (...deltas: string[]): LanguageModelV4StreamPart[] => [
  { type: "text-start", id: "t" },
  ...deltas.map((delta) => ({ type: "text-delta" as const, id: "t", delta })),
  { type: "text-end", id: "t" },
];

export const reasoning = (delta: string): LanguageModelV4StreamPart[] => [
  { type: "reasoning-start", id: "r" },
  { type: "reasoning-delta", id: "r", delta },
  { type: "reasoning-end", id: "r" },
];

export const toolCall = (toolName: string, input: object, id = `call-${toolName}`): LanguageModelV4StreamPart => ({
  type: "tool-call",
  toolCallId: id,
  toolName,
  input: JSON.stringify(input),
});

/** A model that plays back one scripted stream per call, and records what it was sent and which tools it was offered. */
export const scripted = (steps: LanguageModelV4StreamPart[][]) => {
  const prompts: unknown[] = [];
  const offered: string[][] = [];
  let index = 0;
  const model = new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: async (options) => {
      prompts.push(options.prompt);
      offered.push((options.tools ?? []).map((tool) => tool.name));
      const parts = steps[Math.min(index++, steps.length - 1)];
      return { stream: convertArrayToReadableStream(parts) };
    },
    // generateText (web search) asks for the whole answer at once.
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      const parts = steps[Math.min(index++, steps.length - 1)];
      const text = parts.flatMap((p) => (p.type === "text-delta" ? [p.delta] : [])).join("");
      return {
        content: [
          { type: "text", text },
          { type: "source", sourceType: "url", id: "s1", url: "https://minecraft.wiki/w/Java_Edition_26.3" },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        // What OpenRouter charges for a web search or a summary.
        providerMetadata: { openrouter: { usage: { cost: 0.002 } } },
        warnings: [],
      };
    },
  });
  return { model, prompts, offered };
};

/** A network where every provider accepts every key and every host is public, unless a test says otherwise. */
export const fakeNet = (routes: Record<string, (init?: RequestInit) => Response> = {}): Net & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push(url);
      const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
      return route ? route[1](init) : Response.json({ data: [] });
    },
    resolve: async (host) => (host.endsWith(".internal") ? ["10.0.0.5"] : ["93.184.216.34"]),
  };
};

/** Billing as a self-hosted backend has it, or on with an in-memory store and a bot named allay_test_bot. */
export const testBilling = (options: { enabled?: boolean; net?: Net; now?: () => Date } = {}): Billing => ({
  enabled: options.enabled ?? false,
  licenses: memoryLicenses(),
  net: options.net ?? fakeNet(),
  bot: { username: "allay_test_bot", admins: [42] },
  limits: newLimits(),
  now: options.now ?? (() => new Date()),
});

export const testDeps = (
  chat: LanguageModelV4,
  options: { search?: LanguageModelV4; toolTimeoutMs?: number; billing?: Billing } = {},
): AllayDeps & { searchCalls: number; lastProvider?: unknown; lastModel?: string } => {
  const deps = {
    searchCalls: 0,
    lastProvider: undefined as unknown,
    lastModel: undefined as string | undefined,
    history: memoryHistory(),
    memories: memoryMemories(),
    bridge: new ToolBridge(options.toolTimeoutMs ?? 2_000),
    billing: options.billing ?? testBilling(),
    models: (({ search, provider, model }) => {
      deps.lastProvider = provider;
      if (search) {
        deps.searchCalls++;
        return options.search ?? chat;
      }
      deps.lastModel = model;
      return chat;
    }) as ModelFactory,
  };
  return deps;
};

export interface SseEvent {
  event: string;
  data: any;
}

/** Reads an SSE response; `onEvent` may answer tool calls while the stream is open. */
export const readSse = async (response: Response, onEvent?: (event: SseEvent) => Promise<void> | void): Promise<SseEvent[]> => {
  const events: SseEvent[] = [];
  const reader = (response.body as ReadableStream<Uint8Array>).pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (block.startsWith(":")) continue;
      const name = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      if (!name || data === undefined) continue;
      const event = { event: name, data: JSON.parse(data) };
      events.push(event);
      await onEvent?.(event);
    }
  }
  return events;
};
