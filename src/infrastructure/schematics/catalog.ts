import { z } from "zod";
import { logger } from "../../shared/logging/logger";
import { settings } from "../../features/settings/settings";

const LANGUAGES = ["en", "ru", "es", "pt", "de"] as const;

const record = z.object({
  id: z.string().regex(/^[a-z0-9-]+(\/[a-z0-9-]+)+$/),
  path: z.string().regex(/^catalog\/[a-z0-9/-]+\/build\.schem$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
  size: z.object({ x: z.number().int().positive(), y: z.number().int().positive(), z: z.number().int().positive() }),
  blocks: z.number().int().nonnegative(),
  kinds: z.number().int().nonnegative(),
  materials: z.array(z.object({ block: z.string(), count: z.number().int() })),
  data_version: z.number().int(),
  author: z.string(),
  source: z.string(),
  license: z.string(),
  title: z.record(z.string(), z.string()).default({}),
  description: z.string().default(""),
  tags: z.object({ type: z.array(z.string()), style: z.array(z.string()), biome: z.array(z.string()), keywords: z.array(z.string()) }).partial().default({}),
});

export type Schematic = z.infer<typeof record>;

const indexSchema = z.object({ version: z.literal(1), schematics: z.array(z.unknown()) });

/** What a search may hold to: a player's limits and the server's game, and what kind of build they asked for. */
export interface Filters {
  maxBlocks?: number;
  maxSide?: number;
  /** The server's game: builds saved by a newer one may hold blocks it lacks. */
  dataVersion?: number;
  type?: string;
  style?: string;
}

export interface Found {
  total: number;
  schematics: Schematic[];
}

/** The catalog Allay offers builds from: allay-ai/schematics, read at the newest commit of master. */
export interface SchematicCatalog {
  search(query: string, filters: Filters, offset: number, limit: number): Promise<Found>;
  /** One build by id, with where to download it from, pinned to the commit the catalog was read at. */
  find(id: string): Promise<(Schematic & { url: string }) | null>;
}

const STOP = new Set(["a", "an", "the", "of", "with", "and", "or", "in", "on", "for", "to", "build", "minecraft"]);

/** Words as the index compares them: lowercase, accents off, a plural's s gone. */
export const words = (text: string): string[] =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !STOP.has(word))
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));

/** Each field's words, repeated by how much a match there counts: the English title most, then tags, then the rest. */
const document = (s: Schematic): string[] => [
  ...Array(3).fill(words(s.title.en ?? "")).flat(),
  ...LANGUAGES.filter((lang) => lang !== "en").flatMap((lang) => words(s.title[lang] ?? "")),
  ...Array(2).fill([...(s.tags.type ?? []), ...(s.tags.style ?? []), ...(s.tags.keywords ?? [])].flatMap(words)).flat(),
  ...(s.tags.biome ?? []).flatMap(words),
  ...words(s.description),
  ...s.materials.slice(0, 6).flatMap((m) => words(m.block.replace(/^minecraft:/, ""))),
];

/** Okapi BM25 over the catalog, rebuilt whenever the index is. */
class Ranking {
  private readonly docs: Array<Map<string, number>>;
  private readonly lengths: number[];
  private readonly frequency = new Map<string, number>();
  private readonly average: number;

  constructor(readonly schematics: Schematic[]) {
    this.docs = schematics.map((s) => {
      const counts = new Map<string, number>();
      for (const word of document(s)) counts.set(word, (counts.get(word) ?? 0) + 1);
      for (const word of counts.keys()) this.frequency.set(word, (this.frequency.get(word) ?? 0) + 1);
      return counts;
    });
    this.lengths = this.docs.map((d) => [...d.values()].reduce((a, b) => a + b, 0));
    this.average = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, this.lengths.length);
  }

  score(index: number, query: string[]): number {
    const k1 = 1.2;
    const b = 0.75;
    const n = this.docs.length;
    let score = 0;
    for (const word of query) {
      const tf = this.docs[index].get(word) ?? 0;
      if (tf === 0) continue;
      const df = this.frequency.get(word) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * this.lengths[index]) / this.average));
    }
    return score;
  }
}

const fits = (s: Schematic, filters: Filters) =>
  (filters.maxBlocks === undefined || s.blocks <= filters.maxBlocks) &&
  (filters.maxSide === undefined || Math.max(s.size.x, s.size.y, s.size.z) <= filters.maxSide) &&
  (filters.dataVersion === undefined || s.data_version <= filters.dataVersion) &&
  (!filters.type || (s.tags.type ?? []).includes(filters.type)) &&
  (!filters.style || (s.tags.style ?? []).includes(filters.style));

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Reads the catalog from GitHub: the commit master points at, then `index.json` at that commit, so every link it hands
 * out stays the file it was. It looks again after SCHEMATICS_REFRESH_SECONDS; while GitHub can't be reached, the last
 * catalog it read serves on.
 */
export const githubCatalog = (fetcher: Fetch = (url, init) => fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) })): SchematicCatalog => {
  let current: { commit: string; ranking: Ranking; byId: Map<string, Schematic> } | undefined;
  let checked = 0;
  let loading: Promise<void> | undefined;

  const raw = (commit: string, path: string) => `https://raw.githubusercontent.com/${settings.get("SCHEMATICS_REPO")}/${commit}/${path}`;

  const refresh = async () => {
    const repo = settings.get("SCHEMATICS_REPO");
    const head = await fetcher(`https://api.github.com/repos/${repo}/commits/master`, { headers: { Accept: "application/vnd.github.sha", "User-Agent": "allay-server" } });
    if (!head.ok) throw new Error(`GitHub answered ${head.status} for the catalog's commit`);
    const commit = (await head.text()).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("GitHub's answer isn't a commit");
    if (current?.commit === commit) return;
    const response = await fetcher(raw(commit, "index.json"));
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for index.json`);
    const index = indexSchema.parse(await response.json());
    // One odd record is dropped, not the catalog.
    const schematics = index.schematics.flatMap((entry) => {
      const parsed = record.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
    current = { commit, ranking: new Ranking(schematics), byId: new Map(schematics.map((s) => [s.id, s])) };
    logger.info(`Schematics catalog at ${commit.slice(0, 7)}: ${schematics.length} builds`);
  };

  const ready = async () => {
    if (Date.now() - checked < settings.get("SCHEMATICS_REFRESH_SECONDS") * 1000 && current) return current;
    loading ??= refresh()
      .catch((error) => logger.warn(`Couldn't read the schematics catalog: ${String(error)}`))
      .finally(() => {
        checked = Date.now();
        loading = undefined;
      });
    await loading;
    if (!current) throw new Error("the schematics catalog is out of reach");
    return current;
  };

  return {
    async search(query, filters, offset, limit) {
      const { ranking } = await ready();
      const asked = words(query);
      const scored = ranking.schematics
        .map((s, index) => ({ s, score: asked.length ? ranking.score(index, asked) : 1 }))
        .filter(({ s, score }) => score > 0 && fits(s, filters))
        .sort((a, b) => b.score - a.score || a.s.id.localeCompare(b.s.id));
      return { total: scored.length, schematics: scored.slice(offset, offset + limit).map(({ s }) => s) };
    },
    async find(id) {
      const { commit, byId } = await ready();
      const found = byId.get(id);
      return found ? { ...found, url: raw(commit, found.path) } : null;
    },
  };
};
