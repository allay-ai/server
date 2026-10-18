import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { forModel } from "./schema";
import { logger } from "../../shared/logging/logger";
import { type Emit, type Summary, summaryFields } from "../chat/chat.events";
import { settings } from "../settings/settings";

export const MAX_EXPRESSIONS = 10;
export const MAX_EXPRESSION_CHARS = 300;
// Worker startup loads math.js; that doesn't count against an expression's second.
const STARTUP_MS = 10_000;

export type Calculation = { expression: string; result: string } | { expression: string; error: string };

// Run from source the worker is a .ts file next to this one; in the bundle it's built next to the entrypoint.
// A computed name keeps the bundler from rewriting the path.
const workerUrl = () => new URL(`./calc.worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url);

const startWorker = (): Promise<Worker> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl());
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("the calculator didn't start"));
    }, STARTUP_MS);
    worker.onmessage = (event) => {
      if (event.data?.ready) {
        clearTimeout(timer);
        resolve(worker);
      }
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(event.message));
    };
  });

/**
 * Evaluates each expression in a worker that gets terminated when one runs past its time,
 * so `factorial(10^9)` costs one second, not the server.
 */
export const calculateAll = async (expressions: string[], timeoutMs = settings.get("CALC_TIMEOUT_MS")): Promise<Calculation[]> => {
  const results: Calculation[] = [];
  let worker: Worker | undefined;
  try {
    for (const [id, expression] of expressions.entries()) {
      worker ??= await startWorker();
      const current = worker;
      const answer = await new Promise<{ result?: string; error?: string }>((resolve) => {
        const timer = setTimeout(() => {
          current.terminate();
          worker = undefined;
          resolve({ error: `took longer than ${timeoutMs / 1000} s` });
        }, timeoutMs);
        current.onmessage = (event) => {
          if (event.data?.id !== id) return;
          clearTimeout(timer);
          resolve(event.data);
        };
        current.postMessage({ id, expression });
      });
      results.push(answer.error !== undefined ? { expression, error: answer.error } : { expression, result: answer.result ?? "" });
    }
  } finally {
    worker?.terminate();
  }
  return results;
};

/** Exact math for the agent: totals, stacks, coordinates, rates. Models guess at arithmetic; this doesn't. */
export const exactCalculationsTool = (options: { emit: Emit }) =>
  createTool({
    id: "exact_calculations",
    description:
      "Evaluates math expressions exactly (math.js syntax, 64 significant digits). Use it for any arithmetic that isn't trivial: stacks and totals (ceil(1000 / 64)), Nether coordinates (-1024 / 8), XP, farm rates, durability, percentages, unit conversions (3 hours to seconds). Up to 10 expressions per call; each returns a result or an error.",
    inputSchema: forModel(
      z.object({
        expressions: z.array(z.string().min(1).max(MAX_EXPRESSION_CHARS)).min(1).max(MAX_EXPRESSIONS),
      }),
    ),
    strict: false,
    execute: async ({ expressions }) => {
      const callId = crypto.randomUUID();
      const status = (state: "started" | "finished" | "failed", summary?: Summary) =>
        options.emit({
          event: "tool_status",
          data: { call_id: callId, name: "exact_calculations", kind: "server", state, args: { expressions }, ...summaryFields(summary) },
        });
      status("started");
      try {
        const results = await calculateAll(expressions);
        const failed = results.filter((r) => "error" in r).length;
        const first = results[0];
        // A single result reads the same in every language; a batch gets a key the plugin translates.
        status(
          "finished",
          results.length === 1 && "result" in first
            ? { text: `= ${first.result}`.slice(0, 80) }
            : { text: `${results.length - failed} of ${results.length} computed`, key: "computed", values: { done: results.length - failed, total: results.length } },
        );
        return { results };
      } catch (error) {
        logger.warn(`Calculation failed: ${String(error)}`);
        status("failed", { text: "calculator unavailable", key: "calculator_unavailable" });
        return { error: "The calculator is unavailable right now; say you couldn't compute it exactly." };
      }
    },
  });
