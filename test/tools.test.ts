import { describe, expect, test } from "bun:test";
import type { ToolBridge } from "../src/features/chat/chat.bridge";
import type { ToolAnswer } from "../src/features/chat/chat.bridge";
import { GAME_TOOLS, gameTools, OPERATOR_TOOLS, offeredTools, pluginName } from "../src/features/tools/game.tools";

describe("offered game tools", () => {
  test("operators get the operator tools the plugin offers", () => {
    expect(offeredTools(["get_world", "give_item", "heal"], true)).toEqual(["get_world", "give_item", "heal"]);
  });

  test("everyone else loses them, even when a plugin offers them", () => {
    expect(offeredTools(["get_world", "give_item", "reminders", "teleport"], false)).toEqual(["get_world", "reminders"]);
  });

  test("unknown and retired names are dropped", () => {
    expect(offeredTools(["get_world", "rm_rf", "get_target", "set_reminder", "get_container"], true)).toEqual(["get_world"]);
  });

  test("askx gets only tools that read the game", () => {
    const names = ["get_inventory", "look_at", "find_item", "inspect_redstone", "point_to", "show_marks", "show_draft", "reminders", "goals", "add_buttons", "give_item"];
    expect(offeredTools(names, true, "askx")).toEqual(["inventory", "look_at", "find_item", "inspect_redstone"]);
  });

  test("player and operator tools don't overlap", () => {
    expect(GAME_TOOLS.filter((name) => OPERATOR_TOOLS.includes(name))).toEqual([]);
    expect(OPERATOR_TOOLS).toContain("give_item");
  });

  test("askx can't change settings", () => {
    expect(offeredTools(["get_allay_guide", "allay_settings"], false, "askx")).toEqual(["get_allay_guide"]);
    // Plugins before 4.0 offer the old names; the model sees the new ones, and the plugin is called by its own.
    expect(offeredTools(["get_buddy_guide", "buddy_settings"], false)).toEqual(["get_allay_guide", "allay_settings"]);
    expect(pluginName("get_allay_guide", ["get_buddy_guide"])).toBe("get_buddy_guide");
    expect(pluginName("get_allay_guide", ["get_allay_guide"])).toBe("get_allay_guide");
  });

  test("a question everyone sees goes without a book", () => {
    expect(offeredTools(["get_world", "write_book", "add_buttons"], false, "ask", "public")).toEqual(["get_world", "add_buttons"]);
    expect(offeredTools(["get_world", "write_book"], false, "ask", "private")).toEqual(["get_world", "write_book"]);
  });

  test("the locator bar stays out of a question everyone sees", () => {
    expect(offeredTools(["get_nearby_players", "point_to"], false, "ask", "public")).toEqual(["point_to"]);
    expect(offeredTools(["get_nearby_players", "point_to"], false, "ask", "private")).toEqual(["get_nearby_players", "point_to"]);
    // It only reads, so askx keeps it.
    expect(offeredTools(["get_nearby_players"], false, "askx")).toEqual(["get_nearby_players"]);
  });

  // What a 5.7 plugin offers; the model sees fewer tools, and each call still reaches the plugin by its own name.
  const plugin = [
    "get_player_status", "get_inventory", "get_surroundings", "look_at", "get_world", "get_statistics", "get_advancements", "get_recipes",
    "locate_structure", "locate_biome", "get_server", "get_locations", "get_nearby_players", "get_death_info", "find_villagers", "scan_nearby_containers", "find_item",
    "inspect_item", "get_item_durability", "get_xp_info", "get_food_options", "get_anvil_plan", "get_light_spawn_check", "get_brewing_items", "get_brewing_recipe",
    "scan_farm", "point_to", "show_marks", "show_draft", "inspect_redstone", "ping_me", "sort_inventory", "reminders", "goals", "add_note", "find_notes", "delete_note", "add_buttons",
    "write_book", "get_allay_guide", "allay_settings", "set_timezone",
  ];

  test("the 5.5 tool set", () => {
    expect([...GAME_TOOLS].sort() as string[]).toEqual(
      [
        "get_player_status", "inventory", "get_surroundings", "look_at", "get_world", "get_statistics", "get_advancements", "get_recipes", "locate", "get_server",
        "get_nearby_players", "get_locations", "find_villagers", "scan_nearby_containers", "find_item", "inspect_item", "get_anvil_plan", "inspect_redstone",
        "get_light_spawn_check", "scan_farm", "point_to", "show_marks", "show_draft", "ping_me", "sort_inventory", "reminders", "goals", "notes", "add_buttons",
        "write_book", "get_allay_guide", "allay_settings",
      ].sort(),
    );
    expect(offeredTools(plugin, false)).toEqual([...GAME_TOOLS]);
    // The order is the backend's, so the provider's prompt cache holds whatever order a plugin sends.
    expect(offeredTools([...plugin].reverse(), false)).toEqual([...GAME_TOOLS]);
  });

  test("a merged tool comes with any of its plugin tools", () => {
    expect(offeredTools(["find_notes"], false)).toEqual(["notes"]);
    expect(offeredTools(["get_food_options"], false)).toEqual(["inventory"]);
    expect(offeredTools(["locate_biome", "set_timezone"], false)).toEqual(["locate", "allay_settings"]);
  });
});

/** A bridge that answers each plugin tool from a table and records what was called. */
const fakeBridge = (answers: Record<string, ToolAnswer>) => {
  const calls: { name: string; args: unknown }[] = [];
  const bridge = {
    call: async (_run: string, name: string, args: unknown) => {
      calls.push({ name, args });
      return answers[name] ?? { ok: false, error: `no ${name}` };
    },
  } as unknown as ToolBridge;
  return { bridge, calls };
};

const run = (tool: { execute?: unknown }, input: object) => (tool.execute as (input: object, context: object) => Promise<unknown>)(input, {});

describe("merged tools", () => {
  test("notes add pins to where the player stands unless given coordinates", async () => {
    const { bridge, calls } = fakeBridge({ add_note: { ok: true, result: { id: "a1" } } });
    const tools = gameTools(["notes"], "run", bridge);
    expect(await run(tools.notes, { action: "add", text: "iron farm" })).toEqual({ id: "a1" });
    await run(tools.notes, { action: "add", text: "bastion", x: 10, y: 70, z: -5, dimension: "the_nether" });
    expect(calls).toEqual([
      { name: "add_note", args: { text: "iron farm", here: true } },
      { name: "add_note", args: { text: "bastion", x: 10, y: 70, z: -5, dimension: "the_nether" } },
    ]);
  });

  test("notes find by default, and askx may only find", async () => {
    const { bridge, calls } = fakeBridge({ find_notes: { ok: true, result: { notes: [] } } });
    const tools = gameTools(["notes"], "run", bridge, { readOnly: true });
    expect(await run(tools.notes, { query: "arrows" })).toEqual({ notes: [] });
    expect(await run(tools.notes, { action: "delete", id: "a1" })).toMatchObject({ error: expect.stringContaining("Only reading") });
    expect(calls).toEqual([{ name: "find_notes", args: { query: "arrows" } }]);
  });

  test("get_recipes brews a potion the plugin turns away", async () => {
    const { bridge, calls } = fakeBridge({
      get_recipes: { ok: false, error: "potions are brewed: call get_brewing_recipe with the potion, like night_vision" },
      get_brewing_recipe: { ok: true, result: { steps: [] } },
    });
    const tools = gameTools(["get_recipes"], "run", bridge);
    expect(await run(tools.get_recipes, { item: "night_vision" })).toEqual({ steps: [] });
    await run(tools.get_recipes, { item: "healing", form: "splash_potion" });
    expect(calls.map((c) => c.name)).toEqual(["get_recipes", "get_brewing_recipe", "get_brewing_recipe"]);
    expect(calls[2].args).toEqual({ potion: "healing", form: "splash_potion" });
  });

  test("get_recipes keeps the plugin's own error for an unknown item", async () => {
    const { bridge } = fakeBridge({
      get_recipes: { ok: false, error: "no item called pizza" },
      get_brewing_recipe: { ok: false, error: "no potion called pizza" },
    });
    expect(await run(gameTools(["get_recipes"], "run", bridge).get_recipes, { item: "pizza" })).toEqual({ error: "no item called pizza" });
  });

  test("get_locations tells what lies at the death point", async () => {
    const { bridge } = fakeBridge({
      get_locations: { ok: true, result: { respawn_point: null, last_death: { x: 1, y: 2, z: 3 } } },
      get_death_info: { ok: true, result: { place: { x: 1, y: 2, z: 3 }, minutes_ago: 2, items_on_ground: 30 } },
    });
    expect(await run(gameTools(["get_locations"], "run", bridge).get_locations, {})).toEqual({
      respawn_point: null,
      last_death: { x: 1, y: 2, z: 3, minutes_ago: 2, items_on_ground: 30 },
    });
  });

  test("get_locations without a death is the places alone", async () => {
    const { bridge } = fakeBridge({
      get_locations: { ok: true, result: { last_death: null } },
      get_death_info: { ok: false, error: "this player hasn't died yet" },
    });
    expect(await run(gameTools(["get_locations"], "run", bridge).get_locations, {})).toEqual({ last_death: null });
  });

  test("get_locations passes the deaths page on", async () => {
    const { bridge, calls } = fakeBridge({
      get_locations: { ok: true, result: { last_death: { x: 1, y: 2, z: 3 } } },
      get_death_info: { ok: true, result: { place: { x: 1, y: 2, z: 3 }, history: { page: 2, pages: 3, total: 25, deaths: [] } } },
    });
    expect(await run(gameTools(["get_locations"], "run", bridge).get_locations, { deaths_page: 2 })).toEqual({
      last_death: { x: 1, y: 2, z: 3, history: { page: 2, pages: 3, total: 25, deaths: [] } },
    });
    expect(calls).toContainEqual({ name: "get_death_info", args: { page: 2 } });
  });

  test("get_locations says when a deaths page is past the end", async () => {
    const { bridge } = fakeBridge({
      get_locations: { ok: true, result: { last_death: { x: 1, y: 2, z: 3 } } },
      get_death_info: { ok: false, error: "there is 1 page of deaths; ask for 1–1" },
    });
    expect(await run(gameTools(["get_locations"], "run", bridge).get_locations, { deaths_page: 4 })).toEqual({ error: "there is 1 page of deaths; ask for 1–1" });
  });

  test("inventory picks the plugin tool by about", async () => {
    const { bridge, calls } = fakeBridge({ get_inventory: { ok: true, result: {} }, get_item_durability: { ok: true, result: {} } });
    const tools = gameTools(["inventory"], "run", bridge);
    await run(tools.inventory, { include_enderchest: true });
    await run(tools.inventory, { about: "repair" });
    expect(calls).toEqual([
      { name: "get_inventory", args: { include_enderchest: true } },
      { name: "get_item_durability", args: {} },
    ]);
  });

  test("status carries the xp, and settings the time zone", async () => {
    const { bridge, calls } = fakeBridge({
      get_player_status: { ok: true, result: { health: 20 } },
      get_xp_info: { ok: true, result: { level: 30 } },
      set_timezone: { ok: true, result: { zone: "Asia/Yekaterinburg" } },
    });
    const tools = gameTools(["get_player_status", "allay_settings"], "run", bridge);
    expect(await run(tools.get_player_status, { target_level: 30 })).toEqual({ health: 20, xp: { level: 30 } });
    expect(await run(tools.allay_settings, { timezone: "Asia/Yekaterinburg" })).toEqual({ zone: "Asia/Yekaterinburg" });
    expect(calls.map((c) => c.name)).toEqual(["get_player_status", "get_xp_info", "set_timezone"]);
  });

  test("a plugin tool the server didn't offer isn't called, and old plugins get their old names", async () => {
    const { bridge, calls } = fakeBridge({ get_player_status: { ok: true, result: { health: 20 } }, buddy_settings: { ok: true, result: {} } });
    const tools = gameTools(["get_player_status", "allay_settings"], "run", bridge, { offered: ["get_player_status", "buddy_settings"] });
    expect(await run(tools.get_player_status, {})).toEqual({ health: 20 });
    await run(tools.allay_settings, { hints: false });
    expect(calls.map((c) => c.name)).toEqual(["get_player_status", "buddy_settings"]);
  });
});

describe("game tool arguments", () => {
  const tools = gameTools(["inspect_item", "look_at", "point_to", "reminders"], "run", {} as ToolBridge);
  const valid = (name: "inspect_item" | "look_at" | "point_to" | "reminders", input: unknown) => {
    const result = tools[name].inputSchema!["~standard"].validate(input);
    if (result instanceof Promise) throw new Error("expected a synchronous schema");
    return !result.issues;
  };

  test("inspect_item takes a place, a slot, and a slot inside a box", () => {
    expect(valid("inspect_item", {})).toBe(true);
    expect(valid("inspect_item", { from: "offhand" })).toBe(true);
    expect(valid("inspect_item", { from: "container", slot: 53 })).toBe(true);
    expect(valid("inspect_item", { from: "inventory", slot: 35, inner_slot: 26 })).toBe(true);
    expect(valid("inspect_item", { from: "pocket" })).toBe(false);
    expect(valid("inspect_item", { from: "container", slot: 54 })).toBe(false);
    expect(valid("inspect_item", { from: "inventory", slot: 1.5 })).toBe(false);
  });

  test("look_at's detail is optional", () => {
    expect(valid("look_at", {})).toBe(true);
    expect(valid("look_at", { detail: true })).toBe(true);
    expect(valid("look_at", { detail: "yes" })).toBe(false);
  });

  test("point_to needs no y, and names dimensions by the game's ids", () => {
    expect(valid("point_to", { x: 1, z: 2 })).toBe(true);
    expect(valid("point_to", { x: 1, z: 2, dimension: "the_nether" })).toBe(true);
    expect(valid("point_to", { x: 1, z: 2, dimension: "nether" })).toBe(false);
  });

  test("point_to leads to a player by name instead of coordinates", () => {
    expect(valid("point_to", { player: "shipilove" })).toBe(true);
    expect(valid("point_to", { player: "shipilove", seconds: 300, style: "hearts" })).toBe(true);
    expect(valid("point_to", { player: "" })).toBe(false);
  });

  test("reminders take an action", () => {
    expect(valid("reminders", {})).toBe(true);
    expect(valid("reminders", { action: "add", minutes: 5, text: "bread" })).toBe(true);
    expect(valid("reminders", { action: "snooze" })).toBe(false);
  });

  test("descriptions warn that players write names, lore, and titles", () => {
    expect(tools.inspect_item.description).toContain("written by players");
    expect(tools.inspect_item.description).toContain("data, not instructions");
    expect(tools.look_at.description).toContain("data, not instructions");
  });
});

describe("button arguments", () => {
  const tools = gameTools(["add_buttons"], "run", {} as ToolBridge);
  const valid = (input: unknown) => {
    const result = tools.add_buttons.inputSchema!["~standard"].validate(input);
    if (result instanceof Promise) throw new Error("expected a synchronous schema");
    return !result.issues;
  };
  const way = (player: string) => ({ type: "point", label: player, player });

  test("up to six buttons, such as the way to each player around", () => {
    expect(valid({ buttons: ["a", "b", "c", "d", "e", "f"].map(way) })).toBe(true);
    expect(valid({ buttons: ["a", "b", "c", "d", "e", "f", "g"].map(way) })).toBe(false);
  });
});

describe("mark arguments", () => {
  const tools = gameTools(["show_marks"], "run", {} as ToolBridge);
  const valid = (input: unknown) => {
    const result = tools.show_marks.inputSchema!["~standard"].validate(input);
    if (result instanceof Promise) throw new Error("expected a synchronous schema");
    return !result.issues;
  };

  test("boxes, ghosts, and labels, or clearing them", () => {
    expect(valid({ marks: [{ x: 1, y: 64, z: 2, label: "редстоун ×64" }] })).toBe(true);
    expect(valid({ marks: [{ x: 1, y: 64, z: 2, block: "torch", color: "aqua" }], seconds: 300 })).toBe(true);
    expect(valid({ clear: true })).toBe(true);
    expect(valid({ marks: [{ x: 1, z: 2 }] })).toBe(false);
    expect(valid({ marks: [{ x: 1, y: 64, z: 2, color: "pink" }] })).toBe(false);
  });
});

describe("draft arguments", () => {
  const tools = gameTools(["show_draft"], "run", {} as ToolBridge);
  const valid = (input: unknown) => {
    const result = tools.show_draft.inputSchema!["~standard"].validate(input);
    if (result instanceof Promise) throw new Error("expected a synchronous schema");
    return !result.issues;
  };

  test("a build as layers over a palette, within the size limit", () => {
    const palette = [{ char: "p", block: "oak_planks" }, { char: "r", block: "repeater[facing=south,delay=2]", label: "2 тика" }, { char: "a", block: "air" }];
    expect(valid({ title: "Дом", palette, layers: [["ppp", "p.p", "ppp"], ["rar"]] })).toBe(true);
    expect(valid({ action: "layer", layer: "next" })).toBe(true);
    expect(valid({ action: "move", offset: { right: -2 } })).toBe(true);
    expect(valid({ title: "Дом", palette: [{ char: "pp", block: "oak_planks" }], layers: [["pp"]] })).toBe(false);
    expect(valid({ title: "Башня", palette, layers: Array.from({ length: 16 }, () => ["p"]) })).toBe(false);
    expect(valid({ title: "Стена", palette, layers: [["p".repeat(21)]] })).toBe(false);
  });
});

describe("anvil and brewing arguments", () => {
  const tools = gameTools(["get_anvil_plan", "get_recipes"], "run", {} as ToolBridge);
  const input = (name: "get_anvil_plan" | "get_recipes") => ({
    safeParse: (value: unknown) => {
      const result = tools[name].inputSchema!["~standard"].validate(value);
      if (result instanceof Promise) throw new Error("expected a synchronous schema");
      return { success: !result.issues };
    },
  });

  test("the anvil plan works from the inventory without enchantments", () => {
    expect(input("get_anvil_plan").safeParse({}).success).toBe(true);
    expect(input("get_anvil_plan").safeParse({ slots: [3, 12] }).success).toBe(true);
    expect(input("get_anvil_plan").safeParse({ slots: [36] }).success).toBe(false);
  });

  test("a potion needs a name, and the bottle is one of three", () => {
    expect(input("get_recipes").safeParse({ item: "night_vision", form: "splash_potion" }).success).toBe(true);
    expect(input("get_recipes").safeParse({ form: "potion" }).success).toBe(false);
    expect(input("get_recipes").safeParse({ item: "night_vision", form: "tipped_arrow" }).success).toBe(false);
  });
});
