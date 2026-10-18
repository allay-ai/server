import type { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { APICallError, type ModelMessage } from "ai";
import type { Billing } from "../features/billing/billing";
import type { ToolBridge } from "../features/chat/chat.bridge";
import type { Emit } from "../features/chat/chat.events";
import { exactCalculationsTool } from "../features/tools/exact-calculations.tool";
import { gameTools, offeredTools } from "../features/tools/game.tools";
import { memoryTools } from "../features/tools/memory.tools";
import { type PerplexitySearch, searchWebTool } from "../features/tools/search-web.tool";
import { estimateTokens, type HistoryStore, IDLE_FOLD, IDLE_FOLD_SECONDS, IDLE_FOLD_TOKENS, MAX_TOKENS, threadOf } from "../infrastructure/history/history";
import type { Memory, MemoryStore } from "../infrastructure/memory/memory";
import { type ByokProvider, type ModelFactory, costOf } from "../infrastructure/providers/openrouter/openrouter.client";
import { redact } from "../shared/lib/redact";
import { logger } from "../shared/logging/logger";
import { API_ERRORS, ApiFailure, apierror } from "../shared/types/errors";
import type { CommandsResult, RunContext, RunResult, Usage } from "./agent.types";
import { commandsFromText, commandsSchema, validateCommands } from "./commands";
import { systemPrompt } from "./prompts";
import { Exchange } from "./exchange";
import { cancelIdleFold, foldWhenIdle } from "./idle";
import { localStamp } from "./time";
import { summarizeWith } from "./summary";

export interface AllayDeps {
  models: ModelFactory;
  history: HistoryStore;
  memories: MemoryStore;
  bridge: ToolBridge;
  billing: Billing;
  /** Perplexity's Search API for runs on the backend's own key; without it they use the search model. */
  perplexity?: PerplexitySearch;
  /** Where runs are traced; none in tests. */
  mastra?: Mastra;
  /** How long a session stays quiet before it folds: IDLE_FOLD_SECONDS by default, shorter in tests; 0 never. */
  idleFoldMs?: number;
}

export interface RunOptions {
  runId: string;
  emit: Emit;
  signal?: AbortSignal;
  /** Called with every cost the run incurs, as it happens: model steps, web searches, the session summary after it. */
  spend?: (usd: number) => void;
}

const MAX_STEPS = Number(process.env.MAX_AGENT_STEPS || 8);
/** An automation agent's wake reads, plans, and acts in one go, so it gets more steps than a question. */
const MAX_TASK_STEPS = Number(process.env.MAX_TASK_STEPS || 16);
/** What a task's thread records for a wake that ended with tool calls only. */
export const TASK_WAITING = "(waiting)";

/** v1 callers without a user id share "anonymous"; they get no memory. */
const remembers = (userId: string) => userId !== "anonymous";

const loadMemories = async (deps: AllayDeps, userId: string): Promise<Memory[]> => {
  if (!remembers(userId)) return [];
  try {
    return await deps.memories.list(userId);
  } catch (error) {
    // Memories are a nicety, like history: answer without them.
    logger.warn(`Memories unavailable for ${userId}: ${String(error)}`);
    return [];
  }
};

/** The parts of Mastra's stream output this runner reads, the same for both modes. */
interface AgentStream {
  fullStream: AsyncIterable<{ type: string; payload?: Record<string, unknown> }>;
  usage: Promise<{ inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | undefined>;
  object: Promise<unknown>;
}

/** A provider's refusal of the server's own key or model, in codes the plugin explains to operators. */
const byokFailure = (error: APICallError, text: string): ApiFailure | undefined => {
  const status = error.statusCode ?? 0;
  if (status === 401 || status === 403) return new ApiFailure(apierror(API_ERRORS.PROVIDER_AUTH_FAILED, text));
  if (/tool|function/i.test(text) && /support|not allowed|unavailable|invalid/i.test(text)) {
    return new ApiFailure(apierror(API_ERRORS.MODEL_NO_TOOLS, text));
  }
  if (status === 404 || /model.*(not found|not exist|invalid)|no (such|endpoints?).*model/i.test(text)) {
    return new ApiFailure(apierror(API_ERRORS.MODEL_NOT_FOUND, text));
  }
  return undefined;
};

/** Turns whatever went wrong into an error code the plugin and the bot already understand. */
export const classify = (error: unknown, signal?: AbortSignal, provider?: ByokProvider): ApiFailure => {
  if (error instanceof ApiFailure) return error;
  if (signal?.aborted) return new ApiFailure(apierror(API_ERRORS.CANCELLED));
  if (APICallError.isInstance(error)) {
    const text = redact(`${error.statusCode ?? ""} ${error.message}`.trim(), provider?.apiKey);
    return (provider && byokFailure(error, text)) || new ApiFailure(apierror(API_ERRORS.AI_REQUEST_FAILED, text));
  }
  const text = redact(error instanceof Error ? error.message : String(error), provider?.apiKey);
  if (/fetch|network|ECONN|ETIMEDOUT|socket/i.test(text)) return new ApiFailure(apierror(API_ERRORS.NETWORK_ERROR, text));
  return new ApiFailure(apierror(API_ERRORS.AI_REQUEST_FAILED, text));
};

/** The question as the model reads it: Minecraft questions start with the player's real date and time. */
const question = (context: RunContext): string => {
  if (context.platform !== "minecraft" || context.mode !== "ask") return context.message;
  // Several players share a public thread, so each question there carries the asker's name.
  const name = context.visibility === "public" && context.player ? `[${context.player.name}] ` : "";
  return `${name}${localStamp(context.timezone)} ${context.message}`;
};

const thread = (context: RunContext) => threadOf(context.userId, context.visibility, context.server?.id, context.task?.id);

/** Adds this exchange to the session; askx requests go in with a slash so later answers know what was run. */
const record = (context: RunContext, deps: AllayDeps, asked: string, said: ModelMessage[]) =>
  deps.history.append(thread(context), { role: "user", content: context.mode === "askx" ? `/askx ${context.message}` : asked }, ...said);

const compact = async (context: RunContext, deps: AllayDeps, spend?: (usd: number) => void, foldAt?: number) => {
  try {
    const model = deps.models({ provider: context.provider, platform: context.platform, model: context.model });
    if (await deps.history.compact(thread(context), summarizeWith(model, spend), foldAt)) logger.info(`Folded the session of ${thread(context)}`);
  } catch (error) {
    logger.warn(`Couldn't fold the session of ${thread(context)}: ${redact(String(error), context.provider?.apiKey)}`);
  }
};

/**
 * One question to Allay: builds the agent for this player, streams its work as protocol
 * events, and returns the final answer (or commands for askx).
 */
export const runAllay = async (context: RunContext, deps: AllayDeps, options: RunOptions): Promise<RunResult> => {
  const started = Date.now();
  const { runId, emit, signal } = options;
  let cost = 0;
  const spend = (usd: number) => {
    if (usd <= 0) return;
    cost += usd;
    options.spend?.(usd);
  };
  cancelIdleFold(thread(context));
  try {
    const model = deps.models({ provider: context.provider, platform: context.platform, model: context.model });
    const tools = offeredTools(context.tools, context.player?.op === true, context.mode, context.visibility, context.task?.depth ?? 0);
    const memories = await loadMemories(deps, context.userId);
    // askx turns one request into commands; earlier chat would only confuse it, as in v1. A task reads its own thread.
    let session = context.mode === "askx" ? { messages: [] } : await deps.history.load(thread(context));
    // Folding after answers keeps a session well below this; a fold that failed, or one huge exchange, may not.
    if (estimateTokens(session.messages) > MAX_TOKENS) {
      await compact(context, deps, spend, MAX_TOKENS);
      session = await deps.history.load(thread(context));
    }
    const instructions = systemPrompt({ ...context, tools }, { memories, summary: session.summary });
    const agent = new Agent({ id: "allay", name: "Allay", instructions, model });
    if (deps.mastra) agent.__registerMastra(deps.mastra);
    const asked = question(context);
    const messages: ModelMessage[] = [...session.messages, { role: "user", content: asked }];

    emit({ event: "start", data: { run_id: runId, model: model.modelId } });

    const common = {
      runId,
      abortSignal: signal,
      maxSteps: context.mode === "task" ? MAX_TASK_STEPS : MAX_STEPS,
      modelSettings: { maxRetries: 2 },
      toolsets: {
        game: gameTools(tools, runId, deps.bridge, { offered: context.tools, readOnly: context.mode === "askx" }),
        // A server that brought its own key without a search model gets no web search, and an automation agent never does.
        ...(context.mode === "task" || (context.provider && !context.provider.searchModel)
          ? {}
          : { web: { search_web: searchWebTool(deps.models, { provider: context.provider, platform: context.platform, emit, spend, perplexity: deps.perplexity }) } }),
        math: { exact_calculations: exactCalculationsTool({ emit }) },
        ...(context.mode === "ask" && remembers(context.userId)
          ? { memory: memoryTools(deps.memories, { userId: context.userId, emit }) }
          : {}),
      },
    };
    const stream = (
      context.mode === "askx"
        ? await agent.stream(messages, { ...common, structuredOutput: { schema: commandsSchema } })
        : await agent.stream(messages, common)
    ) as unknown as AgentStream;

    let text = "";
    const exchange = new Exchange();
    // Per-step usage, summed, so the plugin's counter moves while the agent works.
    const sofar: Usage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cost: 0 };
    for await (const chunk of stream.fullStream) {
      const payload = chunk.payload ?? {};
      switch (chunk.type) {
        case "reasoning-delta":
          if (typeof payload.text === "string" && payload.text) emit({ event: "reasoning", data: { delta: payload.text } });
          break;
        case "text-delta":
          if (typeof payload.text === "string") {
            text += payload.text;
            exchange.text(payload.text);
            // askx text is the JSON result, not something to show; a task's is its note, which the plugin keeps to itself.
            if (context.mode !== "askx") emit({ event: "text", data: { delta: payload.text } });
          }
          break;
        case "tool-call":
          exchange.call(payload);
          break;
        case "tool-result":
          exchange.result(payload);
          break;
        case "tool-error":
          exchange.error(payload);
          break;
        case "step-finish": {
          exchange.endStep();
          spend(costOf((payload.metadata as { providerMetadata?: unknown } | undefined)?.providerMetadata));
          const step = (payload.output as { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } | undefined)?.usage;
          sofar.input_tokens += step?.inputTokens ?? 0;
          sofar.output_tokens += step?.outputTokens ?? 0;
          sofar.reasoning_tokens += step?.reasoningTokens ?? 0;
          sofar.cost = Math.round(cost * 1_000_000) / 1_000_000;
          emit({ event: "usage", data: { ...sofar } });
          break;
        }
        case "error":
          throw payload.error ?? new Error("The model stream failed");
      }
    }
    if (signal?.aborted) throw new ApiFailure(apierror(API_ERRORS.CANCELLED));

    const totals = await stream.usage;
    const usage: Usage = {
      input_tokens: totals?.inputTokens ?? 0,
      output_tokens: totals?.outputTokens ?? 0,
      reasoning_tokens: totals?.reasoningTokens ?? 0,
      cost: Math.round(cost * 1_000_000) / 1_000_000,
    };

    let result: RunResult;
    if (context.mode === "askx") {
      const object = (await stream.object.catch(() => undefined)) ?? commandsFromText(text);
      let commands: CommandsResult;
      try {
        commands = validateCommands(object);
      } catch (error) {
        if (error instanceof ApiFailure && error.code === API_ERRORS.AI_ERROR.code) {
          await record(context, deps, asked, [{ role: "assistant", content: `Refused: ${error.message.replace(/^AI returned an error: /, "")}` }]);
        }
        throw error;
      }
      await record(context, deps, asked, [{ role: "assistant", content: `Commands: ${commands.commands.join("; ")}` }]);
      emit({ event: "commands", data: commands });
      result = { answer: "", commands, usage, durationMs: Date.now() - started };
    } else {
      const answer = text.trim();
      // A wake may end with wait or finish and no words; that's done, not a failure.
      if (!answer && context.mode !== "task") throw new ApiFailure(apierror(API_ERRORS.NO_AI_RESPONSE));
      // The tool calls and results go in too, so a later question can refer to what they found. Not in a
      // server's public thread: there they'd hand the asker's inventory and places to whoever asks next.
      const said = context.visibility === "public" ? (answer ? [{ role: "assistant" as const, content: answer }] : []) : exchange.messages();
      await record(context, deps, asked, answer ? said : [...said, { role: "assistant", content: TASK_WAITING }]);
      result = { answer, usage, durationMs: Date.now() - started };
    }
    emit({ event: "usage", data: usage });
    emit({ event: "done", data: { answer: result.answer, duration_ms: result.durationMs } });
    logger.info(`Run ${runId} (${context.mode}/${context.platform}) done in ${result.durationMs} ms, ${usage.output_tokens} tokens`);
    // After done: the player has the answer, and the summary can take its time.
    void compact(context, deps, options.spend);
    const quiet = deps.idleFoldMs ?? (IDLE_FOLD ? IDLE_FOLD_SECONDS * 1000 : 0);
    if (quiet > 0) foldWhenIdle(thread(context), quiet, () => compact(context, deps, options.spend, IDLE_FOLD_TOKENS));
    return result;
  } catch (error) {
    const failure = classify(error, signal, context.provider);
    logger.warn(`Run ${runId} failed: ${failure.code} ${failure.message}`);
    emit({ event: "error", data: { code: failure.code, message: failure.message } });
    throw failure;
  }
};
