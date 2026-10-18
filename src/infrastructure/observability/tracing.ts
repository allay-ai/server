import { Mastra } from "@mastra/core";
import { SamplingStrategyType, SpanType } from "@mastra/core/observability";
import { MongoDBStore } from "@mastra/mongodb";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { settings } from "../../features/settings/settings";
import { logger } from "../../shared/logging/logger";

const PRUNE_EVERY_MS = 60 * 60 * 1000;

/**
 * Traces of runs in MongoDB, next to the backend's own data: each model step with its prompt, output,
 * and tokens, and each tool call with its arguments and result. Mastra Studio reads them.
 * The agent is built per run, so each run registers with this instance.
 */
export const tracing = (uri: string, dbName: string): Mastra | undefined => {
  // About 150 KB a run: every run on a self-hosted backend, a tenth on the hosted one, where thousands pass a day.
  const sample = settings.get("TRACE_SAMPLE");
  // Long enough to look into a complaint, short enough that players' questions don't pile up.
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
          exporters: [new MastraStorageExporter()],
          // Mastra's own processors and the raw provider calls repeat each step's whole prompt: two thirds of the bytes, nothing new.
          excludeSpanTypes: [SpanType.PROCESSOR_RUN, SpanType.MODEL_INFERENCE, SpanType.MODEL_CHUNK],
          // The system prompt is in the code; a step's own messages and results fit.
          serializationOptions: { maxStringLength: 8_000 },
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
