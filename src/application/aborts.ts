import { logger } from "../shared/logging/logger";

/** An abort's error, as fetch, the AI SDK, and Mastra raise it. */
export const isAbort = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";

/**
 * A run the client dropped can leave an aborted call nobody awaits, inside the model's stream: two questions of one
 * player cancelled at once did that, and the process died with every other run in it. An abort only ends its own run,
 * so it's logged and let go; anything else still stops the process, as it did before.
 */
export const survive = (reason: unknown, kind: string) => {
  if (isAbort(reason)) {
    logger.warn(`An aborted call ended with nobody waiting for it (${kind})`);
    return;
  }
  logger.error(`${kind}:`, reason);
  process.exit(1);
};

export const guardAborts = () => {
  process.on("unhandledRejection", (reason) => survive(reason, "Unhandled rejection"));
  process.on("uncaughtException", (error) => survive(error, "Uncaught exception"));
};
