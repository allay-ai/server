import type { Usage } from "../../agent/agent.types";

/** Every event the v2 stream sends; see https://github.com/allay-ai/server/wiki/Plugin-protocol. */
export type ChatEvent =
  | { event: "start"; data: { run_id: string; model: string } }
  | { event: "reasoning"; data: { delta: string } }
  | { event: "tool_call"; data: { call_id: string; name: string; args: unknown } }
  | {
      event: "tool_status";
      data: {
        call_id: string;
        name: string;
        kind: "client" | "server";
        state: "started" | "finished" | "failed";
        args?: unknown;
        summary?: string;
        /** The summary as a key and values, so the plugin can say it in the player's language. */
        summary_key?: string;
        summary_values?: Record<string, string | number>;
      };
    }
  | { event: "text"; data: { delta: string } }
  | { event: "commands"; data: { is_sequence: boolean; commands: string[] } }
  | { event: "usage"; data: Usage }
  | { event: "done"; data: { answer: string; duration_ms: number } }
  | { event: "error"; data: { code: string; message: string } };

export type Emit = (event: ChatEvent) => void;

/** A server tool's summary: English text for old plugins, and a key with values the plugin's language files know. */
export interface Summary {
  text: string;
  key?: string;
  values?: Record<string, string | number>;
}

export const summaryFields = (summary?: Summary) =>
  summary
    ? { summary: summary.text, ...(summary.key ? { summary_key: summary.key } : {}), ...(summary.values ? { summary_values: summary.values } : {}) }
    : {};

/** Discards events, for v1 requests that answer in one piece. */
export const silent: Emit = () => {};
