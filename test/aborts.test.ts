import { describe, expect, test } from "bun:test";
import { isAbort } from "../src/application/aborts";

describe("aborts", () => {
  test("an abort is told apart from a real failure", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAbort(controller.signal.reason)).toBe(true);
    expect(isAbort(new DOMException("The operation was aborted.", "AbortError"))).toBe(true);
    expect(isAbort(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(isAbort(new Error("boom"))).toBe(false);
    expect(isAbort("AbortError")).toBe(false);
    expect(isAbort(undefined)).toBe(false);
  });
});
