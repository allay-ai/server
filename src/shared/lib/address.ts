import type { Server } from "bun";
import { isIP } from "node:net";

/** An address as a number with its family, so ranges compare without strings. */
interface Parsed {
  v6: boolean;
  value: bigint;
}

const parseV4 = (ip: string): bigint => ip.split(".").reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n);

const parseV6 = (ip: string): bigint => {
  let text = ip.toLowerCase();
  // A dotted tail, like ::ffff:10.0.0.1, is two groups.
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = parseV4(tail[1]);
    text = `${text.slice(0, -tail[1].length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest !== undefined && rest ? rest.split(":") : [];
  const groups = rest === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.reduce((n, group) => (n << 16n) | BigInt(parseInt(group || "0", 16)), 0n);
};

/** An IPv4-mapped IPv6 address (::ffff:a.b.c.d) counts as the IPv4 address it carries. */
const parse = (ip: string): Parsed | undefined => {
  const bare = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 4) return { v6: false, value: parseV4(bare) };
  if (family !== 6) return undefined;
  const value = parseV6(bare);
  if (value >> 32n === 0xffffn) return { v6: false, value: value & 0xffffffffn };
  return { v6: true, value };
};

interface Range {
  v6: boolean;
  base: bigint;
  bits: number;
}

const rangeOf = (cidr: string): Range | undefined => {
  const [ip, length] = cidr.trim().split("/");
  const parsed = parse(ip);
  if (!parsed) return undefined;
  const max = parsed.v6 ? 128 : 32;
  const bits = length === undefined ? max : Number(length);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return undefined;
  return { v6: parsed.v6, base: parsed.value >> BigInt(max - bits), bits };
};

const inRange = (address: Parsed, range: Range) => {
  if (address.v6 !== range.v6) return false;
  const max = address.v6 ? 128 : 32;
  return address.value >> BigInt(max - range.bits) === range.base;
};

/** Parses a comma-separated list of addresses and CIDR ranges; anything unreadable is left out. */
export const rangesOf = (list: string | undefined): Range[] =>
  (list ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(rangeOf)
    .filter((range): range is Range => !!range);

/** Whether a comma-separated list of addresses and CIDR ranges holds only readable entries; the settings check it. */
export const validRanges = (list: string) => list.split(",").map((p) => p.trim()).filter(Boolean).every((part) => !!rangeOf(part));

export const inRanges = (ip: string, ranges: Range[]) => {
  const address = parse(ip);
  return !!address && ranges.some((range) => inRange(address, range));
};

export type ClientHeader = "x-forwarded-for" | "x-real-ip" | "cf-connecting-ip";

/** Where a request's client address may come from: proxies the operator named, and the header they set. */
export interface ProxyTrust {
  /** TRUSTED_PROXIES: addresses and CIDR ranges of the proxies in front of the backend. Empty trusts nobody. */
  proxies: string | undefined;
  /** CLIENT_IP_HEADER: the header those proxies put the client's address in. */
  header: ClientHeader;
}

/**
 * The client's address. Forwarding headers count only when the peer itself is a trusted proxy: anyone else could
 * write whatever they like into them. X-Forwarded-For is read from the right, skipping trusted proxies, so a value
 * the client wrote at the left end never wins.
 */
export const clientAddress = (req: Request, server: Server<undefined> | undefined, trust: ProxyTrust): string => {
  const peer = server?.requestIP(req)?.address ?? "unknown";
  const ranges = rangesOf(trust.proxies);
  if (!ranges.length || !inRanges(peer, ranges)) return peer;
  if (trust.header === "x-forwarded-for") {
    const hops = (req.headers.get("X-Forwarded-For") ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!parse(hops[i])) return peer;
      if (!inRanges(hops[i], ranges)) return hops[i];
    }
    return hops[0] ?? peer;
  }
  const given = req.headers.get(trust.header)?.trim();
  return given && parse(given) ? given : peer;
};

/** The key a rate limit counts an address under: IPv6 by its /64, which one subscriber usually holds whole. */
export const rateKey = (ip: string): string => {
  const address = parse(ip);
  if (!address) return ip;
  if (!address.v6) return ip;
  return `${(address.value >> 64n).toString(16)}::/64`;
};
