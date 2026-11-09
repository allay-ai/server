import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { serve, type Server } from "bun";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader, type ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { routes } from "../src/application/routes";
import { handleAsk } from "../src/features/ask/ask.controller";
import { handleAskX } from "../src/features/askx/askx.controller";
import { handleChat, handleToolResult } from "../src/features/chat/chat.controller";
import { handleHealth } from "../src/features/health/health.controller";
import { handleConsent, handleMemories, handleMemory, handleSession, handleUser } from "../src/features/users/users.controller";
import { handleLicense } from "../src/features/billing/license.controller";
import { handleTelegram } from "../src/features/telegram/telegram.controller";
import { memoryLicenses } from "../src/infrastructure/billing/licenses";
import { memoryServers } from "../src/infrastructure/servers/servers";
import { readGauges } from "../src/infrastructure/telemetry/gauges";
import { useSignals } from "../src/infrastructure/telemetry/signals";
import { startTelemetry } from "../src/infrastructure/telemetry/telemetry";
import { AUTH, finish, readSse, scripted, testDeps, text, toolCall } from "./helpers";

const QUESTION = "what sword do I carry in my satchel?";
const ANSWER = "A shimmering netherite blade.";
const SECRET_ITEM = "zebra_obsidian_relic";

const handlers = { handleAsk, handleAskX, handleChat, handleToolResult, handleHealth, handleUser, handleSession, handleConsent, handleMemories, handleMemory, handleLicense, handleTelegram };

let server: Server<undefined> | undefined;
let spans: InMemorySpanExporter;
let metrics: InMemoryMetricExporter;
let reader: PeriodicExportingMetricReader;
let events: InMemoryLogRecordExporter;

const telemetry = (content = false) => {
  spans = new InMemorySpanExporter();
  metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  reader = new PeriodicExportingMetricReader({ exporter: metrics, exportIntervalMillis: 3_600_000 });
  events = new InMemoryLogRecordExporter();
  useSignals({
    tracerProvider: new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] }),
    meterProvider: new MeterProvider({ readers: [reader] }),
    loggerProvider: new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: events })] }),
    content,
  });
};

beforeEach(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

afterEach(() => {
  server?.stop(true);
  useSignals({});
  context.disable();
});

const ask = async (deps: ReturnType<typeof testDeps>, timing?: object) => {
  server = serve({ port: 0, routes: routes(deps, handlers) });
  const base = `http://localhost:${server.port}`;
  let runId = "";
  const response = await fetch(`${base}/api/v2/chat`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ user_id: "player-1", player: { name: "Steve" }, message: QUESTION, tools: ["get_inventory"], server: { id: "srv-1", loader: "spigot", side: "server" } }),
  });
  return readSse(response, async (event) => {
    if (event.event === "start") runId = event.data.run_id;
    if (event.event === "tool_call") {
      await fetch(`${base}/api/v2/chat/${runId}/tools/${event.data.call_id}`, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ ok: true, result: { main: [{ id: SECRET_ITEM, count: 1 }] }, ...(timing ? { timing } : {}) }),
      });
    }
  });
};

const model = () =>
  scripted([
    [toolCall("inventory", {}), finish("tool-calls")],
    [...text(ANSWER), finish()],
  ]).model;

const collected = async () => {
  await reader.forceFlush();
  return metrics.getMetrics();
};

const points = (all: ResourceMetrics[], name: string) =>
  all
    .at(-1)!
    .scopeMetrics.flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === name)
    .flatMap((metric) => metric.dataPoints as Array<{ attributes: Record<string, unknown>; value: unknown }>);

const named = (all: ReadableSpan[], name: string) => all.find((span) => span.name === name);

describe("OpenTelemetry", () => {
  test("a run is a tree of spans: the request, the agent, its steps, the tool, the trip to the plugin, and the game", async () => {
    telemetry();
    const events = await ask(testDeps(model()), { queued_ms: 3, run_ms: 7 });
    expect(events.at(-1)?.event).toBe("done");
    const all = spans.getFinishedSpans();
    const request = named(all, "POST /api/v2/chat")!;
    const agent = named(all, "invoke_agent allay")!;
    const steps = all.filter((span) => span.name === "chat mock-model");
    const tool = named(all, "execute_tool inventory")!;
    const trip = named(all, "plugin get_inventory")!;
    const game = named(all, "game get_inventory")!;
    for (const span of [request, agent, tool, trip, game]) expect(span).toBeDefined();
    expect(steps).toHaveLength(2);
    // One trace, nested as the run went.
    expect(new Set(all.filter((s) => s.name !== "allay.memories.load" && s.name !== "allay.session.load").map((s) => s.spanContext().traceId)).size).toBe(1);
    expect(agent.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
    expect(steps[0].parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
    expect(tool.parentSpanContext?.spanId).toBe(steps[0].spanContext().spanId);
    expect(trip.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(game.parentSpanContext?.spanId).toBe(trip.spanContext().spanId);
    expect(agent.attributes).toMatchObject({ "allay.run.kind": "ask", "allay.tenant": "self", "allay.server.id": "srv-1", "allay.loader": "spigot", "allay.result": "ok", "gen_ai.usage.input_tokens": 24 });
    expect(String(agent.attributes["allay.player"])).toStartWith("p_");
    expect(steps[0].attributes).toMatchObject({ "gen_ai.usage.input_tokens": 12, "gen_ai.usage.output_tokens": 7, "allay.cost.usd": 0.0005 });
    expect(tool.attributes).toMatchObject({ "gen_ai.tool.name": "inventory", "allay.tool.side": "client", "allay.tool.ok": true });
    expect(game.attributes["allay.plugin.queued_ms"]).toBe(3);
  });

  test("metrics carry the tenant and the server, never the player", async () => {
    telemetry();
    await ask(testDeps(model()), { queued_ms: 3, run_ms: 7 });
    const all = await collected();
    const runs = points(all, "allay.runs");
    expect(runs).toHaveLength(1);
    expect(runs[0].value).toBe(1);
    expect(runs[0].attributes).toMatchObject({ kind: "ask", payer: "self", tenant: "self", server_id: "srv-1", model: "mock-model", result: "ok", loader: "spigot" });
    expect(points(all, "allay.tool.calls")[0].attributes).toMatchObject({ tool: "inventory", tool_side: "client", ok: "true" });
    const tokens = Object.fromEntries(points(all, "allay.token.usage").map((p) => [p.attributes.type, p.value]));
    expect(tokens).toMatchObject({ input: 24, output: 10, reasoning: 4 });
    expect(points(all, "allay.cost.usage").find((p) => p.attributes.source === "model")?.value).toBeCloseTo(0.001);
    expect(points(all, "allay.plugin.tool.run")).toHaveLength(1);
    expect(points(all, "http.server.request.duration").map((p) => p.attributes["http.route"])).toContain("/api/v2/chat/:runId/tools/:callId");
    expect(points(all, "allay.runs.active")[0].value).toBe(0);
    for (const metric of all.at(-1)!.scopeMetrics.flatMap((s) => s.metrics)) {
      for (const point of metric.dataPoints) expect(Object.keys(point.attributes)).not.toContain("player");
    }
  });

  test("events say what happened in numbers, with the player's pseudonym", async () => {
    telemetry();
    await ask(testDeps(model()));
    const records = events.getFinishedLogRecords();
    const names = records.map((r) => r.eventName);
    expect(names).toContain("allay.api_request");
    expect(names).toContain("allay.tool_result");
    const finished = records.find((r) => r.eventName === "allay.run.finished")!;
    expect(finished.attributes).toMatchObject({ kind: "ask", result: "ok", steps: 2, tools: 1, failed_tools: 0, input_tokens: 24 });
    expect(String(finished.attributes["allay.player"])).toStartWith("p_");
  });

  test("no question, answer, tool data, name, or player id leaves in any signal", async () => {
    telemetry();
    await ask(testDeps(model()), { run_ms: 5 });
    const everything = JSON.stringify([
      spans.getFinishedSpans().map((s) => ({ name: s.name, attributes: s.attributes, events: s.events })),
      await collected(),
      events.getFinishedLogRecords().map((r) => ({ name: r.eventName, attributes: r.attributes, body: r.body })),
    ]);
    for (const word of [QUESTION, "satchel", ANSWER, "netherite", SECRET_ITEM, "Steve", "player-1"]) expect(everything).not.toContain(word);
  });

  test("OTEL_LOG_CONTENT on a self-hosted backend sends the texts", async () => {
    telemetry(true);
    await ask(testDeps(model()));
    const agent = named(spans.getFinishedSpans(), "invoke_agent allay")!;
    expect(agent.attributes["allay.question"]).toContain("satchel");
    expect(agent.attributes["allay.answer"]).toContain("netherite");
    expect(String(named(spans.getFinishedSpans(), "execute_tool inventory")!.attributes["gen_ai.tool.call.result"])).toContain(SECRET_ITEM);
  });

  test("a refused question counts by code for its tenant", async () => {
    telemetry();
    const deps = testDeps(model());
    await deps.bans.block("self", deps.pseudonyms.of("self", "player-1"), "test");
    await ask(deps).catch(() => undefined);
    const refused = points(await collected(), "allay.gate.refusals");
    expect(refused[0]).toMatchObject({ value: 1, attributes: { code: "PLAYER_BLOCKED", tenant: "self", server_id: "srv-1" } });
    expect(points(await collected(), "allay.runs")).toHaveLength(0);
  });

  test("a timed-out tool counts, and its run still ends", async () => {
    telemetry();
    const deps = testDeps(model(), { toolTimeoutMs: 50 });
    server = serve({ port: 0, routes: routes(deps, handlers) });
    const response = await fetch(`http://localhost:${server.port}/api/v2/chat`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "player-1", message: QUESTION, tools: ["get_inventory"] }),
    });
    await readSse(response);
    const all = await collected();
    expect(points(all, "allay.bridge.timeouts")[0].value).toBe(1);
    expect(points(all, "allay.tool.calls")[0].attributes.ok).toBe("false");
    expect(named(spans.getFinishedSpans(), "plugin get_inventory")!.attributes["error.type"]).toBe("TOOL_TIMEOUT");
  });

  test("nothing is set, nothing starts", () => {
    expect(startTelemetry({ version: "test", selfHosted: true, env: {} })).toMatchObject({ traces: false, metrics: false, logs: false });
    expect(startTelemetry({ version: "test", selfHosted: true, env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318", OTEL_SDK_DISABLED: "true" } }).traces).toBe(false);
  });

  test("an endpoint turns on every signal, and each can be turned off", async () => {
    const on = startTelemetry({ version: "test", selfHosted: false, env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9", OTEL_LOGS_EXPORTER: "none" } });
    expect(on).toMatchObject({ traces: true, metrics: true, logs: false });
    await on.shutdown();
  });

  test("gauges name the servers seen this month and say how much of its budget each license used", async () => {
    const servers = memoryServers();
    const now = new Date("2026-11-05T12:00:00Z");
    await servers.seen({ tenant: "license:abc", server_id: "srv-1", ip: "203.0.113.5", plugin_version: "6.24.0", loader: "spigot", side: "server" }, now);
    await servers.seen({ tenant: "license:old", server_id: "srv-2", ip: "203.0.113.6" }, new Date("2026-08-01T00:00:00Z"));
    await servers.register({ tenant: "license:abc", server_id: "srv-1", ip: "203.0.113.5", plugin_version: "6.24.0", loader: "spigot", side: "server", name: "Moonlands" }, now);
    const licenses = memoryLicenses();
    await licenses.create({ id: "abc", secret_hash: "x", created_at: now, renews: false, plan: "month" });
    await licenses.grant("abc", { budget: 3, starts: new Date("2026-11-01T00:00:00Z"), ends: new Date("2026-12-01T00:00:00Z") });
    const grant = (await licenses.grants("abc"))[0];
    await licenses.charge(grant.id, 0.75);
    const readings = await readGauges({ servers, licenses, now: () => now });
    expect(readings.servers).toHaveLength(1);
    expect(readings.servers[0].attributes).toMatchObject({ tenant: "license:abc", server_id: "srv-1", name: "Moonlands", plugin_version: "6.24.0" });
    expect(JSON.stringify(readings)).not.toContain("203.0.113");
    expect(readings.budgets).toEqual([{ value: 0.25, attributes: { tenant: "license:abc", plan: "month", kind: "server", name: "" } }]);
    expect(readings.licenses).toEqual([{ value: 1, attributes: { plan: "month", kind: "server", state: "active" } }]);
  });
});
