import type { AssistantContent, ModelMessage, ToolCallPart, ToolResultPart } from "ai";

/**
 * The session keeps tool results whole, as the model saw them, so a later question has the full picture
 * (“how many were in that chest?”). Game tools trim theirs to 12 000 characters already; this only bounds the rest.
 */
export const STORED_RESULT_CHARS = 16_000;

const output = (result: unknown): ToolResultPart["output"] => {
  const text = JSON.stringify(result) ?? "null";
  if (text.length <= STORED_RESULT_CHARS) return { type: "json", value: JSON.parse(text) };
  return { type: "json", value: { truncated: true, json: `${text.slice(0, STORED_RESULT_CHARS)}…` } };
};

interface Step {
  text: string;
  calls: ToolCallPart[];
}

/** Collects a run's stream into the messages its thread keeps: each step's words and tool calls, then their results. */
export class Exchange {
  private readonly steps: Step[] = [];
  private step: Step = { text: "", calls: [] };
  private readonly results = new Map<string, ToolResultPart>();

  text(delta: string) {
    this.step.text += delta;
  }

  call(payload: Record<string, unknown>) {
    const { __mastraMetadata: _, ...input } = (payload.args ?? {}) as Record<string, unknown>;
    this.step.calls.push({ type: "tool-call", toolCallId: String(payload.toolCallId), toolName: String(payload.toolName), input });
  }

  result(payload: Record<string, unknown>) {
    const id = String(payload.toolCallId);
    this.results.set(id, { type: "tool-result", toolCallId: id, toolName: String(payload.toolName), output: output(payload.result) });
  }

  error(payload: Record<string, unknown>) {
    const id = String(payload.toolCallId);
    const error = payload.error instanceof Error ? payload.error.message : String(payload.error);
    this.results.set(id, { type: "tool-result", toolCallId: id, toolName: String(payload.toolName), output: { type: "error-text", value: error.slice(0, 500) } });
  }

  endStep() {
    if (this.step.text || this.step.calls.length) this.steps.push(this.step);
    this.step = { text: "", calls: [] };
  }

  /** Every call gets a result, as providers demand: one that never came reads as such. */
  messages(): ModelMessage[] {
    this.endStep();
    return this.steps.flatMap((step): ModelMessage[] => {
      const words = step.text.trim();
      if (step.calls.length === 0) return words ? [{ role: "assistant", content: words }] : [];
      const content: AssistantContent = [...(words ? [{ type: "text" as const, text: words }] : []), ...step.calls];
      const results = step.calls.map(
        (call) => this.results.get(call.toolCallId) ?? { type: "tool-result" as const, toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text" as const, value: "(no result)" } },
      );
      return [{ role: "assistant", content }, { role: "tool", content: results }];
    });
  }
}
