import { logger } from "../../shared/logging/logger";
import { settings } from "../settings/settings";
import type { Emit } from "./chat.events";

export type ToolAnswer = { ok: true; result: unknown } | { ok: false; error: string };

interface PendingCall {
  settle: (answer: ToolAnswer) => void;
  answered: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface Run {
  emit: Emit;
  /** Whose run it is: only that tenant may answer its tool calls. */
  tenant: string;
  calls: Map<string, PendingCall>;
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
    this.runs.set(runId, { emit, tenant, calls: new Map() });
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

  /** Asks the plugin to run a tool; resolves with its answer, or a failure after the timeout. */
  call(runId: string, name: string, args: unknown, signal?: AbortSignal): Promise<ToolAnswer> {
    const run = this.runs.get(runId);
    if (!run) return Promise.resolve({ ok: false, error: "The run is over" });
    const callId = crypto.randomUUID();
    const timeoutMs = this.fixedTimeoutMs ?? settings.get("TOOL_TIMEOUT_MS");
    return new Promise<ToolAnswer>((resolve) => {
      const call: PendingCall = {
        answered: false,
        settle: (answer) => {
          if (call.answered) return;
          call.answered = true;
          clearTimeout(call.timer);
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
      call.timer = setTimeout(() => {
        logger.warn(`Tool ${name} timed out in run ${runId}`);
        call.settle({ ok: false, error: `TOOL_TIMEOUT: the game didn't answer within ${timeoutMs / 1000} s` });
      }, timeoutMs);
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
