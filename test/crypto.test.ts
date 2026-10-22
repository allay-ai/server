import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cipherWith, isSealed, openJson, sealJson } from "../src/infrastructure/crypto/data";

const key = (label: string) => createHash("sha256").update(label).digest();

describe("player data at rest", () => {
  test("seals and opens any JSON value, with a new IV each time", () => {
    const cipher = cipherWith(key("a"));
    const value = { text: "base at 120 64 -300", place: { x: 120, y: 64, z: -300, dimension: "overworld" } };
    const first = cipher.seal(value);
    const second = cipher.seal(value);
    expect(isSealed(first)).toBe(true);
    expect(first.iv).not.toBe(second.iv);
    expect(first.data).not.toContain("base");
    expect(cipher.open(first)).toEqual(value);
  });

  test("another key or a changed byte opens nothing", () => {
    const sealed = cipherWith(key("a")).seal("secret");
    expect(cipherWith(key("b")).open(sealed)).toBeUndefined();
    const tag = Buffer.from(sealed.tag, "base64");
    tag[0] ^= 1;
    expect(cipherWith(key("a")).open({ ...sealed, tag: tag.toString("base64") })).toBeUndefined();
  });

  test("values written in the clear before 6.9 read as they are", () => {
    expect(openJson<string>("plain")).toBe("plain");
    expect(openJson<{ a: number }>(sealJson({ a: 1 }))).toEqual({ a: 1 });
  });
});

describe("traces at rest", () => {
  const span = {
    id: "s1",
    traceId: "t1",
    type: "model_step",
    name: "step 0",
    input: [{ role: "user", content: "where is my diamond stash" }],
    output: { text: "behind the waterfall" },
    attributes: { model: "m", usage: { inputTokens: 12 }, stepIndex: 0, instructions: "You remember: base at 120 64 -300" },
    metadata: { runId: "r1", environment: "production", note: "Steve's secret" },
    errorInfo: { id: "E1", category: "USER", message: "player Steve said xyzzy" },
    requestContext: { player: "Steve" },
    inputPreview: "where is my diamond",
  };

  test("prompts, answers, and the rest go sealed; numbers and names stay readable", async () => {
    const { sealSpan, openSpan } = await import("../src/infrastructure/observability/sealing");
    const sealed = sealSpan(span as Record<string, unknown>) as Record<string, any>;
    const raw = JSON.stringify(sealed);
    for (const word of ["diamond", "waterfall", "120 64 -300", "Steve", "xyzzy"]) expect(raw).not.toContain(word);
    expect(sealed.attributes).toMatchObject({ model: "m", usage: { inputTokens: 12 }, stepIndex: 0 });
    expect(sealed.metadata).toEqual({ runId: "r1", environment: "production" });
    expect(sealed.errorInfo).toEqual({ id: "E1", category: "USER" });
    const opened = openSpan({ ...sealed, error: sealed.errorInfo });
    expect(opened.input).toEqual(span.input);
    expect(opened.output).toEqual(span.output);
    expect(opened.attributes.instructions).toBe(span.attributes.instructions);
    expect(opened.error).toMatchObject({ id: "E1", message: "player Steve said xyzzy" });
  });
});
