import { describe, expect, test } from "bun:test";
import { githubCatalog, words } from "../src/infrastructure/schematics/catalog";
import type { ChatEvent } from "../src/features/chat/chat.events";
import { searchSchematicsTool } from "../src/features/tools/schematics.tool";
import { gameTools } from "../src/features/tools/game.tools";
import type { ToolBridge } from "../src/features/chat/chat.bridge";

const build = (id: string, extra: Record<string, unknown>) => ({
  id,
  path: `catalog/${id}/build.schem`,
  sha256: "a".repeat(64),
  bytes: 1000,
  size: { x: 9, y: 12, z: 9 },
  blocks: 600,
  kinds: 8,
  materials: [{ block: "minecraft:oak_planks", count: 300 }, { block: "minecraft:cobblestone", count: 200 }],
  data_version: 4440,
  author: "Someone",
  source: "https://example.com",
  license: "CC-BY-4.0",
  ...extra,
});

const INDEX = {
  version: 1,
  schematics: [
    build("mills/medieval-windmill", {
      title: { en: "Medieval Windmill", ru: "Средневековая мельница" },
      description: "A wooden windmill with stone base and four sails.",
      tags: { type: ["farm"], style: ["medieval"], keywords: ["windmill", "mill", "wheat"] },
    }),
    build("houses/japanese-house", {
      title: { en: "Japanese House", ru: "Японский дом" },
      description: "A small house with a curved roof.",
      tags: { type: ["house"], style: ["japanese"], keywords: ["pagoda roof"] },
      blocks: 4000,
      size: { x: 20, y: 10, z: 18 },
    }),
    build("castles/stone-keep", {
      title: { en: "Stone Keep" },
      description: "A medieval castle keep with towers.",
      tags: { type: ["castle"], style: ["medieval"] },
      blocks: 90000,
      size: { x: 80, y: 60, z: 80 },
      data_version: 9999,
    }),
    { id: "broken", nonsense: true },
  ],
};

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const github = (options: { down?: boolean } = {}) => {
  const asked: string[] = [];
  const fetcher = async (url: string) => {
    asked.push(url);
    if (options.down) return new Response("no", { status: 503 });
    if (url.includes("/commits/master")) return new Response(COMMIT);
    if (url.endsWith(`/${COMMIT}/index.json`)) return Response.json(INDEX);
    return new Response("missing", { status: 404 });
  };
  return { asked, catalog: githubCatalog(fetcher) };
};

describe("the build catalog", () => {
  test("words drop accents, plurals, and words that say nothing", () => {
    expect(words("The Medieval Windmills of Minecraft")).toEqual(["medieval", "windmill"]);
    expect(words("Средневековая мельница")).toEqual(["средневековая", "мельница"]);
  });

  test("a search finds the closest build first, in any language its titles have", async () => {
    const { catalog } = github();
    const found = await catalog.search("medieval windmill", {}, 0, 5);
    expect(found.schematics[0].id).toBe("mills/medieval-windmill");
    expect((await catalog.search("мельница", {}, 0, 5)).schematics.map((s) => s.id)).toEqual(["mills/medieval-windmill"]);
    // A record the index can't read is dropped, the rest serve.
    expect((await catalog.search("house castle windmill", {}, 0, 10)).total).toBe(3);
  });

  test("filters keep to what the player may build and the server's game has", async () => {
    const { catalog } = github();
    const medieval = await catalog.search("medieval", { maxBlocks: 50_000 }, 0, 5);
    expect(medieval.schematics.map((s) => s.id)).toEqual(["mills/medieval-windmill"]);
    expect((await catalog.search("castle", { dataVersion: 4440 }, 0, 5)).total).toBe(0);
    expect((await catalog.search("house", { maxSide: 16 }, 0, 5)).total).toBe(0);
    expect((await catalog.search("medieval", { type: "castle" }, 0, 5)).schematics.map((s) => s.id)).toEqual(["castles/stone-keep"]);
  });

  test("a build the describer hasn't tagged yet still turns up by its title under a type and a style", async () => {
    const untagged = { ...INDEX, schematics: [...INDEX.schematics, build("houses/medieval-house-i", { title: { en: "Medieval House I" }, description: "" })] };
    const fetcher = async (url: string) =>
      url.includes("/commits/master") ? new Response(COMMIT) : url.endsWith(`/${COMMIT}/index.json`) ? Response.json(untagged) : new Response("missing", { status: 404 });
    const catalog = githubCatalog(fetcher);
    const found = await catalog.search("medieval house tower", { type: "house", style: "medieval" }, 0, 5);
    expect(found.schematics.map((s) => s.id)[0]).toBe("houses/medieval-house-i");
    // Tags that say otherwise still rule a build out: the Japanese house isn't medieval.
    expect(found.schematics.map((s) => s.id)).not.toContain("houses/japanese-house");
  });

  test("the catalog is read once per refresh, and a build's link is pinned to its commit", async () => {
    const { catalog, asked } = github();
    await catalog.search("windmill", {}, 0, 5);
    await catalog.search("house", {}, 0, 5);
    expect(asked.length).toBe(2);
    const mill = await catalog.find("mills/medieval-windmill");
    expect(mill?.url).toBe(`https://raw.githubusercontent.com/allay-ai/schematics/${COMMIT}/catalog/mills/medieval-windmill/build.schem`);
    expect(await catalog.find("nope/none")).toBeNull();
  });

  test("a catalog GitHub can't serve says so", async () => {
    const { catalog } = github({ down: true });
    await expect(catalog.search("windmill", {}, 0, 5)).rejects.toThrow("out of reach");
  });

  test("the tool answers in the player's language, a page at a time, and says when the catalog is gone", async () => {
    const events: ChatEvent[] = [];
    const tool = searchSchematicsTool(github().catalog, { emit: (e) => events.push(e), locale: "ru_ru" });
    const result = (await tool.execute!({ query: "medieval windmill" } as never, {} as never)) as any;
    expect(result.schematics[0]).toMatchObject({ id: "mills/medieval-windmill", title: "Средневековая мельница", size: "9×12×9", blocks: 600 });
    expect(result.schematics[0].materials[0]).toBe("300 × oak_planks");
    expect(events.map((e) => (e.data as any).state)).toEqual(["started", "finished"]);
    const down = searchSchematicsTool(github({ down: true }).catalog, { emit: () => {} });
    expect(((await down.execute!({ query: "x" } as never, {} as never)) as any).error).toContain("out of reach");
  });

  test("build names a build by id, and the plugin gets its pinned file and hash, never a link from the model", async () => {
    const sent: Array<{ tool: string; args: any }> = [];
    const bridge = { call: async (_run: string, tool: string, args: unknown) => (sent.push({ tool, args }), { ok: true, result: { shown: true } }) } as unknown as ToolBridge;
    const tools = gameTools(["build"], "run", bridge, { offered: ["build"], schematics: github().catalog, locale: "ru_ru" });
    const run = (input: object) => tools.build.execute!(input as never, {} as never);
    await run({ action: "preview", schematic: "mills/medieval-windmill" });
    expect(sent[0].args.schematic).toMatchObject({
      id: "mills/medieval-windmill",
      url: `https://raw.githubusercontent.com/allay-ai/schematics/${COMMIT}/catalog/mills/medieval-windmill/build.schem`,
      sha256: "a".repeat(64),
      title: "Средневековая мельница",
    });
    expect(((await run({ action: "preview", schematic: "made/up" })) as any).error).toContain("no build made/up");
    await run({ action: "rotate", turns: 1, schematic: "https://evil.example/x.schem" });
    expect(sent[1]).toEqual({ tool: "build", args: { action: "rotate", turns: 1 } });
  });
});
