import { type Attributes, type Context, type Span, SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import { contentOf, event, modelLabel, signals } from "./signals";

/** Who and what a run is, as telemetry names it. The player only by pseudonym, and never in a metric. */
export interface RunInfo {
  runId: string;
  kind: string;
  payer: string;
  tenant: string;
  serverId?: string;
  /** The player's pseudonym (`p_…`). */
  player: string;
  platform: string;
  loader?: string;
  side?: string;
  visibility?: string;
  language?: string;
  taskKind?: string;
  model: string;
  /** `openrouter` on the backend's key, `byok` on a server's own. */
  provider: string;
}

/** What a step of the model reports when it ends. */
export interface StepUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  finishReason?: string;
  cost: number;
}

export interface RunEnd {
  result: "ok" | "cancelled" | "error";
  errorCode?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cost: number;
  steps: number;
  tools: Array<{ name: string; ok: boolean }>;
  /** The question and the answer, which go out only with OTEL_LOG_CONTENT on a self-hosted backend. */
  question?: string;
  answer?: string;
}

/** What the plugin says about a client tool's time in the game (plugin 6.24+). */
export interface PluginTiming {
  queued_ms?: number;
  run_ms?: number;
}

/** The model's tool call a client tool runs for: its id and the name the model called. */
export interface ModelCall {
  callId: string;
  tool: string;
}

const SERVER_TOOLS = new Set(["search_web", "exact_calculations", "memories"]);

/** Where a tool ran: the backend's own, another plugin's expansion, or the plugin's game tool. */
export const sideOf = (tool: string) => (SERVER_TOOLS.has(tool) ? "server" : tool.startsWith("x_") ? "expansion" : "client");

const seconds = (ms: number) => ms / 1000;

interface OpenTool {
  span: Span;
  name: string;
  started: number;
}

const open = new Map<string, RunTrace>();

/** The run's trace while it's in flight, for the tool bridge, which knows runs by id. */
export const runTraceOf = (runId: string) => open.get(runId);

/**
 * One run's spans, metrics, and events. The root span is `invoke_agent allay`, each model step a `chat` span under
 * it, each tool call an `execute_tool` span under its step, and each client tool's trip to the plugin under that.
 * Built from the model's stream as runAllay reads it, so nothing of Mastra's spans (prompts and all) is involved.
 */
export class RunTrace {
  private readonly startedAt = performance.now();
  private readonly root: Span;
  private readonly ctx: Context;
  private step?: { span: Span; started: number };
  private stepIndex = 0;
  private lastStepEnd: number;
  private readonly tools = new Map<string, OpenTool>();
  private firstAt?: number;
  private cached = 0;
  private ended = false;

  constructor(private readonly info: RunInfo) {
    this.lastStepEnd = this.startedAt;
    this.root = signals().tracer.startSpan(
      "invoke_agent allay",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": "allay",
          "gen_ai.provider.name": info.provider,
          "gen_ai.request.model": info.model,
          "allay.run.id": info.runId,
          "allay.run.kind": info.kind,
          "allay.payer": info.payer,
          "allay.tenant": info.tenant,
          "allay.player": info.player,
          "allay.platform": info.platform,
          ...(info.serverId ? { "allay.server.id": info.serverId } : {}),
          ...(info.loader ? { "allay.loader": info.loader } : {}),
          ...(info.side ? { "allay.side": info.side } : {}),
          ...(info.visibility ? { "allay.visibility": info.visibility } : {}),
          ...(info.language ? { "allay.language": info.language } : {}),
          ...(info.taskKind ? { "allay.task.kind": info.taskKind } : {}),
        },
      },
      context.active(),
    );
    this.ctx = trace.setSpan(context.active(), this.root);
    open.set(info.runId, this);
    signals().instruments.activeRuns.add(1, { payer: info.payer });
  }

  /** The labels every run metric carries: per server, and summed away for the whole picture. */
  get labels(): Attributes {
    const { info } = this;
    return {
      kind: info.kind,
      payer: info.payer,
      tenant: info.tenant,
      server_id: info.serverId ?? "",
      model: modelLabel(info.model, info.payer),
      platform: info.platform,
      loader: info.loader ?? "",
      side: info.side ?? "",
    };
  }

  get traceId() {
    return this.root.spanContext().traceId;
  }

  /** The model's id once the provider resolved it. */
  model(id: string) {
    this.info.model = id;
    this.root.setAttribute("gen_ai.request.model", id);
  }

  /** Runs [work] as a child span of the run, so its time shows next to the model's. */
  async phase<T>(name: string, work: () => Promise<T>): Promise<T> {
    const span = signals().tracer.startSpan(name, {}, this.ctx);
    try {
      return await context.with(trace.setSpan(this.ctx, span), work);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  }

  /** How full the session was before the run, as a share of its limit. */
  contextFill(share: number) {
    if (!(share >= 0)) return;
    signals().instruments.contextFill.record(Math.min(share, 1), this.labels);
    this.root.setAttribute("allay.context.fill", Math.round(share * 1000) / 1000);
  }

  /** The first text or reasoning the player sees. */
  firstWord() {
    if (this.firstAt !== undefined) return;
    this.firstAt = performance.now();
    signals().instruments.firstToken.record(seconds(this.firstAt - this.startedAt), this.labels);
    this.root.addEvent("first_token");
  }

  private currentStep() {
    if (!this.step) {
      this.stepIndex++;
      const span = signals().tracer.startSpan(
        `chat ${this.info.model}`,
        {
          kind: SpanKind.CLIENT,
          startTime: performance.timeOrigin + this.lastStepEnd,
          attributes: { "gen_ai.operation.name": "chat", "gen_ai.provider.name": this.info.provider, "gen_ai.request.model": this.info.model, "allay.step": this.stepIndex },
        },
        this.ctx,
      );
      this.step = { span, started: this.lastStepEnd };
    }
    return this.step;
  }

  stepFinished(usage: StepUsage) {
    const step = this.currentStep();
    const now = performance.now();
    const { instruments } = signals();
    const labels = this.labels;
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const reasoning = usage.reasoningTokens ?? 0;
    const cached = usage.cachedTokens ?? 0;
    this.cached += cached;
    step.span.setAttributes({
      "gen_ai.usage.input_tokens": input,
      "gen_ai.usage.output_tokens": output,
      "gen_ai.usage.reasoning.output_tokens": reasoning,
      "gen_ai.usage.cache_read.input_tokens": cached,
      ...(usage.finishReason ? { "gen_ai.response.finish_reasons": [usage.finishReason] } : {}),
      "allay.cost.usd": usage.cost,
    });
    step.span.end();
    this.step = undefined;
    this.lastStepEnd = now;

    const genAi = { "gen_ai.operation.name": "chat", "gen_ai.provider.name": this.info.provider, "gen_ai.request.model": modelLabel(this.info.model, this.info.payer), tenant: this.info.tenant };
    instruments.genAiDuration.record(seconds(now - step.started), genAi);
    instruments.genAiTokens.record(input, { ...genAi, "gen_ai.token.type": "input" });
    instruments.genAiTokens.record(output, { ...genAi, "gen_ai.token.type": "output" });
    instruments.tokens.add(input - cached, { ...labels, type: "input" });
    instruments.tokens.add(cached, { ...labels, type: "cache_read" });
    instruments.tokens.add(output - reasoning, { ...labels, type: "output" });
    instruments.tokens.add(reasoning, { ...labels, type: "reasoning" });
    this.cost("model", usage.cost);
    event("allay.api_request", {
      "allay.run.id": this.info.runId,
      "allay.tenant": this.info.tenant,
      "allay.step": this.stepIndex,
      model: this.info.model,
      input_tokens: input,
      output_tokens: output,
      reasoning_tokens: reasoning,
      cache_read_tokens: cached,
      cost_usd: usage.cost,
      duration_ms: Math.round(now - step.started),
      ...(usage.finishReason ? { finish_reason: usage.finishReason } : {}),
    });
  }

  /** Money spent by [source]: model steps, web searches, or a session's summary. */
  cost(source: "model" | "search" | "summary", usd: number) {
    if (usd > 0) signals().instruments.cost.add(usd, { ...this.labels, source });
  }

  /** The span of a tool call, made by whichever sees the call first: the stream, or the tool as it starts. */
  private tool(callId: string, name: string): OpenTool {
    let tool = this.tools.get(callId);
    if (!tool) {
      const parent = trace.setSpan(this.ctx, this.currentStep().span);
      const span = signals().tracer.startSpan(
        `execute_tool ${name}`,
        {
          attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name, "gen_ai.tool.call.id": callId, "gen_ai.tool.type": "function", "allay.tool.side": sideOf(name) },
        },
        parent,
      );
      tool = { span, name, started: performance.now() };
      this.tools.set(callId, tool);
    }
    return tool;
  }

  toolCalled(callId: string, name: string, args?: unknown) {
    const tool = this.tool(callId, name);
    const text = contentOf(args);
    if (text) tool.span.setAttribute("gen_ai.tool.call.arguments", text);
  }

  toolEnded(callId: string, ok: boolean, result?: unknown) {
    const tool = this.tools.get(callId);
    if (!tool) return;
    this.tools.delete(callId);
    const ms = performance.now() - tool.started;
    const size = result === undefined ? 0 : (JSON.stringify(result)?.length ?? 0);
    tool.span.setAttributes({ "allay.tool.ok": ok, "allay.tool.result_bytes": size });
    const text = contentOf(result);
    if (text) tool.span.setAttribute("gen_ai.tool.call.result", text);
    if (!ok) tool.span.setStatus({ code: SpanStatusCode.ERROR });
    tool.span.end();
    const labels = { ...this.labels, tool: tool.name, tool_side: sideOf(tool.name), ok: String(ok) };
    signals().instruments.toolCalls.add(1, labels);
    signals().instruments.toolDuration.record(seconds(ms), labels);
    event("allay.tool_result", {
      "allay.run.id": this.info.runId,
      "allay.tenant": this.info.tenant,
      tool: tool.name,
      tool_side: sideOf(tool.name),
      ok,
      duration_ms: Math.round(ms),
      result_bytes: size,
    });
  }

  /**
   * A client tool's trip to the plugin and back, under the model's tool call when the tool knows its id. A composite
   * tool (one the model calls, several the plugin runs) makes one trip each.
   */
  bridged(name: string, call?: ModelCall) {
    const parent = call ? this.tool(call.callId, call.tool).span : this.currentStep().span;
    const span = signals().tracer.startSpan(`plugin ${name}`, { kind: SpanKind.CLIENT, attributes: { "allay.plugin.tool": name } }, trace.setSpan(this.ctx, parent));
    return {
      timedOut: () => {
        span.setAttribute("error.type", "TOOL_TIMEOUT");
        signals().instruments.bridgeTimeouts.add(1, { ...this.labels, tool: name });
      },
      end: (ok: boolean, timing?: PluginTiming) => {
        const now = performance.now();
        if (timing?.run_ms !== undefined) {
          // The plugin's own time sits at the end of the trip: it answered as soon as the tool was done.
          const run = signals().tracer.startSpan(
            `game ${name}`,
            { startTime: performance.timeOrigin + now - timing.run_ms, attributes: { "allay.plugin.queued_ms": timing.queued_ms ?? 0 } },
            trace.setSpan(this.ctx, span),
          );
          run.end(performance.timeOrigin + now);
          signals().instruments.pluginRun.record(seconds(timing.run_ms), { tenant: this.info.tenant, server_id: this.info.serverId ?? "", tool: name, loader: this.info.loader ?? "" });
        }
        if (timing?.queued_ms !== undefined) {
          signals().instruments.pluginQueue.record(seconds(timing.queued_ms), { tenant: this.info.tenant, server_id: this.info.serverId ?? "", tool: name, loader: this.info.loader ?? "" });
        }
        if (!ok) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      },
    };
  }

  /** An askx result: accepted at once, after a recheck, or refused. */
  askx(result: "accepted" | "rechecked" | "refused") {
    signals().instruments.askxCommands.add(1, { ...this.labels, result });
    this.root.setAttribute("allay.askx.result", result);
  }

  /** How an automation agent's wake ended. */
  wake(end: string) {
    signals().instruments.taskWakes.add(1, { ...this.labels, task_kind: this.info.taskKind ?? "", end });
    this.root.setAttribute("allay.task.end", end);
  }

  /** Forgets a run that turned out to be nothing (a summary with nothing to fold): a span never ended is never sent. */
  discard() {
    if (this.ended) return;
    this.ended = true;
    open.delete(this.info.runId);
    signals().instruments.activeRuns.add(-1, { payer: this.info.payer });
  }

  end(run: RunEnd) {
    if (this.ended) return;
    this.ended = true;
    open.delete(this.info.runId);
    // A step or a tool the stream never finished (a failure, a cancel) ends with the run.
    for (const tool of this.tools.values()) tool.span.end();
    this.step?.span.end();
    const ms = performance.now() - this.startedAt;
    const { instruments } = signals();
    const labels = this.labels;
    instruments.activeRuns.add(-1, { payer: this.info.payer });
    instruments.runs.add(1, { ...labels, result: run.result, error_code: run.errorCode ?? "", language: this.info.language ?? "" });
    instruments.runDuration.record(seconds(ms), { ...labels, result: run.result });
    instruments.runSteps.record(run.steps, labels);
    instruments.runTools.record(run.tools.length, labels);

    const question = contentOf(run.question);
    const answer = contentOf(run.answer);
    this.root.setAttributes({
      "gen_ai.response.model": this.info.model,
      "gen_ai.usage.input_tokens": run.inputTokens,
      "gen_ai.usage.output_tokens": run.outputTokens,
      "gen_ai.usage.reasoning.output_tokens": run.reasoningTokens,
      "allay.cost.usd": run.cost,
      "allay.steps": run.steps,
      "allay.result": run.result,
      ...(run.errorCode ? { "error.type": run.errorCode } : {}),
      ...(question ? { "allay.question": question } : {}),
      ...(answer ? { "allay.answer": answer } : {}),
    });
    if (run.result === "error") this.root.setStatus({ code: SpanStatusCode.ERROR, message: run.errorCode });
    this.root.end();
    event("allay.run.finished", {
      "allay.run.id": this.info.runId,
      "allay.tenant": this.info.tenant,
      "allay.player": this.info.player,
      ...(this.info.serverId ? { "allay.server.id": this.info.serverId } : {}),
      kind: this.info.kind,
      payer: this.info.payer,
      model: this.info.model,
      platform: this.info.platform,
      ...(this.info.loader ? { loader: this.info.loader } : {}),
      ...(this.info.side ? { side: this.info.side } : {}),
      ...(this.info.language ? { language: this.info.language } : {}),
      result: run.result,
      ...(run.errorCode ? { error_code: run.errorCode } : {}),
      duration_ms: Math.round(ms),
      ...(this.firstAt !== undefined ? { first_token_ms: Math.round(this.firstAt - this.startedAt) } : {}),
      input_tokens: run.inputTokens,
      output_tokens: run.outputTokens,
      reasoning_tokens: run.reasoningTokens,
      cache_read_tokens: this.cached,
      cost_usd: run.cost,
      steps: run.steps,
      tools: run.tools.length,
      failed_tools: run.tools.filter((t) => !t.ok).length,
      ...(question ? { question } : {}),
      ...(answer ? { answer } : {}),
    });
  }
}
