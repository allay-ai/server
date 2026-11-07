import { Mastra } from "@mastra/core";
import { SamplingStrategyType, SpanType } from "@mastra/core/observability";
import { MongoDBStore } from "@mastra/mongodb";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { settings } from "../../features/settings/settings";
import { logger } from "../../shared/logging/logger";
import { sealSpan } from "./sealing";

const PRUNE_EVERY_MS = 60 * 60 * 1000;

/**
 * Traces of runs in MongoDB, next to the backend's own data: each model step with its prompt, output,
 * and tokens, and each tool call with its arguments and result, all of it sealed with the players' data key
 * (sealing.ts). An owner opens one run in the panel to look into a problem; every look is in the audit log.
 * The agent is built per run, so each run registers with this instance.
 */
export const tracing = (uri: string, dbName: string): Mastra | undefined => {
  // About 150 KB to 1 MB a run, by how long the session is.
  const sample = settings.get("TRACE_SAMPLE");
  // Long enough to look into a complaint and see a month's patterns, short enough that questions don't pile up.
  const days = settings.get("TRACE_DAYS");
  if (!(sample > 0)) return undefined;
  const storage = new MongoDBStore({ id: "allay", uri, dbName, retention: { observability: { spans: { maxAge: `${days}d` } } } });
  const mastra = new Mastra({
    storage,
    logger: false,
    observability: new Observability({
      configs: {
        allay: {
          serviceName: "allay-server",
          sampling: sample >= 1 ? { type: SamplingStrategyType.ALWAYS } : { type: SamplingStrategyType.RATIO, probability: sample },
          // Sealed before they're written: a dump or a backup of the database reads no prompt and no answer.
          exporters: [new MastraStorageExporter({ customSpanFormatter: (span) => sealSpan(span as unknown as Record<string, unknown>) as unknown as typeof span })],
          // Mastra's own processors and the raw provider calls repeat each step's whole prompt: two thirds of the bytes, nothing new.
          excludeSpanTypes: [SpanType.PROCESSOR_RUN, SpanType.MODEL_INFERENCE, SpanType.MODEL_CHUNK],
          // The system prompt is in the code; a step's own messages and results fit. Mastra keeps the first 50 items of an
          // array and 8 levels by default, which cut a long session before the question it answered and nested tool results.
          serializationOptions: { maxStringLength: 32_000, maxArrayLength: 1_000, maxDepth: 24, maxObjectKeys: 200 },
          // tslog already writes the backend's logs; traces are for runs.
          logging: { enabled: false },
        },
      },
    }),
  });
  // Retention only marks what's old; nothing goes until prune runs.
  const prune = () => storage.prune().catch((error) => logger.warn(`Couldn't prune old traces: ${String(error)}`));
  setInterval(prune, PRUNE_EVERY_MS).unref();
  void prune();
  logger.info(`Tracing ${sample >= 1 ? "every run" : `${Math.round(sample * 100)}% of runs`} to MongoDB for ${days} days`);
  return mastra;
};
