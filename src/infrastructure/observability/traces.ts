import mongoose from "mongoose";

/**
 * A step of a trace as the panel sees it: its shape and numbers only. Mastra's spans also hold the prompt,
 * the player's question, the answer, and every tool's arguments and result; none of that leaves MongoDB.
 */
export interface SpanView {
  span_id: string;
  parent_id: string | null;
  type: string;
  /** The tool's name for tool calls, the step's number for model steps. */
  label: string;
  started_at: string;
  ended_at: string | null;
  model?: string;
  provider?: string;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  finish_reason?: string;
  /** False when the span recorded an error or a tool reported failure. */
  ok: boolean;
}

export interface TraceSummary {
  trace_id: string;
  run_id: string | null;
  started_at: string;
  ended_at: string | null;
  ok: boolean;
}

export interface TraceStore {
  list(options: { before?: Date; limit: number }): Promise<TraceSummary[]>;
  /** The trace of a run, by its trace id or the run's id. */
  get(id: string): Promise<{ trace: TraceSummary; spans: SpanView[] } | null>;
}

interface RawSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  spanType: string;
  name?: string;
  entityName?: string;
  runId?: string | null;
  startedAt: Date;
  endedAt?: Date | null;
  attributes?: Record<string, unknown> | null;
  error?: unknown;
}

const SPANS = "mastra_ai_spans";

/** Only these fields are ever read from MongoDB; input, output, previews, and the prompt are not among them. */
const PROJECTION = {
  _id: 0,
  traceId: 1,
  spanId: 1,
  parentSpanId: 1,
  spanType: 1,
  entityName: 1,
  runId: 1,
  startedAt: 1,
  endedAt: 1,
  "attributes.model": 1,
  "attributes.provider": 1,
  "attributes.usage.inputTokens": 1,
  "attributes.usage.outputTokens": 1,
  "attributes.usage.outputDetails.reasoning": 1,
  "attributes.usage.inputDetails.cacheRead": 1,
  "attributes.finishReason": 1,
  "attributes.stepIndex": 1,
  "attributes.success": 1,
  // Whether there was an error, not what it said.
  "error.id": 1,
  "error.category": 1,
} as const;

const iso = (date?: Date | null) => (date ? new Date(date).toISOString() : null);

const number = (value: unknown) => (typeof value === "number" ? value : undefined);

export const spanView = (span: RawSpan): SpanView => {
  const a = (span.attributes ?? {}) as {
    model?: unknown;
    provider?: unknown;
    usage?: { inputTokens?: unknown; outputTokens?: unknown; outputDetails?: { reasoning?: unknown }; inputDetails?: { cacheRead?: unknown } };
    finishReason?: unknown;
    stepIndex?: unknown;
    success?: unknown;
  };
  const label =
    span.spanType === "tool_call" || span.spanType === "mcp_tool_call"
      ? String(span.entityName ?? "tool")
      : span.spanType === "model_step"
        ? `step ${number(a.stepIndex) ?? 0}`
        : span.spanType.replace(/_/g, " ");
  return {
    span_id: span.spanId,
    parent_id: span.parentSpanId ?? null,
    type: span.spanType,
    label,
    started_at: iso(span.startedAt)!,
    ended_at: iso(span.endedAt),
    ...(typeof a.model === "string" ? { model: a.model } : {}),
    ...(typeof a.provider === "string" ? { provider: a.provider } : {}),
    ...(number(a.usage?.inputTokens) !== undefined ? { input_tokens: number(a.usage?.inputTokens) } : {}),
    ...(number(a.usage?.outputTokens) !== undefined ? { output_tokens: number(a.usage?.outputTokens) } : {}),
    ...(number(a.usage?.outputDetails?.reasoning) !== undefined ? { reasoning_tokens: number(a.usage?.outputDetails?.reasoning) } : {}),
    ...(number(a.usage?.inputDetails?.cacheRead) !== undefined ? { cached_tokens: number(a.usage?.inputDetails?.cacheRead) } : {}),
    ...(typeof a.finishReason === "string" ? { finish_reason: a.finishReason } : {}),
    ok: !span.error && a.success !== false,
  };
};

const summaryOf = (root: RawSpan, spans?: RawSpan[]): TraceSummary => ({
  trace_id: root.traceId,
  run_id: root.runId ?? null,
  started_at: iso(root.startedAt)!,
  ended_at: iso(root.endedAt),
  ok: spans ? spans.every((s) => !s.error) : !root.error,
});

export const mongoTraces: TraceStore = {
  async list({ before, limit }) {
    const collection = mongoose.connection.db!.collection<RawSpan>(SPANS);
    const roots = await collection
      .find({ parentSpanId: null, ...(before ? { startedAt: { $lt: before } } : {}) }, { projection: PROJECTION })
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray();
    return roots.map((root) => summaryOf(root));
  },
  async get(id) {
    const collection = mongoose.connection.db!.collection<RawSpan>(SPANS);
    const spans = await collection.find({ $or: [{ traceId: id }, { runId: id }] }, { projection: PROJECTION }).sort({ startedAt: 1 }).limit(500).toArray();
    const root = spans.find((s) => !s.parentSpanId);
    if (!root) return null;
    const own = spans.filter((s) => s.traceId === root.traceId);
    return { trace: summaryOf(root, own), spans: own.map(spanView) };
  },
};

/** For tests: spans as Mastra would store them, read through the same filter. */
export const memoryTraces = (spans: RawSpan[] = []): TraceStore & { spans: RawSpan[] } => ({
  spans,
  async list({ before, limit }) {
    return spans
      .filter((s) => !s.parentSpanId && (!before || s.startedAt < before))
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit)
      .map((root) => summaryOf(root));
  },
  async get(id) {
    const own = spans.filter((s) => s.traceId === id || s.runId === id);
    const root = own.find((s) => !s.parentSpanId);
    if (!root) return null;
    const trace = spans.filter((s) => s.traceId === root.traceId).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    return { trace: summaryOf(root, trace), spans: trace.map(spanView) };
  },
});
