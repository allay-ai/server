import type { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { APICallError, type ModelMessage } from "ai";
import type { AdminDeps } from "../features/admin/admin";
import type { Billing } from "../features/billing/billing";
import type { ToolBridge } from "../features/chat/chat.bridge";
import type { Emit } from "../features/chat/chat.events";
import { settings } from "../features/settings/settings";
import { exactCalculationsTool } from "../features/tools/exact-calculations.tool";
import { gameTools, offeredTools } from "../features/tools/game.tools";
import { memoryTools } from "../features/tools/memory.tools";
import { type PerplexitySearch, searchWebTool } from "../features/tools/search-web.tool";
import type { RunKind, RunRecord, RunStore } from "../infrastructure/runs/runs";
import { estimateTokens, type HistoryStore, maxTokens, threadOf } from "../infrastructure/history/history";
import type { Pseudonyms } from "../infrastructure/privacy/pseudonyms";
import type { ConsentStore } from "../infrastructure/privacy/consents";
import type { BanStore } from "../infrastructure/privacy/bans";
import type { PlayerDirectory } from "../infrastructure/privacy/players";
import type { ServerDirectory } from "../infrastructure/servers/servers";
import type { TraceStore } from "../infrastructure/observability/traces";
import type { Owner } from "../shared/types/owner";
import type { Memory, MemoryStore } from "../infrastructure/memory/memory";
import { type ByokProvider, type ModelFactory, costOf } from "../infrastructure/providers/openrouter/openrouter.client";
import { redact } from "../shared/lib/redact";
import { logger } from "../shared/logging/logger";
import { API_ERRORS, ApiFailure, apierror } from "../shared/types/errors";
import type { CommandsResult, RunContext, RunResult, Usage } from "./agent.types";
import { commandsFromText, commandsSchema, validateCommands } from "./commands";
import { systemPrompt } from "./prompts";
import { Exchange } from "./exchange";
import { localStamp } from "./time";
import { summarizeWith } from "./summary";

export interface AllayDeps {
  models: ModelFactory;
  history: HistoryStore;
  memories: MemoryStore;
  /** Which players agreed to have their data processed, as the plugin asked them. */
  consents: ConsentStore;
  /** Players operators stopped from asking. */
  bans: BanStore;
  bridge: ToolBridge;
  billing: Billing;
  /** Perplexity's Search API for runs on the backend's own key; without it they use the search model. */
  perplexity?: PerplexitySearch;
  /** Where runs are traced; none in tests. */
  mastra?: Mastra;
  /** The admin panel's accounts and sessions; tests that don't touch the panel leave it out. */
  admin?: AdminDeps;
  /** Where each run's numbers go for the panel's statistics. */
  runs?: RunStore;
  /** Turns a player's id into what `runs` keeps instead: a keyed digest, never the id itself. */
  pseudonyms: Pseudonyms;
  /** Who each pseudonym is, so the panel can name players; none where the panel isn't kept. */
  players?: PlayerDirectory;
  /** Where each Minecraft server connects from and what it runs, for the panel. */
  servers?: ServerDirectory;
  /** Mastra's traces, so a player's erasure reaches them too; none without tracing. */
  traces?: TraceStore;
}

/** Who pays for a run, as the statistics name it; never a key or a license secret. */
export interface RunPayer {
  kind: RunRecord["payer"];
  /** The license that pays. */
  id?: string;
}

export interface RunOptions {
  runId: string;
  emit: Emit;
  signal?: AbortSignal;
  /** Called with every cost the run incurs, as it happens: model steps, web searches, the session summary after it. */
  spend?: (usd: number) => void;
  payer?: RunPayer;
}

/** What a task's thread records for a wake that ended with tool calls only. */
export const TASK_WAITING = "(waiting)";

/** v1 callers without a user id share "anonymous"; they get no memory. */
const remembers = (userId: string) => userId !== "anonymous";

export const ownerOf = (context: RunContext): Owner => ({ tenant: context.tenant, userId: context.userId });

const loadMemories = async (deps: AllayDeps, context: RunContext): Promise<Memory[]> => {
  if (!remembers(context.userId)) return [];
  try {
    const memories = await deps.memories.list(ownerOf(context));
    if (memories.length) void deps.memories.touch(ownerOf(context)).catch(() => undefined);
    return memories;
  } catch (error) {
    // Memories are a nicety, like history: answer without them.
    logger.warn(`Memories unavailable: ${String(error)}`);
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
  // Anything else is ours: its text may name hosts, paths, or a database, so it stays in the log and the client gets the code.
  const text = redact(error instanceof Error ? error.message : String(error), provider?.apiKey);
  if (/fetch|network|ECONN|ETIMEDOUT|socket/i.test(text)) return new ApiFailure(apierror(API_ERRORS.NETWORK_ERROR));
  return new ApiFailure(apierror(API_ERRORS.AI_REQUEST_FAILED));
};

/**
 * The question as the model reads it: Minecraft questions start with the player's real date and time, and a private
 * one with how the player's automations ended since the last question, so the chat never thinks a finished task runs.
 */
const question = (context: RunContext, outcomes: string[] = []): string => {
  if (context.platform !== "minecraft" || context.mode !== "ask") return context.message;
  // Several players share a public thread, so each question there carries the asker's name.
  const name = context.visibility === "public" && context.player ? `[${context.player.name}] ` : "";
  return [...outcomes, `${name}${localStamp(context.timezone)} ${context.message}`].join("\n");
};

/** Outcomes go only to the player's own chat: that's where tasks start, and a public thread mustn't hear them. */
const hearsOutcomes = (context: RunContext) => context.platform === "minecraft" && context.mode === "ask" && context.visibility !== "public";

/** How a task ended, as its chat reads it before the next question. */
const outcomeOf = (context: RunContext, summary: string) =>
  `[Automation «${context.task!.name}» (${context.task!.id})${context.task!.depth === 2 ? ", a sub-agent," : ""} finished ${localStamp(context.timezone)}: ${summary.trim().slice(0, 500)}]`;

type Steps = { steps: Array<{ toolCalls?: Array<{ toolName?: string; payload?: { toolName?: string } }> }> };

/** Stop conditions as Mastra calls them; giving any replaces its maxSteps, so the step limit comes along. */
const stepsReach = (max: number) => ({ steps }: Steps) => steps.length >= max;
const endsWake = ({ steps }: Steps) => (steps.at(-1)?.toolCalls ?? []).some((call) => ["wait", "finish"].includes(call.toolName ?? call.payload?.toolName ?? ""));

const thread = (context: RunContext) => threadOf(ownerOf(context), context.visibility, context.server?.id, context.task?.id);

/** Adds this exchange to the session; askx requests go in with a slash so later answers know what was run. */
const record = (context: RunContext, deps: AllayDeps, asked: string, said: ModelMessage[]) =>
  deps.history.append(thread(context), { role: "user", content: context.mode === "askx" ? `/askx ${context.message}` : asked }, ...said);

const kindOf = (context: RunContext): RunKind => {
  if (context.platform === "telegram") return "telegram";
  if (context.mode === "ask") return context.visibility === "public" ? "askall" : "ask";
  return context.mode;
};

/**
 * Hands a run's numbers to the statistics; they never hold a word of the question or the answer. The run knows the
 * player by a keyed digest; the directory says who that is, so a rename or an erasure reaches every run at once.
 */
const report = (deps: AllayDeps, context: RunContext, options: Pick<RunOptions, "runId" | "payer">, run: Omit<RunRecord, "id" | "kind" | "payer" | "server" | "server_id" | "user_id" | "language">, kind = kindOf(context)) => {
  if (!deps.runs) return;
  const record: RunRecord = {
    id: options.runId,
    kind,
    payer: options.payer?.kind ?? "self",
    server: context.tenant,
    ...(context.server?.id ? { server_id: context.server.id } : {}),
    user_id: deps.pseudonyms.of(context.userId),
    ...(context.locale ? { language: context.locale } : {}),
    ...run,
  };
  deps.runs.add(record).catch((error) => logger.warn(`Couldn't keep the numbers of run ${options.runId}: ${String(error)}`));
  if (kind !== "summary" && context.player?.private) {
    deps.players?.forget(context.tenant, record.user_id).catch((error) => logger.warn(`Couldn't forget the player of run ${options.runId}: ${String(error)}`));
  } else if (kind !== "summary" && context.player?.name) {
    deps.players
      ?.seen({ tenant: context.tenant, pseudonym: record.user_id, user_id: context.userId, name: context.player.name.slice(0, 32), ...(context.player.op === undefined ? {} : { op: context.player.op }) }, run.at)
      .catch((error) => logger.warn(`Couldn't note the player of run ${options.runId}: ${String(error)}`));
  }
};

const compact = async (context: RunContext, deps: AllayDeps, spend?: (usd: number) => void, foldAt?: number, options?: Pick<RunOptions, "runId" | "payer">) => {
  const started = Date.now();
  let cost = 0;
  let usage = { input: 0, output: 0 };
  const charge = (usd: number) => {
    cost += usd;
    spend?.(usd);
  };
  try {
    const model = deps.models({ provider: context.provider, platform: context.platform, model: context.model });
    const folded = await deps.history.compact(thread(context), summarizeWith(model, charge, (u) => (usage = u)), foldAt);
    if (folded) {
      logger.info(`Folded a ${thread(context).kind} session`);
      report(
        deps,
        context,
        { runId: crypto.randomUUID(), payer: options?.payer },
        { at: new Date(started), model: model.modelId, input_tokens: usage.input, output_tokens: usage.output, reasoning_tokens: 0, cost, steps: 1, tools: [], searches: 0, duration_ms: Date.now() - started, result: "ok" },
        "summary",
      );
    }
  } catch (error) {
    logger.warn(`Couldn't fold a ${thread(context).kind} session: ${redact(String(error), context.provider?.apiKey)}`);
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
  let modelId = context.model ?? "unknown";
  let steps = 0;
  const called = new Map<string, { name: string; ok: boolean }>();
  // Taken before the run and put back if it fails, so a failed question doesn't lose them.
  let outcomes: string[] = [];
  const finishing = new Map<string, string>();
  const sofar: Usage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cost: 0 };
  const spend = (usd: number) => {
    if (usd <= 0) return;
    cost += usd;
    options.spend?.(usd);
  };
  try {
    const model = deps.models({ provider: context.provider, platform: context.platform, model: context.model });
    modelId = model.modelId;
    const offered = offeredTools(context.tools, context.player?.op === true, context.mode, context.visibility, context.task?.depth ?? 0, context.task?.kind);
    const memories = await loadMemories(deps, context);
    // askx turns one request into commands; earlier chat would only confuse it, as in v1. A task reads its own thread.
    let session = context.mode === "askx" ? { messages: [] } : await deps.history.load(thread(context));
    // Folding after answers keeps a session well below this; a fold that failed, or one huge exchange, may not.
    if (estimateTokens(session.messages) > maxTokens()) {
      await compact(context, deps, spend, maxTokens(), options);
      session = await deps.history.load(thread(context));
    }
    const instructions = systemPrompt({ ...context, tools: offered }, { memories, summary: session.summary });
    const agent = new Agent({ id: "allay", name: "Allay", instructions, model });
    if (deps.mastra) agent.__registerMastra(deps.mastra);
    if (hearsOutcomes(context)) outcomes = await deps.history.takeOutcomes(ownerOf(context));
    const asked = question(context, outcomes);
    const messages: ModelMessage[] = [...session.messages, { role: "user", content: asked }];

    emit({ event: "start", data: { run_id: runId, model: model.modelId } });

    const common = {
      runId,
      abortSignal: signal,
      // An automation agent's wake reads, plans, and acts in one go, so it gets more steps than a question.
      maxSteps: context.mode === "task" ? settings.get("MAX_TASK_STEPS") : settings.get("MAX_AGENT_STEPS"),
      // wait and finish end a wake. Left to itself the model kept calling wait, a paid step each, a dozen times a wake.
      ...(context.mode === "task" ? { stopWhen: [stepsReach(settings.get("MAX_TASK_STEPS")), endsWake] } : {}),
      modelSettings: { maxRetries: 2 },
      toolsets: {
        game: gameTools(offered, runId, deps.bridge, { offered: context.tools, readOnly: context.mode === "askx" }),
        // A server that brought its own key without a search model gets no web search, and an automation agent never does.
        ...(context.mode === "task" || (context.provider && !context.provider.searchModel)
          ? {}
          : { web: { search_web: searchWebTool(deps.models, { provider: context.provider, platform: context.platform, emit, spend, perplexity: deps.perplexity }) } }),
        math: { exact_calculations: exactCalculationsTool({ emit }) },
        ...(context.mode === "ask" && remembers(context.userId)
          ? { memory: memoryTools(deps.memories, { owner: ownerOf(context), emit }) }
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
          called.set(String(payload.toolCallId), { name: String(payload.toolName), ok: true });
          if (context.mode === "task" && context.task && payload.toolName === "finish") {
            const summary = (payload.args as { summary?: unknown } | undefined)?.summary;
            if (typeof summary === "string" && summary.trim()) finishing.set(String(payload.toolCallId), summary);
          }
          break;
        case "tool-result": {
          exchange.result(payload);
          // Game tools answer a failure as { error }, server tools too; it counts as failed either way.
          const result = payload.result as { error?: unknown } | null | undefined;
          const call = called.get(String(payload.toolCallId));
          if (call && result && typeof result === "object" && "error" in result) call.ok = false;
          // The plugin ended the task: its chat hears how with the player's next question.
          const summary = finishing.get(String(payload.toolCallId));
          if (summary && call?.ok) await deps.history.noteOutcome(ownerOf(context), outcomeOf(context, summary));
          break;
        }
        case "tool-error": {
          exchange.error(payload);
          const call = called.get(String(payload.toolCallId));
          if (call) call.ok = false;
          break;
        }
        case "step-finish": {
          steps++;
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
    report(deps, context, options, {
      at: new Date(started),
      model: modelId,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      reasoning_tokens: usage.reasoning_tokens,
      cost: usage.cost,
      steps,
      tools: [...called.values()],
      searches: [...called.values()].filter((t) => t.name === "search_web").length,
      duration_ms: result.durationMs,
      result: "ok",
    });
    // After done: the player has the answer, and the summary can take its time.
    void compact(context, deps, options.spend, undefined, options);
    return result;
  } catch (error) {
    for (const outcome of outcomes) await deps.history.noteOutcome(ownerOf(context), outcome);
    const failure = classify(error, signal, context.provider);
    logger.warn(`Run ${runId} failed: ${failure.code} ${failure.message}${error instanceof ApiFailure || APICallError.isInstance(error) ? "" : ` (${redact(error instanceof Error ? error.message : String(error), context.provider?.apiKey)})`}`);
    report(deps, context, options, {
      at: new Date(started),
      model: modelId,
      input_tokens: sofar.input_tokens,
      output_tokens: sofar.output_tokens,
      reasoning_tokens: sofar.reasoning_tokens,
      cost: Math.round(cost * 1_000_000) / 1_000_000,
      steps,
      tools: [...called.values()],
      searches: [...called.values()].filter((t) => t.name === "search_web").length,
      duration_ms: Date.now() - started,
      result: failure.code === API_ERRORS.CANCELLED.code ? "cancelled" : "error",
      error_code: failure.code,
    });
    emit({ event: "error", data: { code: failure.code, message: failure.message } });
    throw failure;
  }
};
