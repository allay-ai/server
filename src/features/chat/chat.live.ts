import { settings } from "../settings/settings";
import type { Emit } from "./chat.events";
import { frame, SSE_HEADERS } from "./chat.sse";

const encoder = new TextEncoder();

/** One connection reading a run: what it writes and how it ends. */
interface Reader {
  write(chunk: string): void;
  close(): void;
}

/** What a run does as its plugin goes and comes back: the bridge holds tool calls' clocks meanwhile. */
export interface Presence {
  detached(): void;
  attached(): void;
}

/**
 * A question's run that outlives its connection (since 6.31, for plugins that send a `request_id`). Every event gets an
 * id and goes into the run's journal, so a plugin whose connection dropped reads on from the last id it saw. While no
 * one reads, the run goes on for RUN_DETACH_SECONDS, then stops, so nobody pays for an answer nobody reads.
 */
export class LiveRun {
  readonly abort = new AbortController();
  private readonly journal: { id: number; text: string }[] = [];
  private bytes = 0;
  private next = 1;
  /** The oldest id the journal still holds; a plugin that read less can't go on. */
  private first = 1;
  private reader?: Reader;
  private detach?: ReturnType<typeof setTimeout>;
  done = false;

  constructor(
    readonly id: string,
    readonly tenant: string,
    private readonly presence: Presence,
    private readonly detachMs: () => number = () => settings.get("RUN_DETACH_SECONDS") * 1000,
  ) {}

  readonly emit: Emit = (event) => {
    const id = this.next++;
    const text = `id: ${id}\n${frame(event)}`;
    this.journal.push({ id, text });
    this.bytes += text.length;
    const limit = settings.get("RUN_JOURNAL_BYTES");
    while (this.bytes > limit && this.journal.length > 1) {
      const old = this.journal.shift()!;
      this.bytes -= old.text.length;
      this.first = old.id + 1;
    }
    this.reader?.write(text);
  };

  /** Whether a plugin that read up to [after] can go on: the journal still holds what came next. */
  resumable(after: number): boolean {
    return after + 1 >= this.first;
  }

  /** [reader] reads from after [after]; a reader already there is closed, since its plugin came back on another connection. */
  attach(reader: Reader, after: number): void {
    const before = this.reader;
    this.reader = reader;
    before?.close();
    clearTimeout(this.detach);
    for (const entry of this.journal) if (entry.id > after) reader.write(entry.text);
    if (this.done) {
      this.reader = undefined;
      reader.close();
      return;
    }
    if (!before) this.presence.attached();
  }

  /** [reader]'s connection went away; the run waits for its plugin to come back. */
  leave(reader: Reader): void {
    if (this.reader !== reader) return;
    this.reader = undefined;
    if (this.done) return;
    this.presence.detached();
    this.detach = setTimeout(() => this.abort.abort(), this.detachMs());
  }

  end(): void {
    this.done = true;
    clearTimeout(this.detach);
    const reader = this.reader;
    this.reader = undefined;
    reader?.close();
  }
}

/** The runs that may be read again, by id and by the plugin's own `request_id`; one process, as the bridge. */
export class LiveRuns {
  private readonly runs = new Map<string, LiveRun>();
  private readonly requests = new Map<string, string>();

  /** How long a run waits for its plugin and stays after its end; tests pass their own. */
  constructor(
    private readonly ms = {
      detach: () => settings.get("RUN_DETACH_SECONDS") * 1000,
      linger: () => settings.get("RUN_LINGER_SECONDS") * 1000,
    },
  ) {}

  start(runId: string, tenant: string, requestId: string, presence: Presence): LiveRun {
    const run = new LiveRun(runId, tenant, presence, this.ms.detach);
    this.runs.set(runId, run);
    this.requests.set(`${tenant}\n${requestId}`, runId);
    return run;
  }

  /** The run, only for its own tenant: another tenant's reads as unknown. */
  get(runId: string, tenant: string): LiveRun | undefined {
    const run = this.runs.get(runId);
    return run?.tenant === tenant ? run : undefined;
  }

  /** The run a repeated question already started, so the same `request_id` never runs or pays twice. */
  byRequest(tenant: string, requestId: string): LiveRun | undefined {
    const runId = this.requests.get(`${tenant}\n${requestId}`);
    return runId ? this.get(runId, tenant) : undefined;
  }

  /** The run is over; its journal stays for RUN_LINGER_SECONDS, so a plugin that lost the last events still reads them. */
  finish(run: LiveRun, requestId: string): void {
    run.end();
    setTimeout(() => {
      this.runs.delete(run.id);
      this.requests.delete(`${run.tenant}\n${requestId}`);
    }, this.ms.linger());
  }

  get size(): number {
    return this.runs.size;
  }
}

/** The plugin's `Last-Event-ID`: the last event it read, 0 for none. */
export const lastEventId = (req: Request): number => {
  const value = Number.parseInt(req.headers.get("Last-Event-ID") ?? "0", 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

/** Streams [run] from after [after]; the connection going away leaves the run waiting instead of stopping it. */
export const liveResponse = (run: LiveRun, after: number, requestSignal?: AbortSignal): Response => {
  let reader: Reader | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  const leave = () => {
    clearInterval(ping);
    if (reader) run.leave(reader);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const current: Reader = {
        write: (chunk) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
          }
        },
        close: () => {
          if (closed) return;
          closed = true;
          clearInterval(ping);
          try {
            controller.close();
          } catch {
            // Already closed by the client.
          }
        },
      };
      reader = current;
      requestSignal?.addEventListener("abort", leave, { once: true });
      ping = setInterval(() => current.write(": ping\n\n"), settings.get("SSE_PING_MS"));
      run.attach(current, after);
    },
    cancel: leave,
  });
  return new Response(stream, { headers: SSE_HEADERS });
};
