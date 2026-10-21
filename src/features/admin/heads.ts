/**
 * Players' faces for the panel, fetched by the backend: the panel's CSP allows images from itself only, and the
 * viewer's browser never tells a third party which players they look at.
 */

/** mc-heads.net draws the face with the hat layer, by UUID or by name. */
const HEADS_URL = "https://mc-heads.net/avatar";

const SIZE = 64;
const TTL = 6 * 3_600_000;
const MAX = 1_000;

interface Head {
  body: ArrayBuffer;
  type: string;
  at: number;
}

const cache = new Map<string, Head>();

/**
 * Online-mode UUIDs are version 4 and name the skin; offline-mode servers derive version 3 UUIDs from the name,
 * which the skin service doesn't know, so those go by name.
 */
export const headKey = (userId: string, name: string) => (/^[0-9a-f]{8}-?[0-9a-f]{4}-?4[0-9a-f]{3}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(userId) ? userId.replace(/-/g, "") : name);

export const headOf = async (key: string, fetcher: typeof fetch = fetch): Promise<Head | null> => {
  const known = cache.get(key);
  if (known && Date.now() - known.at < TTL) return known;
  try {
    const response = await fetcher(`${HEADS_URL}/${encodeURIComponent(key)}/${SIZE}`, { signal: AbortSignal.timeout(5_000) });
    const type = response.headers.get("Content-Type") ?? "";
    if (!response.ok || !type.startsWith("image/")) return known ?? null;
    const head = { body: await response.arrayBuffer(), type, at: Date.now() };
    if (cache.size >= MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, head);
    return head;
  } catch {
    return known ?? null;
  }
};
