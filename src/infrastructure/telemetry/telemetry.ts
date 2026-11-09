import { context, logs, metrics, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { type MetricReader, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { logger } from "../../shared/logging/logger";
import { useSignals } from "./signals";

type Env = Record<string, string | undefined>;

/** Which exporter a signal gets: the OTEL_*_EXPORTER variable, else OTLP when an endpoint is set, else none. */
const exporterOf = (env: Env, signal: "TRACES" | "METRICS" | "LOGS"): string => {
  const named = env[`OTEL_${signal}_EXPORTER`]?.trim().toLowerCase();
  if (named) return named.split(",")[0].trim();
  return env.OTEL_EXPORTER_OTLP_ENDPOINT || env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`] ? "otlp" : "none";
};

export interface TelemetryOptions {
  version: string;
  /** A server's own backend; only there may texts go out with OTEL_LOG_CONTENT. */
  selfHosted: boolean;
  env?: Env;
}

export interface Telemetry {
  traces: boolean;
  metrics: boolean;
  logs: boolean;
  /** Sends what's left, then stops; for a graceful shutdown. */
  shutdown(): Promise<void>;
}

/**
 * OpenTelemetry from the standard OTEL_* variables: traces, metrics, and events (log records) over OTLP
 * (http/protobuf), or metrics for a Prometheus scrape. Nothing is set, nothing is sent: the API stays a no-op.
 * The exporters read the endpoint, headers, timeout, and temporality from the environment themselves.
 */
export const startTelemetry = (options: TelemetryOptions): Telemetry => {
  const env = options.env ?? process.env;
  const off: Telemetry = { traces: false, metrics: false, logs: false, shutdown: async () => {} };
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return off;
  const traces = exporterOf(env, "TRACES");
  const meters = exporterOf(env, "METRICS");
  const events = exporterOf(env, "LOGS");
  if (traces === "none" && meters === "none" && events === "none") return off;

  // OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES win over these.
  const resource = resourceFromAttributes({
    "service.name": "allay-server",
    "service.version": options.version,
    "service.instance.id": crypto.randomUUID(),
    "deployment.environment.name": options.selfHosted ? "self-hosted" : "hosted",
  }).merge(detectResources({ detectors: [envDetector] }));

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const stops: Array<() => Promise<void>> = [];

  let tracerProvider: TracerProvider | undefined;
  if (traces === "otlp") {
    // The sampler comes from OTEL_TRACES_SAMPLER and its argument; parent-based, always on by default.
    tracerProvider = new TracerProvider({ resource, spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })] });
    trace.setGlobalTracerProvider(tracerProvider);
    stops.push(() => tracerProvider!.shutdown());
  } else if (traces !== "none") logger.warn(`OTEL_TRACES_EXPORTER=${traces} isn't supported; traces stay off (otlp or none)`);

  let meterProvider: MeterProvider | undefined;
  const reader: MetricReader | undefined =
    meters === "otlp"
      ? new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: Number(env.OTEL_METRIC_EXPORT_INTERVAL) || 60_000 })
      : meters === "prometheus"
        ? new PrometheusExporter({ host: env.OTEL_EXPORTER_PROMETHEUS_HOST || "0.0.0.0", port: Number(env.OTEL_EXPORTER_PROMETHEUS_PORT) || 9464 })
        : undefined;
  if (reader) {
    meterProvider = new MeterProvider({ resource, readers: [reader] });
    metrics.setGlobalMeterProvider(meterProvider);
    stops.push(() => meterProvider!.shutdown());
  } else if (meters !== "none") logger.warn(`OTEL_METRICS_EXPORTER=${meters} isn't supported; metrics stay off (otlp, prometheus, or none)`);

  let loggerProvider: LoggerProvider | undefined;
  if (events === "otlp") {
    loggerProvider = new LoggerProvider({ resource, processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })] });
    logs.setGlobalLoggerProvider(loggerProvider);
    stops.push(() => loggerProvider!.shutdown());
  } else if (events !== "none") logger.warn(`OTEL_LOGS_EXPORTER=${events} isn't supported; events stay off (otlp or none)`);

  const wantsContent = env.OTEL_LOG_CONTENT?.trim() === "1";
  // allay.chat's players agreed to sealed texts that only an owner opens, with a reason, in the audit log.
  if (wantsContent && !options.selfHosted) logger.warn("OTEL_LOG_CONTENT is for self-hosted backends; texts stay out of telemetry here");
  useSignals({ tracerProvider, meterProvider, loggerProvider, version: options.version, content: wantsContent && options.selfHosted });

  const on = { traces: !!tracerProvider, metrics: !!meterProvider, logs: !!loggerProvider };
  logger.info(`OpenTelemetry: traces ${on.traces ? "on" : "off"}, metrics ${on.metrics ? (meters === "prometheus" ? "on a Prometheus scrape" : "on") : "off"}, events ${on.logs ? "on" : "off"}`);
  return {
    ...on,
    shutdown: async () => {
      await Promise.all(stops.map((stop) => stop().catch((error) => logger.warn(`Couldn't flush telemetry: ${String(error)}`))));
    },
  };
};
