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
