import {
  type Attributes,
  type Logger,
  type LoggerProvider,
  type Meter,
  type MeterProvider,
  SeverityNumber,
  type Tracer,
  type TracerProvider,
  logs,
  metrics,
  trace,
} from "@opentelemetry/api";

const SCOPE = "allay-server";

/** Seconds; the panel's DURATION_BUCKETS, so Grafana's percentiles match the panel's. */
const RUN_SECONDS = [0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12.5, 15, 20, 25, 30, 40, 50, 60, 90, 120, 180, 300];
/** The GenAI semantic conventions' advised buckets. */
const GEN_AI_SECONDS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92];
const GEN_AI_TOKENS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576];
const HTTP_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];
const TOOL_SECONDS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 15, 30, 60];
const DB_SECONDS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

const instrumentsOf = (meter: Meter) => ({
  runs: meter.createCounter("allay.runs", { unit: "{run}", description: "Runs: questions, askx requests, agents' wakes, and session summaries" }),
  runDuration: meter.createHistogram("allay.run.duration", { unit: "s", description: "How long a run took, start to done", advice: { explicitBucketBoundaries: RUN_SECONDS } }),
  firstToken: meter.createHistogram("allay.run.first_token", { unit: "s", description: "From the start of a run to the first word or reasoning the player sees", advice: { explicitBucketBoundaries: RUN_SECONDS } }),
  runSteps: meter.createHistogram("allay.run.steps", { unit: "{step}", description: "Model steps in a run", advice: { explicitBucketBoundaries: [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 30] } }),
  runTools: meter.createHistogram("allay.run.tools", { unit: "{call}", description: "Tool calls in a run", advice: { explicitBucketBoundaries: [0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32] } }),
  contextFill: meter.createHistogram("allay.context.fill", { unit: "1", description: "How full the session is before a run, as a share of its token limit", advice: { explicitBucketBoundaries: [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] } }),
  tokens: meter.createCounter("allay.token.usage", { unit: "{token}", description: "Tokens read and written, by type" }),
  cost: meter.createCounter("allay.cost.usage", { unit: "{USD}", description: "What runs cost, by source: model steps, web searches, session summaries" }),
  genAiTokens: meter.createHistogram("gen_ai.client.token.usage", { unit: "{token}", description: "Tokens per model call", advice: { explicitBucketBoundaries: GEN_AI_TOKENS } }),
  genAiDuration: meter.createHistogram("gen_ai.client.operation.duration", { unit: "s", description: "How long a model step took", advice: { explicitBucketBoundaries: GEN_AI_SECONDS } }),
  toolCalls: meter.createCounter("allay.tool.calls", { unit: "{call}", description: "Tool calls, by tool, where it ran, and whether it worked" }),
  toolDuration: meter.createHistogram("allay.tool.duration", { unit: "s", description: "How long a tool call took, as the model waited for it", advice: { explicitBucketBoundaries: TOOL_SECONDS } }),
  pluginQueue: meter.createHistogram("allay.plugin.tool.queue", { unit: "s", description: "How long a client tool waited for the server thread, as the plugin reports", advice: { explicitBucketBoundaries: TOOL_SECONDS } }),
  pluginRun: meter.createHistogram("allay.plugin.tool.run", { unit: "s", description: "How long a client tool ran in the game, as the plugin reports", advice: { explicitBucketBoundaries: TOOL_SECONDS } }),
  bridgeTimeouts: meter.createCounter("allay.bridge.timeouts", { unit: "{call}", description: "Client tools the game didn't answer in TOOL_TIMEOUT_MS" }),
  activeRuns: meter.createUpDownCounter("allay.runs.active", { unit: "{run}", description: "Runs in flight" }),
  streams: meter.createUpDownCounter("allay.sse.streams", { unit: "{stream}", description: "Open event streams to plugins" }),
  refusals: meter.createCounter("allay.gate.refusals", { unit: "{request}", description: "Questions refused before they ran, by code" }),
  searches: meter.createCounter("allay.search.count", { unit: "{search}", description: "Web searches, by provider" }),
  askxCommands: meter.createCounter("allay.askx.commands", { unit: "{request}", description: "askx results: accepted at once, accepted after a recheck, refused" }),
  taskWakes: meter.createCounter("allay.task.wakes", { unit: "{wake}", description: "Automation agents' wakes, by how they ended" }),
  payments: meter.createCounter("allay.payments", { unit: "{payment}", description: "Telegram Stars payments and refunds" }),
  stars: meter.createCounter("allay.payments.stars", { unit: "{star}", description: "Stars paid and refunded, by kind" }),
  privacy: meter.createCounter("allay.privacy.requests", { unit: "{request}", description: "Consents given and withdrawn, exports, and erasures" }),
  http: meter.createHistogram("http.server.request.duration", { unit: "s", description: "HTTP requests, to the answer's first byte", advice: { explicitBucketBoundaries: HTTP_SECONDS } }),
  db: meter.createHistogram("db.client.operation.duration", { unit: "s", description: "MongoDB commands", advice: { explicitBucketBoundaries: DB_SECONDS } }),
});

export type Instruments = ReturnType<typeof instrumentsOf>;

interface Signals {
  tracer: Tracer;
  meter: Meter;
  instruments: Instruments;
  events: Logger;
  /** Texts (questions, answers, tool data) may go out: OTEL_LOG_CONTENT on a self-hosted backend only. */
  content: boolean;
}

const build = (providers: { tracerProvider?: TracerProvider; meterProvider?: MeterProvider; loggerProvider?: LoggerProvider; version?: string; content?: boolean }): Signals => {
  const meter = (providers.meterProvider ?? metrics).getMeter(SCOPE, providers.version);
  return {
    tracer: (providers.tracerProvider ?? trace).getTracer(SCOPE, providers.version),
    meter,
    instruments: instrumentsOf(meter),
    events: (providers.loggerProvider ?? logs).getLogger(SCOPE, providers.version),
    content: providers.content ?? false,
  };
};

// The API's no-op until startTelemetry (or a test) hands in real providers.
let current = build({});
const watchers: Array<(meter: Meter) => void> = [];

/** Points every signal at these providers; the instruments are made again on their meter. */
export const useSignals = (providers: Parameters<typeof build>[0]) => {
  current = build(providers);
  for (const watch of watchers) watch(current.meter);
};

export const signals = (): Signals => current;

/** Observable gauges register on each new meter: they're callbacks, not calls a run makes. */
export const onMeter = (register: (meter: Meter) => void) => {
  watchers.push(register);
  register(current.meter);
};

/** An event as a log record: `event.name` and its attributes, never a word of what was asked or answered unless content is on. */
export const event = (name: string, attributes: Attributes) => {
  current.events.emit({ eventName: name, severityNumber: SeverityNumber.INFO, severityText: "INFO", attributes: { "event.name": name, ...attributes } });
};

/** BYOK models are whatever the server typed; one label keeps them from filling Prometheus. */
export const modelLabel = (model: string, payer: string | undefined) => (payer === "byok" ? "byok" : model);

/** Up to this many characters of a text, when content may go out at all. */
export const contentOf = (value: unknown, max = 8_000): string | undefined => {
  if (!current.content || value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** Consents given and withdrawn, exports, and erasures, per tenant; the player stays out. */
export const privacyRequest = (kind: "consent_given" | "consent_withdrawn" | "export" | "erasure", tenant: string) => {
  current.instruments.privacy.add(1, { kind, tenant });
  event("allay.privacy.request", { kind, "allay.tenant": tenant });
};

/** A payment, a renewal, or a refund in the bot; a refund's Stars count under its kind, so paid minus refunded is one query. */
export const paymentMade = (tenant: string, plan: string, stars: number, kind: "payment" | "renewal" | "refund") => {
  current.instruments.payments.add(1, { tenant, plan, kind });
  current.instruments.stars.add(stars, { tenant, plan, kind });
  event("allay.payment", { kind, plan, stars, "allay.tenant": tenant });
};
