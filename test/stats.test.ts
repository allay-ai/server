import { describe, expect, test } from "bun:test";
import { runAllay } from "../src/agent/allay";
import { statsOfDays, statsOfRuns } from "../src/features/admin/stats";
import { silent } from "../src/features/chat/chat.events";
import { memoryTraces } from "../src/infrastructure/observability/traces";
import { type RunRecord, memoryRuns } from "../src/infrastructure/runs/runs";
import { finish, scripted, testDeps, text, toolCall } from "./helpers";

const SECRET_QUESTION = "where did I hide my diamonds at 120 64 -300?";

describe("runs", () => {
  test("a run leaves its numbers, never its words", async () => {
    const { model } = scripted([
      [toolCall("exact_calculations", { expressions: ["1+1"] }), toolCall("search_web", { query: "diamond level" }, "s1"), finish("tool-calls")],
      [...text("Under the oak, I bet."), finish()],
    ]);
    const deps = { ...testDeps(model), runs: memoryRuns() };
    await runAllay(
      { mode: "ask", platform: "minecraft", tenant: "license:lic1", userId: "u-1", message: SECRET_QUESTION, tools: [], player: { name: "Steve" }, locale: "en_us", server: { id: "srv-1" } },
      deps,
      { runId: "run-1", emit: silent, payer: { kind: "license", id: "lic1" } },
    );
    const [run] = deps.runs.all;
    expect(run).toMatchObject({
      id: "run-1",
      kind: "ask",
      payer: "license",
      server: "license:lic1",
      server_id: "srv-1",
      user_id: deps.pseudonyms.of("u-1"),
      language: "en_us",
      model: "mock-model",
      steps: 2,
      searches: 1,
      result: "ok",
    });
    expect(run.tools.map((t) => t.name).sort()).toEqual(["exact_calculations", "search_web"]);
    expect(run.cost).toBeGreaterThan(0);
    const raw = JSON.stringify(deps.runs.all);
    // The player is a pseudonym: neither their id nor their name is kept.
    expect(run.user_id).toMatch(/^p_[0-9a-f]{20}$/);
    expect(raw).not.toContain("u-1");
    expect(raw).not.toContain("Steve");
    expect(raw).not.toContain("diamonds");
    expect(raw).not.toContain("oak");
    expect(raw).not.toContain("1+1");
  });

  test("a failed run is counted with its error code", async () => {
    const { model } = scripted([[{ type: "error", error: new Error("boom") }]]);
    const deps = { ...testDeps(model), runs: memoryRuns() };
    await runAllay({ mode: "ask", platform: "minecraft", tenant: "self", userId: "u-1", message: "hi", tools: [], visibility: "public" }, deps, { runId: "run-2", emit: silent }).catch(() => undefined);
    expect(deps.runs.all[0]).toMatchObject({ kind: "askall", payer: "self", server: "self", result: "error", error_code: "AI_REQUEST_FAILED" });
  });

  test("days roll up as runs come in", async () => {
    const runs = memoryRuns();
    const base: RunRecord = {
      id: "a",
      at: new Date("2026-10-17T10:00:00Z"),
      kind: "ask",
      payer: "self",
      server: "self",
      user_id: "u-1",
      model: "openai/gpt-6-luna",
      input_tokens: 100,
      output_tokens: 10,
      reasoning_tokens: 0,
      cost: 0.001,
      steps: 1,
      tools: [{ name: "inventory", ok: true }],
      searches: 0,
      duration_ms: 2_500,
      result: "ok",
    };
    await runs.add(base);
    await runs.add({ ...base, id: "b", user_id: "u-2", tools: [{ name: "inventory", ok: false }], result: "error", duration_ms: 9_000 });
    await runs.add({ ...base, id: "c", kind: "summary", cost: 0.0005, tools: [] });
    await runs.add({ ...base, id: "d", at: new Date("2026-10-18T09:00:00Z") });
    const [day] = await runs.days("2026-10-17", "2026-10-17");
    expect(day).toMatchObject({ runs: 3, questions: 2, errors: 1, players: ["u-1", "u-2"], models: { "openai/gpt-6-luna": { runs: 3 } }, tools: { inventory: { calls: 2, failed: 1 } } });
    expect(day.cost).toBeCloseTo(0.0025);

    const week = statsOfDays("7d", await runs.days("2026-10-12", "2026-10-18"), new Date("2026-10-18T12:00:00Z"));
    expect(week.series).toHaveLength(7);
    expect(week.totals).toMatchObject({ questions: 3, errors: 1, players: 2 });
    expect(week.totals.p50_ms).toBe(3_000);
    expect(week.tools[0]).toEqual({ name: "inventory", calls: 3, failed: 1 });

    const today = statsOfRuns(runs.all, new Date("2026-10-18T12:00:00Z"));
    expect(today.series).toHaveLength(24);
    expect(today.totals.questions).toBe(1);
    expect(today.totals.p50_ms).toBe(2_500);
  });

  test("players and servers sum their runs", async () => {
    const runs = memoryRuns();
    const run = (id: string, user: string, at: string, cost = 0.002): RunRecord => ({
      id, at: new Date(at), kind: "ask", payer: "byok", server: "byok:abc", server_id: "srv", user_id: user, model: "m",
      input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, cost, steps: 1, tools: [], searches: 0, duration_ms: 100, result: "ok",
    });
    await runs.add(run("1", "u1", "2026-10-10T00:00:00Z"));
    await runs.add(run("2", "u2", "2026-10-11T00:00:00Z"));
    await runs.add(run("3", "u1", "2026-10-12T00:00:00Z"));
    const { players, total } = await runs.players({ limit: 10, skip: 0 });
    expect(total).toBe(2);
    expect(players[0]).toMatchObject({ user_id: "u1", questions: 2 });
    expect(await runs.servers({ limit: 10 })).toEqual([expect.objectContaining({ server: "byok:abc", server_id: "srv", questions: 3, players: 2 })]);
  });
});

describe("traces", () => {
  test("only the shape of a trace leaves the store", async () => {
    const traces = memoryTraces([
      {
        traceId: "t1",
        spanId: "root",
        parentSpanId: null,
        spanType: "agent_run",
        runId: "run-1",
        startedAt: new Date("2026-10-18T10:00:00Z"),
        endedAt: new Date("2026-10-18T10:00:03Z"),
        attributes: { instructions: "You are Allay, a system prompt" },
      },
      {
        traceId: "t1",
        spanId: "step",
        parentSpanId: "root",
        spanType: "model_step",
        startedAt: new Date("2026-10-18T10:00:00Z"),
        endedAt: new Date("2026-10-18T10:00:02Z"),
        attributes: { stepIndex: 0, usage: { inputTokens: 900, outputTokens: 20, outputDetails: { reasoning: 5 } }, finishReason: "tool-calls" },
        ...({ input: [{ role: "user", content: SECRET_QUESTION }], output: { text: "a secret answer" } } as object),
      },
      {
        traceId: "t1",
        spanId: "tool",
        parentSpanId: "step",
        spanType: "tool_call",
        entityName: "inventory",
        startedAt: new Date("2026-10-18T10:00:01Z"),
        endedAt: new Date("2026-10-18T10:00:02Z"),
        attributes: { success: false, toolDescription: "The asking player's inventory" },
        ...({ input: { secret: "argument" }, output: { error: "the chest at 1 2 3" } } as object),
      },
    ]);
    const found = await traces.get("run-1");
    expect(found?.trace).toMatchObject({ trace_id: "t1", run_id: "run-1" });
    expect(found?.spans.map((s) => [s.type, s.label, s.ok])).toEqual([
      ["agent_run", "agent run", true],
      ["model_step", "step 0", true],
      ["tool_call", "inventory", false],
    ]);
    expect(found?.spans[1]).toMatchObject({ input_tokens: 900, output_tokens: 20, reasoning_tokens: 5, finish_reason: "tool-calls" });
    const raw = JSON.stringify(found);
    for (const text of ["diamonds", "secret", "system prompt", "chest at", "argument", "The asking player"]) expect(raw).not.toContain(text);
  });
});
