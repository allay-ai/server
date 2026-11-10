import { type ModelCall, type PluginTiming, runTraceOf } from "../../infrastructure/telemetry/run";
import { logger } from "../../shared/logging/logger";
import { settings } from "../settings/settings";
import type { Emit } from "./chat.events";

/** Since 6.24 the plugin may add how long the tool waited for the server thread and ran there. */
export type ToolAnswer = ({ ok: true; result: unknown } | { ok: false; error: string }) & { timing?: PluginTiming };

interface PendingCall {
  settle: (answer: ToolAnswer) => void;
  answered: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** Starts the call's clock, again in full after the plugin came back. */
  arm: () => void;
}

interface Run {
  emit: Emit;
  /** Whose run it is: only that tenant may answer its tool calls. */
  tenant: string;
  calls: Map<string, PendingCall>;
  /** The plugin's connection dropped: calls wait for it to come back instead of timing out meanwhile. */
  held: boolean;
}

/**
 * Hands client tool calls to the plugin and waits for its answers. A run's tool calls go out as
 * `tool_call` events on its stream; the plugin posts results to /api/v2/chat/{run}/tools/{call}.
 *
 * State lives in this process, so this assumes one backend instance. With several, the result
 * POST must reach the instance that holds the stream (sticky routing, or a shared bus instead).
 */
export class ToolBridge {
  private readonly runs = new Map<string, Run>();

  /** Without a fixed timeout, each call reads TOOL_TIMEOUT_MS as it starts. */
  constructor(private readonly fixedTimeoutMs?: number) {}

  open(runId: string, emit: Emit, tenant: string): void {
    this.runs.set(runId, { emit, tenant, calls: new Map(), held: false });
  }

  /** The plugin went away mid-run: its calls' clocks stop until [release]. */
  hold(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.held = true;
    for (const call of run.calls.values()) clearTimeout(call.timer);
  }

  /** The plugin is back: every call still unanswered gets its whole timeout again, since it may have missed the call. */
  release(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.held = false;
    for (const call of run.calls.values()) if (!call.answered) call.arm();
  }

  /** Ends a run: pending calls resolve as failed and later results get 404. */
  close(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.delete(runId);
    for (const call of run.calls.values()) {
      if (!call.answered) call.settle({ ok: false, error: "The run is over" });
    }
  }

  get active(): number {
    return this.runs.size;
  }

  /**
   * Asks the plugin to run a tool; resolves with its answer, or a failure after the timeout. [model] is the model's
   * tool call it runs for, so the trip shows under that call in the run's trace.
   */
  call(runId: string, name: string, args: unknown, signal?: AbortSignal, model?: ModelCall): Promise<ToolAnswer> {
    const run = this.runs.get(runId);
    if (!run) return Promise.resolve({ ok: false, error: "The run is over" });
    const callId = crypto.randomUUID();
    const timeoutMs = this.fixedTimeoutMs ?? settings.get("TOOL_TIMEOUT_MS");
    const trip = runTraceOf(runId)?.bridged(name, model);
    return new Promise<ToolAnswer>((resolve) => {
      const call: PendingCall = {
        answered: false,
        arm: () => {
          clearTimeout(call.timer);
          call.timer = setTimeout(() => {
            logger.warn(`Tool ${name} timed out in run ${runId}`);
            trip?.timedOut();
            call.settle({ ok: false, error: `TOOL_TIMEOUT: the game didn't answer within ${timeoutMs / 1000} s` });
          }, timeoutMs);
        },
        settle: (answer) => {
          if (call.answered) return;
          call.answered = true;
          clearTimeout(call.timer);
          trip?.end(answer.ok, answer.timing);
          run.emit({
            event: "tool_status",
            data: {
              call_id: callId,
              name,
              kind: "client",
              state: answer.ok ? "finished" : "failed",
              ...(answer.ok ? {} : { summary: answer.error }),
            },
          });
          resolve(answer);
        },
      };
      if (!run.held) call.arm();
      signal?.addEventListener("abort", () => call.settle({ ok: false, error: "Cancelled" }), { once: true });
      run.calls.set(callId, call);
      run.emit({ event: "tool_status", data: { call_id: callId, name, kind: "client", state: "started", args } });
      run.emit({ event: "tool_call", data: { call_id: callId, name, args } });
    });
  }

  /** A result from the plugin: 200 when it was waited for, 404 when unknown or another tenant's, 409 when already answered. */
  answer(runId: string, callId: string, tenant: string, answer: ToolAnswer): 200 | 404 | 409 {
    const run = this.runs.get(runId);
    if (!run || run.tenant !== tenant) return 404;
    const call = run.calls.get(callId);
    if (!call) return 404;
    if (call.answered) return 409;
    call.settle(answer);
    return 200;
  }
}

export const bridge = new ToolBridge();
