import { describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { clientAddress, inRanges, rangesOf, rateKey, validRanges } from "../src/shared/lib/address";
import { isPrivateAddress } from "../src/features/billing/byok";

/** A request as Bun hands it over, from [peer]. */
const from = (peer: string, headers: Record<string, string> = {}) => {
  const server = { requestIP: () => ({ address: peer, family: "IPv4", port: 1 }) } as unknown as Server<undefined>;
  return [new Request("http://backend/api", { headers }), server] as const;
};

describe("the client's address", () => {
  const xff = { proxies: "10.0.0.0/8, ::1", header: "x-forwarded-for" as const };

  test("forwarding headers count only from a trusted proxy", () => {
    expect(clientAddress(...from("203.0.113.5", { "X-Forwarded-For": "1.2.3.4" }), xff)).toBe("203.0.113.5");
    expect(clientAddress(...from("10.0.0.2", { "X-Forwarded-For": "1.2.3.4" }), xff)).toBe("1.2.3.4");
    // Before 6.0 any private peer was believed; now only the ones the operator named.
    expect(clientAddress(...from("192.168.1.5", { "X-Forwarded-For": "1.2.3.4" }), xff)).toBe("192.168.1.5");
    expect(clientAddress(...from("10.0.0.2", { "X-Forwarded-For": "1.2.3.4" }), { proxies: "", header: "x-forwarded-for" })).toBe("10.0.0.2");
  });

  test("X-Forwarded-For is read from the right, past the trusted hops, so a value the client wrote never wins", () => {
    expect(clientAddress(...from("10.0.0.2", { "X-Forwarded-For": "6.6.6.6, 1.2.3.4, 10.0.0.9" }), xff)).toBe("1.2.3.4");
    expect(clientAddress(...from("10.0.0.2", { "X-Forwarded-For": "not-an-ip, 1.2.3.4" }), xff)).toBe("1.2.3.4");
    expect(clientAddress(...from("10.0.0.2", { "X-Forwarded-For": "1.2.3.4, garbage" }), xff)).toBe("10.0.0.2");
  });

  test("Cloudflare's header, from a trusted proxy only", () => {
    const cf = { proxies: "172.16.0.0/12", header: "cf-connecting-ip" as const };
    expect(clientAddress(...from("172.18.0.3", { "CF-Connecting-IP": "2001:db8::1" }), cf)).toBe("2001:db8::1");
    expect(clientAddress(...from("198.51.100.1", { "CF-Connecting-IP": "2001:db8::1" }), cf)).toBe("198.51.100.1");
  });

  test("ranges cover IPv4, IPv6, and IPv4-mapped addresses", () => {
    const ranges = rangesOf("10.0.0.0/8, 2001:db8::/32, 127.0.0.1");
    expect(inRanges("10.200.3.4", ranges)).toBe(true);
    expect(inRanges("::ffff:10.1.2.3", ranges)).toBe(true);
    expect(inRanges("2001:db8:ffff::1", ranges)).toBe(true);
    expect(inRanges("2001:db9::1", ranges)).toBe(false);
    expect(inRanges("127.0.0.2", ranges)).toBe(false);
    expect(validRanges("10.0.0.0/8, ::1")).toBe(true);
    expect(validRanges("10.0.0.0/33")).toBe(false);
  });

  test("limits count an IPv6 /64 as one address", () => {
    expect(rateKey("2001:db8:1:2:aaaa::1")).toBe(rateKey("2001:db8:1:2:bbbb::9"));
    expect(rateKey("2001:db8:1:3::1")).not.toBe(rateKey("2001:db8:1:2::1"));
    expect(rateKey("203.0.113.5")).toBe("203.0.113.5");
  });

  test("addresses that wrap a private IPv4 one count as private", () => {
    expect(isPrivateAddress("64:ff9b::a00:1")).toBe(true);
    expect(isPrivateAddress("2002:a00:1::1")).toBe(true);
    expect(isPrivateAddress("198.18.0.1")).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
  });
});
