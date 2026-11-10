import type { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { APICallError, type ModelMessage } from "ai";
import type { AdminDeps } from "../features/admin/admin";
import type { Billing } from "../features/billing/billing";
import type { ToolBridge } from "../features/chat/chat.bridge";
import type { LiveRuns } from "../features/chat/chat.live";
import type { SchematicCatalog } from "../infrastructure/schematics/catalog";
import { searchSchematicsTool } from "../features/tools/schematics.tool";
import type { Emit } from "../features/chat/chat.events";
import { settings } from "../features/settings/settings";
import { exactCalculationsTool } from "../features/tools/exact-calculations.tool";
import { gameTools, offeredTools } from "../features/tools/game.tools";
import { expansionTools, offeredExpansionTools, promptName } from "../features/tools/expansion.tools";
import { DEATHS_PER_PAGE } from "../features/tools/deaths";
import { memoryTools } from "../features/tools/memory.tools";
import { type PerplexitySearch, searchWebTool } from "../features/tools/search-web.tool";
import type { RunKind, RunRecord, RunStore } from "../infrastructure/runs/runs";
import { estimateTokens, type HistoryStore, maxTokens, ratioOf, threadOf } from "../infrastructure/history/history";
import type { Pseudonyms } from "../infrastructure/privacy/pseudonyms";
import type { ConsentStore } from "../infrastructure/privacy/consents";
import type { BanStore } from "../infrastructure/privacy/bans";
import type { PlayerDirectory } from "../infrastructure/privacy/players";
import type { ServerDirectory } from "../infrastructure/servers/servers";
import type { TraceStore } from "../infrastructure/observability/traces";
import type { Owner } from "../shared/types/owner";
import type { Memory, MemoryStore } from "../infrastructure/memory/memory";
import type { DeathStore } from "../infrastructure/playerdata/deaths";
import type { StateStore } from "../infrastructure/playerdata/state";
import type { WorkStateStore } from "../infrastructure/playerdata/workstate";
import type { ExportStore } from "../infrastructure/playerdata/exports";
import { type ByokProvider, type ModelFactory, costOf } from "../infrastructure/providers/openrouter/openrouter.client";
import { RunTrace } from "../infrastructure/telemetry/run";
import { event } from "../infrastructure/telemetry/signals";
import { redact } from "../shared/lib/redact";
import { logger } from "../shared/logging/logger";
import { API_ERRORS, ApiFailure, apierror } from "../shared/types/errors";
import { ChatText, toMinecraft } from "./chat-text";
import type { CommandsResult, RunContext, RunResult, Usage } from "./agent.types";
import { commandsFromText, commandsSchema, validateCommands } from "./commands";
import { systemPrompt } from "./prompts";
import { Exchange, aged } from "./exchange";
import { type FailureCode, failureCode } from "./failures";
import { promptTokens } from "./tokens";
import { localStamp } from "./time";
import { summarizeWith } from "./summary";

export interface AllayDeps {
  models: ModelFactory;
  history: HistoryStore;
  memories: MemoryStore;
  /** Since 6.9: each player's deaths, which the plugin kept on disk before. */
  deaths: DeathStore;
  /** Since 6.9: each player's time zone, settings, and goals, for the plugin. */
  states: StateStore;
  /** The work state of players' automation agents per server, since 6.31. */
  workstates: WorkStateStore;
  /** Since 6.9: one-day links to a player's copy of their data. */
  exports: ExportStore;
  /** Which players agreed to have their data processed, as the plugin asked them. */
  consents: ConsentStore;
  /** Players operators stopped from asking. */
  bans: BanStore;
  bridge: ToolBridge;
  /** The catalog of real builds the model offers from, allay-ai/schematics (since 6.33); none in tests that don't need it. */
  schematics?: SchematicCatalog;
  /** Runs a plugin may read again after its connection dropped (since 6.31). */
  live: LiveRuns;
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

/** The player asked: what's kept about them lives on, a year for their data and two for their agreement. */
const touch = (deps: AllayDeps, owner: Owner) => {
  for (const store of [deps.memories, deps.deaths, deps.states, deps.consents]) void store.touch(owner).catch(() => undefined);
};

const loadMemories = async (deps: AllayDeps, context: RunContext): Promise<Memory[]> => {
  if (!remembers(context.userId)) return [];
  try {
    const memories = await deps.memories.list(ownerOf(context));
    if (context.platform === "minecraft") touch(deps, ownerOf(context));
    else if (memories.length) void deps.memories.touch(ownerOf(context)).catch(() => undefined);
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

/**
 * The askx lines the server says won't run, as “/line: why”: unknown here, not the player's, blocked, or arguments the
 * game can't parse (plugin 6.16's search_commands with check). None when the plugin couldn't check.
 */
export const uncheckable = async (bridge: ToolBridge, runId: string, commands: string[], signal?: AbortSignal): Promise<string[]> => {
  const answer = await bridge.call(runId, "search_commands", { check: commands }, signal);
  if (!answer.ok || typeof answer.result !== "object" || answer.result === null) return [];
  const checks = (answer.result as { checks?: unknown }).checks;
  if (!Array.isArray(checks)) return [];
  return checks
    .filter((check): check is { command: unknown; ok: false; error?: unknown; usage?: unknown } => typeof check === "object" && check !== null && check.ok === false)
    .map((check) => `/${String(check.command)}: ${String(check.error ?? "won't run")}${typeof check.usage === "string" ? ` (usage: ${check.usage})` : ""}`);
};

/** What the model reads when its commands failed the server's check: the server's words are data, the rules stay. */
export const recheck = (problems: string[]) =>
  [
    "The server checked your commands before running any of them, and these won't run:",
    ...problems.map((problem) => `- ${problem}`),
    "Fix them with the commands this server really has (search_commands lists them with their usage), or refuse with error. Reply with the structured result again.",
  ].join("\n");

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

const thread = (context: RunContext) => threadOf(ownerOf(context), context.visibility, context.server?.id, context.task?.id, context.task?.keep_until);

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
    user_id: deps.pseudonyms.of(context.tenant, context.userId),
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
  const runId = crypto.randomUUID();
  let cost = 0;
  let usage = { input: 0, output: 0 };
  const charge = (usd: number) => {
    cost += usd;
    spend?.(usd);
  };
  const telemetry = traceOf(context, deps, { runId, payer: options?.payer }, "summary");
  const ended = (result: "ok" | "error", errorCode?: string) => {
    telemetry.cost("summary", cost);
    telemetry.end({ result, errorCode, inputTokens: usage.input, outputTokens: usage.output, reasoningTokens: 0, cost, steps: 1, tools: [] });
  };
  try {
    const model = deps.models({ provider: context.provider, platform: context.platform, model: context.model });
    telemetry.model(model.modelId);
    const folded = await deps.history.compact(thread(context), summarizeWith(model, charge, (u) => (usage = u)), foldAt);
    if (folded) {
      logger.info(`Folded a ${thread(context).kind} session`);
      report(
        deps,
        context,
        { runId, payer: options?.payer },
        { at: new Date(started), model: model.modelId, input_tokens: usage.input, output_tokens: usage.output, reasoning_tokens: 0, cost, steps: 1, tools: [], searches: 0, duration_ms: Date.now() - started, result: "ok" },
        "summary",
      );
      ended("ok");
    } else telemetry.discard();
  } catch (error) {
    logger.warn(`Couldn't fold a ${thread(context).kind} session: ${redact(String(error), context.provider?.apiKey)}`);
    ended("error", "SUMMARY_FAILED");
  }
};

/** The run's spans, metrics, and events; the player by pseudonym, as in the statistics. */
const traceOf = (context: RunContext, deps: AllayDeps, options: Pick<RunOptions, "runId" | "payer">, kind = kindOf(context)) =>
  new RunTrace({
    runId: options.runId,
    kind,
    payer: options.payer?.kind ?? "self",
    tenant: context.tenant,
    serverId: context.server?.id,
    player: deps.pseudonyms.of(context.tenant, context.userId),
    platform: context.platform,
    loader: context.server?.loader,
    side: context.server?.side,
    visibility: context.visibility,
    language: context.locale,
    taskKind: context.task?.kind,
    model: context.model ?? "unknown",
    provider: context.provider ? "byok" : "openrouter",
  });

/** How an automation agent's wake ended, from the tools it called last. */
const wakeEnd = (called: Map<string, { name: string; ok: boolean; code?: FailureCode }>) => {
  const names = [...called.values()].map((c) => c.name);
  return names.includes("finish") ? "finish" : names.includes("wait") ? "wait" : "steps";
};

type StepTokens = { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cachedInputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number } };

/** Why a step ended, wherever this Mastra puts it. */
const finishOf = (payload: Record<string, unknown>): string | undefined => {
  const reason = (payload.stepResult as { reason?: unknown } | undefined)?.reason ?? payload.finishReason;
  return typeof reason === "string" ? reason : undefined;
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
  const called = new Map<string, { name: string; ok: boolean; code?: FailureCode }>();
  // Taken before the run and put back if it fails, so a failed question doesn't lose them.
  let outcomes: string[] = [];
  const finishing = new Map<string, string>();
  const sofar: Usage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cost: 0 };
  const spend = (usd: number) => {
    if (usd <= 0) return;
    cost += usd;
    options.spend?.(usd);
  };
  const telemetry = traceOf(context, deps, options);
  let askx: "accepted" | "rechecked" = "accepted";
  try {
    const model = deps.models({ provider: context.provider, platform: context.platform, model: context.model });
    modelId = model.modelId;
    telemetry.model(modelId);
    const offered = offeredTools(context.tools, context.player?.op === true, context.mode, context.visibility, context.task?.depth ?? 0, context.task?.kind);
    const expansions = offeredExpansionTools(context.expansionTools ?? [], context.player?.op === true, context.mode);
    const memories = await telemetry.phase("allay.memories.load", () => loadMemories(deps, context));
    // askx turns one request into commands; earlier chat would only confuse it, as in v1. A task reads its own thread.
    let session = context.mode === "askx" ? { messages: [] } : await telemetry.phase("allay.session.load", () => deps.history.load(thread(context)));
    const size = estimateTokens(session.messages, session.ratio);
    telemetry.contextFill(size / maxTokens());
    // Folding after answers keeps a session well below this; a fold that failed, or one huge exchange, may not.
    if (size > maxTokens()) {
      await telemetry.phase("allay.session.compact", () => compact(context, deps, spend, maxTokens(), options));
      session = await deps.history.load(thread(context));
    }
    const instructions = systemPrompt({ ...context, tools: offered, expansionTools: expansions }, { memories, summary: session.summary });
    const agent = new Agent({ id: "allay", name: "Allay", instructions, model });
    if (deps.mastra) agent.__registerMastra(deps.mastra);
    if (hearsOutcomes(context)) outcomes = await deps.history.takeOutcomes(ownerOf(context));
    const asked = question(context, outcomes);
    // An automation agent reads its own wakes as they were; a chat's earlier tool results are marked old.
    const messages: ModelMessage[] = [...(context.mode === "task" ? session.messages : aged(session.messages)), { role: "user", content: asked }];

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
        game: gameTools(offered, runId, deps.bridge, {
          offered: context.tools,
          schematics: deps.schematics,
          locale: context.locale,
          ...(remembers(context.userId)
            ? { deaths: { page: (page: number) => deps.deaths.page(ownerOf(context), page, DEATHS_PER_PAGE), timezone: context.timezone, position: context.player?.position } }
            : {}),
        }),
        // A server that brought its own key without a search model gets no web search, and an automation agent never does.
        ...(context.mode === "task" || (context.provider && !context.provider.searchModel)
          ? {}
          : {
              web: {
                search_web: searchWebTool(deps.models, {
                  provider: context.provider,
                  platform: context.platform,
                  emit,
                  spend: (usd) => {
                    telemetry.cost("search", usd);
                    spend(usd);
                  },
                  perplexity: deps.perplexity,
                }),
              },
            }),
        math: { exact_calculations: exactCalculationsTool({ emit }) },
        // The catalog of builds, for a plugin that can show and build one (its `build` tool, plugin 6.37+).
        ...(context.tools.includes("build") && deps.schematics
          ? {
              schematics: {
                search_schematics: searchSchematicsTool(deps.schematics, {
                  emit,
                  locale: context.locale,
                  // What this player may build here and what this server's game has: never the model's to lift.
                  filters: { maxBlocks: context.building?.max_blocks, maxSide: context.building?.max_size, dataVersion: context.building?.data_version },
                }),
              },
            }
          : {}),
        // askx only reads them: a remembered place is where “take me to my base” goes.
        ...((context.mode === "ask" || context.mode === "askx") && remembers(context.userId)
          ? { memory: memoryTools(deps.memories, { owner: ownerOf(context), emit, position: context.player?.position, readOnly: context.mode === "askx" }) }
          : {}),
        // After Allay's own tools, so their fixed order keeps the provider's prompt cache.
        ...(expansions.length
          ? { expansions: expansionTools(expansions, runId, deps.bridge, Object.fromEntries((context.expansions ?? []).map((e) => [e.id, promptName(e.name)]))) }
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
    // Minecraft chat shows Markdown as raw stars, so a Minecraft answer goes out in & codes; askx text is JSON.
    const chat = context.platform === "minecraft" && context.mode !== "askx" ? new ChatText() : undefined;
    const write = (piece: string) => {
      if (!piece) return;
      text += piece;
      exchange.text(piece);
      // askx text is the JSON result, not something to show; a task's is its note, which the plugin keeps to itself.
      if (context.mode !== "askx") emit({ event: "text", data: { delta: piece } });
    };
    // Per-step usage, summed, so the plugin's counter moves while the agent works.
    const consume = async (stream: AgentStream) => {
      for await (const chunk of stream.fullStream) {
        const payload = chunk.payload ?? {};
        switch (chunk.type) {
          case "reasoning-delta":
            if (typeof payload.text === "string" && payload.text) {
              telemetry.firstWord();
              emit({ event: "reasoning", data: { delta: payload.text } });
            }
            break;
          case "text-delta":
            if (typeof payload.text === "string") {
              if (payload.text) telemetry.firstWord();
              write(chat ? chat.push(payload.text) : payload.text);
            }
            break;
          case "tool-call":
            if (chat) write(chat.flush());
            exchange.call(payload);
            called.set(String(payload.toolCallId), { name: String(payload.toolName), ok: true });
            telemetry.toolCalled(String(payload.toolCallId), String(payload.toolName), payload.args);
            if (context.mode === "task" && context.task && payload.toolName === "finish") {
              const summary = (payload.args as { summary?: unknown } | undefined)?.summary;
              if (typeof summary === "string" && summary.trim()) finishing.set(String(payload.toolCallId), toMinecraft(summary));
            }
            break;
          case "tool-result": {
            exchange.result(payload);
            // Game tools answer a failure as { error }, server tools too; it counts as failed either way.
            const result = payload.result as { error?: unknown } | null | undefined;
            const call = called.get(String(payload.toolCallId));
            if (call && result && typeof result === "object" && "error" in result) {
              call.ok = false;
              call.code = failureCode(result);
            }
            telemetry.toolEnded(String(payload.toolCallId), call?.ok ?? true, payload.result);
            // The plugin ended the task: its chat hears how with the player's next question.
            const summary = finishing.get(String(payload.toolCallId));
            if (summary && call?.ok) await deps.history.noteOutcome(ownerOf(context), outcomeOf(context, summary));
            break;
          }
          case "tool-error": {
            exchange.error(payload);
            const call = called.get(String(payload.toolCallId));
            if (call) {
              call.ok = false;
              call.code = failureCode({ error: payload.error instanceof Error ? payload.error.message : String(payload.error) });
            }
            telemetry.toolEnded(String(payload.toolCallId), false);
            break;
          }
          case "step-finish": {
            if (chat) write(chat.flush());
            steps++;
            exchange.endStep();
            const stepCost = costOf((payload.metadata as { providerMetadata?: unknown } | undefined)?.providerMetadata);
            spend(stepCost);
            const step = (payload.output as { usage?: StepTokens } | undefined)?.usage;
            // The first step reads the session as it was loaded, so the provider's count of it measures the session in
            // the model's own tokens. Without a count the last measure stays, or o200k alone. askx reads no session.
            if (steps === 1 && stream === firstStream && context.mode !== "askx") {
              const ratio = ratioOf(step?.inputTokens, promptTokens(instructions, common.toolsets as Record<string, Record<string, unknown>>, messages));
              if (ratio) void deps.history.calibrate(thread(context), ratio);
            }
            telemetry.stepFinished({
              inputTokens: step?.inputTokens,
              outputTokens: step?.outputTokens,
              reasoningTokens: step?.reasoningTokens,
              cachedTokens: step?.cachedInputTokens ?? step?.inputTokenDetails?.cacheReadTokens,
              finishReason: finishOf(payload),
              cost: stepCost,
            });
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
      if (chat) write(chat.flush());
      if (signal?.aborted) throw new ApiFailure(apierror(API_ERRORS.CANCELLED));
      return stream.usage;
    };
    const firstStream = stream;
    const totals = [await consume(stream)];
    const usage = (): Usage => ({
      input_tokens: totals.reduce((sum, t) => sum + (t?.inputTokens ?? 0), 0),
      output_tokens: totals.reduce((sum, t) => sum + (t?.outputTokens ?? 0), 0),
      reasoning_tokens: totals.reduce((sum, t) => sum + (t?.reasoningTokens ?? 0), 0),
      cost: Math.round(cost * 1_000_000) / 1_000_000,
    });

    let result: RunResult;
    if (context.mode === "askx") {
      let object = (await stream.object.catch(() => undefined)) ?? commandsFromText(text);
      let commands: CommandsResult;
      try {
        commands = validateCommands(object);
        // Since plugin 6.16 the server checks the lines before they're final; what won't run goes back to the model once.
        const problems = context.tools.includes("search_commands") ? await uncheckable(deps.bridge, runId, commands.commands, signal) : [];
        if (problems.length) {
          askx = "rechecked";
          text = "";
          const again = (await agent.stream(
            [...messages, { role: "assistant", content: JSON.stringify(object) }, { role: "user", content: recheck(problems) }],
            { ...common, structuredOutput: { schema: commandsSchema } },
          )) as unknown as AgentStream;
          totals.push(await consume(again));
          object = (await again.object.catch(() => undefined)) ?? commandsFromText(text);
          commands = validateCommands(object);
        }
      } catch (error) {
        if (error instanceof ApiFailure && error.code === API_ERRORS.AI_ERROR.code) {
          telemetry.askx("refused");
          await record(context, deps, asked, [{ role: "assistant", content: `Refused: ${error.message.replace(/^AI returned an error: /, "")}` }]);
        }
        throw error;
      }
      await record(context, deps, asked, [{ role: "assistant", content: `Commands: ${commands.commands.join("; ")}` }]);
      telemetry.askx(askx);
      emit({ event: "commands", data: commands });
      result = { answer: "", commands, usage: usage(), durationMs: Date.now() - started };
    } else {
      const answer = text.trim();
      // A wake may end with wait or finish and no words; that's done, not a failure.
      if (!answer && context.mode !== "task") throw new ApiFailure(apierror(API_ERRORS.NO_AI_RESPONSE));
      // The tool calls and results go in too, so a later question can refer to what they found. Not in a
      // server's public thread: there they'd hand the asker's inventory and places to whoever asks next.
      const said = context.visibility === "public" ? (answer ? [{ role: "assistant" as const, content: answer }] : []) : exchange.messages();
      await record(context, deps, asked, answer ? said : [...said, { role: "assistant", content: TASK_WAITING }]);
      result = { answer, usage: usage(), durationMs: Date.now() - started };
    }
    const { usage: used } = result;
    emit({ event: "usage", data: used });
    emit({ event: "done", data: { answer: result.answer, duration_ms: result.durationMs } });
    logger.info(`Run ${runId} (${context.mode}/${context.platform}) done in ${result.durationMs} ms, ${used.output_tokens} tokens`);
    report(deps, context, options, {
      at: new Date(started),
      model: modelId,
      input_tokens: used.input_tokens,
      output_tokens: used.output_tokens,
      reasoning_tokens: used.reasoning_tokens,
      cost: used.cost,
      steps,
      tools: [...called.values()],
      searches: [...called.values()].filter((t) => t.name === "search_web").length,
      duration_ms: result.durationMs,
      result: "ok",
    });
    if (context.mode === "task") telemetry.wake(wakeEnd(called));
    telemetry.end({
      result: "ok",
      inputTokens: used.input_tokens,
      outputTokens: used.output_tokens,
      reasoningTokens: used.reasoning_tokens,
      cost: used.cost,
      steps,
      tools: [...called.values()],
      question: context.message,
      answer: result.commands ? JSON.stringify(result.commands) : result.answer,
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
    if (context.mode === "task") telemetry.wake(failure.code === API_ERRORS.CANCELLED.code ? "cancelled" : "error");
    if (APICallError.isInstance(error)) {
      event("allay.api_error", { "allay.run.id": runId, "allay.tenant": context.tenant, model: modelId, error_code: failure.code, ...(error.statusCode ? { status_code: error.statusCode } : {}) });
    }
    telemetry.end({
      result: failure.code === API_ERRORS.CANCELLED.code ? "cancelled" : "error",
      errorCode: failure.code,
      inputTokens: sofar.input_tokens,
      outputTokens: sofar.output_tokens,
      reasoningTokens: sofar.reasoning_tokens,
      cost: Math.round(cost * 1_000_000) / 1_000_000,
      steps,
      tools: [...called.values()],
      question: context.message,
    });
    emit({ event: "error", data: { code: failure.code, message: failure.message } });
    throw failure;
  }
};
