import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "../src/features/chat/chat.events";
import { ToolBridge } from "../src/features/chat/chat.bridge";
import { toolAnswerSchema } from "../src/features/chat/chat.types";

const collect = () => {
  const events: ChatEvent[] = [];
  return { events, emit: (e: ChatEvent) => events.push(e) };
};

describe("tool bridge", () => {
  test("hands a call to the plugin and resumes with its answer", async () => {
    const bridge = new ToolBridge(1_000);
    const { events, emit } = collect();
    bridge.open("run", emit, "self");
    const pending = bridge.call("run", "get_inventory", { include_enderchest: true });
    const call = events.find((e) => e.event === "tool_call")!;
    expect(call.data).toMatchObject({ name: "get_inventory", args: { include_enderchest: true } });
    const callId = (call.data as { call_id: string }).call_id;
    expect(bridge.answer("run", callId, "self", { ok: true, result: { main: [] } })).toBe(200);
    expect(await pending).toEqual({ ok: true, result: { main: [] } });
    expect(events.map((e) => e.event)).toEqual(["tool_status", "tool_call", "tool_status"]);
    expect(events[2].data).toMatchObject({ state: "finished", kind: "client" });
  });

  test("a second answer gets 409 and an unknown call 404", async () => {
    const bridge = new ToolBridge(1_000);
    const { events, emit } = collect();
    bridge.open("run", emit, "self");
    const pending = bridge.call("run", "get_world", {});
    const callId = (events[1].data as { call_id: string }).call_id;
    expect(bridge.answer("run", callId, "self", { ok: false, error: "nope" })).toBe(200);
    expect(bridge.answer("run", callId, "self", { ok: true, result: 1 })).toBe(409);
    expect(bridge.answer("run", "missing", "self", { ok: true, result: 1 })).toBe(404);
    expect(bridge.answer("other-run", callId, "self", { ok: true, result: 1 })).toBe(404);
    expect(await pending).toEqual({ ok: false, error: "nope" });
  });

  test("another tenant's answer is refused as unknown, and the run still waits for its own", async () => {
    const bridge = new ToolBridge(1_000);
    const { events, emit } = collect();
    bridge.open("run", emit, "license:aaa");
    const pending = bridge.call("run", "get_inventory", {});
    const callId = (events[1].data as { call_id: string }).call_id;
    expect(bridge.answer("run", callId, "license:bbb", { ok: true, result: { main: ["stolen"] } })).toBe(404);
    expect(bridge.answer("run", callId, "license:aaa", { ok: true, result: { main: [] } })).toBe(200);
    expect(await pending).toEqual({ ok: true, result: { main: [] } });
  });

  test("a silent plugin times out instead of hanging the run", async () => {
    const bridge = new ToolBridge(50);
    const { events, emit } = collect();
    bridge.open("run", emit, "self");
    const answer = await bridge.call("run", "get_target", {});
    expect(answer.ok).toBe(false);
    expect((answer as { error: string }).error).toContain("TOOL_TIMEOUT");
    expect(events.at(-1)!.data).toMatchObject({ state: "failed" });
  });

  test("closing a run fails what's pending and forgets it", async () => {
    const bridge = new ToolBridge(5_000);
    const { events, emit } = collect();
    bridge.open("run", emit, "self");
    const pending = bridge.call("run", "get_server", {});
    const callId = (events[1].data as { call_id: string }).call_id;
    bridge.close("run");
    expect((await pending).ok).toBe(false);
    expect(bridge.answer("run", callId, "self", { ok: true, result: 1 })).toBe(404);
    expect(bridge.active).toBe(0);
  });

  test("an abort cancels the wait", async () => {
    const bridge = new ToolBridge(5_000);
    bridge.open("run", () => {}, "self");
    const abort = new AbortController();
    const pending = bridge.call("run", "get_world", {}, abort.signal);
    abort.abort();
    expect(await pending).toEqual({ ok: false, error: "Cancelled" });
  });

  test("a long error from the plugin is cut, not refused, so the model hears it at once", () => {
    const parsed = toolAnswerSchema.parse({ ok: false, error: "x".repeat(2500) });
    expect(parsed).toEqual({ ok: false, error: "x".repeat(2000) });
  });
});
