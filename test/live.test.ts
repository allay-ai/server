import { afterEach, describe, expect, test } from "bun:test";
import { serve, type Server } from "bun";
import { routes } from "../src/application/routes";
import { handleAsk } from "../src/features/ask/ask.controller";
import { handleAskX } from "../src/features/askx/askx.controller";
import { ToolBridge } from "../src/features/chat/chat.bridge";
import type { ChatEvent } from "../src/features/chat/chat.events";
import { handleChat, handleRun, handleRunEvents, handleToolResult } from "../src/features/chat/chat.controller";
import { LiveRun, LiveRuns } from "../src/features/chat/chat.live";
import { handleHealth } from "../src/features/health/health.controller";
import { handleConsent, handleMemories, handleMemory, handleSession, handleUser } from "../src/features/users/users.controller";
import { handleLicense } from "../src/features/billing/license.controller";
import { handleTelegram } from "../src/features/telegram/telegram.controller";
import { AUTH, finish, scripted, testDeps, text, toolCall } from "./helpers";

const handlers = {
  handleAsk, handleAskX, handleChat, handleToolResult, handleRun, handleRunEvents, handleHealth, handleUser, handleSession, handleConsent, handleMemories, handleMemory, handleLicense, handleTelegram,
};
let server: Server<undefined> | undefined;

afterEach(() => server?.stop(true));

const start = (deps: ReturnType<typeof testDeps>) => {
  server = serve({ port: 0, routes: routes(deps, handlers) });
  return `http://localhost:${server.port}`;
};

const call = (url: string, init: RequestInit = {}) => fetch(url, { ...init, headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) } });

const ask = (base: string, requestId: string, signal?: AbortSignal, headers: Record<string, string> = {}) =>
  call(`${base}/api/v2/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...headers },
    body: JSON.stringify({ user_id: "player-1", player: { name: "Steve" }, message: "what world is this?", tools: ["get_world"], request_id: requestId }),
    signal,
  });

interface Frame {
  id: number;
  event: string;
  data: any;
}

/** Reads frames with their ids until [stop] says enough, or the stream ends. */
const frames = async (response: Response, stop: (frame: Frame) => boolean = () => false): Promise<Frame[]> => {
  const read: Frame[] = [];
  const reader = (response.body as ReadableStream<Uint8Array>).pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return read;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (block.startsWith(":")) continue;
      const frame = { id: Number(block.match(/^id: (\d+)$/m)?.[1]), event: block.match(/^event: (.+)$/m)![1], data: JSON.parse(block.match(/^data: (.+)$/m)![1]) };
      read.push(frame);
      if (stop(frame)) {
        await reader.cancel();
        return read;
      }
    }
  }
};

const waitFor = async (check: () => boolean, ms = 2_000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

describe("a run's journal", () => {
  const presence = () => {
    const seen: string[] = [];
    return { seen, presence: { detached: () => seen.push("detached"), attached: () => seen.push("attached") } };
  };
  const reader = () => {
    const chunks: string[] = [];
    let closed = false;
    const close = () => {
      closed = true;
    };
    return { chunks, closed: () => closed, reader: { write: (c: string) => void chunks.push(c), close } };
  };
  const event = (delta: string): ChatEvent => ({ event: "text", data: { delta } });

  test("every event gets the next id, and a reader that comes back gets only what it missed", () => {
    const { presence: p } = presence();
    const run = new LiveRun("run", "self", p);
    run.emit(event("a"));
    run.emit(event("b"));
    run.emit(event("c"));
    const back = reader();
    run.attach(back.reader, 1);
    expect(back.chunks.map((c) => c.split("\n", 1)[0])).toEqual(["id: 2", "id: 3"]);
    run.emit(event("d"));
    expect(back.chunks.at(-1)).toStartWith("id: 4\nevent: text\n");
  });

  test("a reader that left waits for the plugin, which a second reader replaces", () => {
    const { seen, presence: p } = presence();
    const run = new LiveRun("run", "self", p, () => 60_000);
    const first = reader();
    run.attach(first.reader, 0);
    const second = reader();
    run.attach(second.reader, 0);
    expect(first.closed()).toBe(true);
    // The first connection's late goodbye leaves the second reading.
    run.leave(first.reader);
    expect(seen).toEqual(["attached"]);
    run.leave(second.reader);
    expect(seen).toEqual(["attached", "detached"]);
    run.attach(reader().reader, 0);
    expect(seen).toEqual(["attached", "detached", "attached"]);
    expect(run.abort.signal.aborted).toBe(false);
    run.end();
  });

  test("nobody reading for too long stops the run", async () => {
    const run = new LiveRun("run", "self", presence().presence, () => 20);
    const gone = reader();
    run.attach(gone.reader, 0);
    run.leave(gone.reader);
    await waitFor(() => run.abort.signal.aborted);
  });

  test("an ended run hands a late reader the rest and closes it", () => {
    const run = new LiveRun("run", "self", presence().presence);
    run.emit(event("a"));
    run.emit({ event: "done", data: { answer: "a", duration_ms: 1 } });
    run.end();
    const late = reader();
    run.attach(late.reader, 1);
    expect(late.chunks).toHaveLength(1);
    expect(late.closed()).toBe(true);
  });

  test("a journal past its size keeps the newest, and a reader too far behind can't go on", () => {
    const before = process.env.RUN_JOURNAL_BYTES;
    process.env.RUN_JOURNAL_BYTES = "100000";
    try {
      const run = new LiveRun("run", "self", presence().presence);
      for (let i = 0; i < 2_000; i++) run.emit(event("x".repeat(100)));
      expect(run.resumable(0)).toBe(false);
      expect(run.resumable(1_999)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.RUN_JOURNAL_BYTES;
      else process.env.RUN_JOURNAL_BYTES = before;
    }
  });

  test("a run belongs to its tenant, by id and by request", () => {
    const runs = new LiveRuns();
    const run = runs.start("run", "license:a", "req-12345678", presence().presence);
    expect(runs.get("run", "license:a")).toBe(run);
    expect(runs.get("run", "license:b")).toBeUndefined();
    expect(runs.byRequest("license:a", "req-12345678")).toBe(run);
    expect(runs.byRequest("license:b", "req-12345678")).toBeUndefined();
  });
});

describe("tool calls while the plugin is away", () => {
  test("a call's clock stops while the plugin is gone and starts over when it's back", async () => {
    const bridge = new ToolBridge(60);
    bridge.open("run", () => {}, "self");
    bridge.hold("run");
    let settled: unknown;
    void bridge.call("run", "get_world", {}).then((answer) => (settled = answer));
    await Bun.sleep(150);
    expect(settled).toBeUndefined();
    bridge.release("run");
    await waitFor(() => settled !== undefined);
    expect(settled).toMatchObject({ ok: false });
  });
});

describe("reading a run on", () => {
  test("a dropped connection reads on from its last event, and the tool's answer still counts", async () => {
    const { model, prompts } = scripted([[toolCall("get_world", {}), finish("tool-calls")], [...text("The overworld."), finish()]]);
    const deps = testDeps(model);
    const base = start(deps);
    const dropped = new AbortController();
    const first = await frames(await ask(base, "question-0001", dropped.signal), (frame) => frame.event === "tool_call");
    const runId = first.find((f) => f.event === "start")!.data.run_id as string;
    const tool = first.at(-1)!;
    dropped.abort();
    expect(first.every((f, i) => f.id === i + 1)).toBe(true);
    // The connection is gone; the answer goes in anyway.
    const posted = await call(`${base}/api/v2/chat/${runId}/tools/${tool.data.call_id}`, { method: "POST", body: JSON.stringify({ ok: true, result: { dimension: "overworld" } }) });
    expect(posted.status).toBe(200);
    const rest = await frames(await call(`${base}/api/v2/chat/${runId}/events`, { headers: { "Last-Event-ID": String(tool.id) } }));
    expect(rest[0].id).toBe(tool.id + 1);
    expect(rest.map((f) => f.event)).toContain("done");
    expect(rest.find((f) => f.event === "done")!.data.answer).toBe("The overworld.");
    expect(prompts).toHaveLength(2);
  });

  test("the same request_id again reads the run it started instead of asking twice", async () => {
    const { model, prompts } = scripted([[...text("Hi."), finish()]]);
    const deps = testDeps(model);
    const base = start(deps);
    const once = await frames(await ask(base, "question-0002"));
    const again = await frames(await ask(base, "question-0002"));
    expect(again.find((f) => f.event === "start")!.data.run_id).toBe(once.find((f) => f.event === "start")!.data.run_id);
    expect(again.map((f) => f.event)).toEqual(once.map((f) => f.event));
    expect(prompts).toHaveLength(1);
  });

  test("a run nobody knows, and a cancel, answer as the protocol says", async () => {
    const { model } = scripted([[toolCall("get_world", {}), finish("tool-calls")], [...text("never"), finish()]]);
    const deps = testDeps(model, { toolTimeoutMs: 10_000 });
    const base = start(deps);
    expect((await call(`${base}/api/v2/chat/nope/events`)).status).toBe(404);
    expect((await call(`${base}/api/v2/chat/nope`, { method: "DELETE" })).status).toBe(404);
    const dropped = new AbortController();
    const first = await frames(await ask(base, "question-0003", dropped.signal), (frame) => frame.event === "tool_call");
    dropped.abort();
    const runId = first[0].data.run_id as string;
    const cancelled = await call(`${base}/api/v2/chat/${runId}`, { method: "DELETE" });
    expect(cancelled.status).toBe(200);
    // The run stops at once instead of waiting out the tool's ten seconds.
    await waitFor(() => deps.bridge.active === 0);
  });

  test("a plugin that sent no request_id still stops its run by going away", async () => {
    const { model } = scripted([[toolCall("get_world", {}), finish("tool-calls")], [...text("never"), finish()]]);
    const deps = testDeps(model, { toolTimeoutMs: 10_000 });
    const base = start(deps);
    const dropped = new AbortController();
    const response = await call(`${base}/api/v2/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ user_id: "player-1", player: { name: "Steve" }, message: "hi", tools: ["get_world"] }),
      signal: dropped.signal,
    });
    await frames(response, (frame) => frame.event === "tool_call");
    dropped.abort();
    await waitFor(() => deps.bridge.active === 0);
    expect(deps.live.size).toBe(0);
  });
});
