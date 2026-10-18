import { settings } from "../settings/settings";
import type { ChatEvent, Emit } from "./chat.events";

const encoder = new TextEncoder();

export const frame = (event: ChatEvent): string => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;

/**
 * Streams a run as Server-Sent Events. The run gets an emitter and a signal that fires when the
 * client goes away, so the model call stops instead of burning tokens for nobody.
 */
export const sseResponse = (run: (emit: Emit, signal: AbortSignal) => Promise<unknown>, requestSignal?: AbortSignal): Response => {
  const abort = new AbortController();
  let closed = false;
  let ping: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };
      requestSignal?.addEventListener("abort", () => abort.abort(), { once: true });
      ping = setInterval(() => write(": ping\n\n"), settings.get("SSE_PING_MS"));
      run((event) => write(frame(event)), abort.signal)
        .catch(() => {
          // The run already sent its error event.
        })
        .finally(finish);
    },
    cancel() {
      closed = true;
      clearInterval(ping);
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx would otherwise buffer the stream and the player would see nothing until the end.
      "X-Accel-Buffering": "no",
    },
  });
};
