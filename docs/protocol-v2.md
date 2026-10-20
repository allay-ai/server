# Allay streaming protocol v2

The plugin opens one streaming request per question. The backend agent (Mastra) streams back what it is doing, and when it needs to know something about the game it asks the plugin to run a tool and post the result back. Web search runs on the backend.

Server 6.0 keeps the paths and the bodies of v2 but breaks one thing on purpose: **every request identifies its server.** A plugin before 6.0 (Allay 5.x) gets `401` from a 6.0 backend until it sends the credentials below.

## Who is asking

Since 6.0. Every endpoint below wants `Authorization: Bearer …`, except `GET /api/health`, `POST /api/v2/license` without a license, and Telegram's webhook:

- **A hosted backend** (billing on) wants the server's license, `<license id>.<secret>`. A license only identifies: a server that brings its own key (BYOK) gets one free from `POST /api/v2/license` and sends it next to `X-Provider-Key`; paying for it is what turns on the backend's own key.
- **A self-hosted backend** (`SELFHOSTED=1`) wants its `PLUGIN_TOKEN`, a secret of at least 24 characters the operator sets in the backend's environment and in the plugin's `server.token`. A backend without one answers no plugin at all (`503 TOKEN_NOT_SET`), never everyone.

| Code | Status | Meaning |
|---|---|---|
| `LICENSE_REQUIRED` | 401 | A hosted backend got no `Authorization` (before 6.0: 402 without a key) |
| `LICENSE_INVALID` | 401 | Unknown license or wrong secret |
| `TOKEN_REQUIRED` | 401 | A self-hosted backend got no token |
| `TOKEN_INVALID` | 401 | The token isn't the backend's `PLUGIN_TOKEN` |
| `TOKEN_NOT_SET` | 503 | The self-hosted backend has no `PLUGIN_TOKEN` of 24 characters or more |

The caller's **tenant** is `license:<id>` on a hosted backend and `self` on a self-hosted one. Every piece of player data is kept by tenant and `user_id`: a caller names any `user_id` it likes, but only ever reaches the players of its own tenant. The same Minecraft account on two servers is two players who never meet. Rate limits count per tenant, never per anything the body claims.

`user_id` is 1–64 letters, digits, `-`, or `_` (a UUID, `console`); anything else is `400`.

## Request

`POST /api/v2/chat`

Headers: `Content-Type: application/json`, `Accept: text/event-stream`, `X-Plugin-Version`, `Authorization` (see “Who is asking”), and for the server's own key `X-Provider-Key` with a `provider` block (since 5.0, see “Providers and billing”). The v1 header `X-OpenRouter-Token` still works as such a key with the default models.

```json
{
  "mode": "ask",                      // "ask" answers a question; "askx" turns a request into commands; "task" wakes an automation agent (since 5.5)
  "visibility": "private",            // "public" when every player online sees the question and the answer (since 3.0)
  "message": "what should I do next?", // ≤ 1000 chars for ask, ≤ 500 for askx, ≤ 2000 for task
  "platform": "minecraft",
  "user_id": "5627dd98-e6be-3c21-b8a8-e92344183641",
  "locale": "ru_ru",
  "timezone": "Europe/Moscow",
  "player": { "name": "Steve", "uuid": "5627dd98-…", "op": false, "dimension": "the_nether" },
  "server": { "id": "0f8c…", "software": "Paper", "version": "26.3", "plugin_version": "3.0.0" },
  "tools": ["get_player_status", "get_inventory", "get_surroundings", "look_at", "get_world", "get_statistics", "get_advancements", "get_recipes", "locate_structure", "get_server"]
}
```

`timezone` is the asker's IANA time zone (optional, since 2.3). The backend puts their real date and time in front of each `ask` question, as `[Mon, 12 Oct 2026, 23:42 Europe/Moscow] question`, and keeps it in the session history; without it the time is UTC.

`visibility` (since 3.0) is `private` by default. `public` marks a question from `/askall` or `?` in chat mode: the plugin shows the question and the answer to every player online, the prompt tells the model so, and the run goes without `write_book`. `askx` is always private. A public question reads and extends the server's shared thread instead of the asker's session (see “Conversation memory”); `server.id`, a random id the plugin keeps for its server, names that thread within the caller's tenant (since 6.0: another server sending the same id reaches its own thread, not this one).

`player.dimension` (optional, since 5.1) is the dimension the player stood in when they asked: `overworld`, `the_nether`, or `the_end`. The prompt tells the model, so a place named without a dimension lands where the player is; any other value is dropped.

`tools` lists the client tools this plugin offers (server admins can switch some off). The backend registers only those for this run. The plugin lists operator tools only when the asking player is an operator, and the backend drops them anyway when `player.op` is false. An `askx` run gets only the tools that read the game: no actions (`point_to`, `show_marks`, `reminders`, `goals`, notes, buttons, books, automations) and no operator tools. Since 5.5 the backend also sorts the automation tools by mode (see “Automation agents”): `ask` keeps `start_task`, `message_task`, and `cancel_task` and drops the ones only agents use; a public `ask` drops those three too.

`tasks` (optional, since 5.5) lists the asker's running automations, at most 4: `[{ "id": "k3f9", "name": "Furnaces", "state": "working" | "waiting" | "asking", "question"?: "≤ 200 chars" }]`. `id` is `[a-z0-9]{1,16}`, `name` ≤ 40 chars, `question` what a task in state `asking` asked the player. Since plugin 5.14, `asking` means the agent showed buttons or a picking mode, said a line with a question mark, or said a line with no job and no sub-agent left to wake it; a line said while a job runs (“smelting takes 3 minutes”) leaves it `waiting`. Its `question` stays until the player answers (`[player]`, `[button]`, or the end of picking), so a `[job]` or `[timer]` wake in between doesn't drop it. The prompt shows them to the model as data, so it can pass a free-text answer on with `message_task`. Since 5.10.1, `task` mode takes it too: there it lists the waking agent's own running sub-agents, so the agent never claims an ended one still works. `askx` ignores it.

`task` (required with `mode: "task"`, since 5.5) names the automation agent the run wakes: `{ "id": "k3f9", "name": "Сортировка сундуков", "depth": 1 | 2, "kind": "chests" | "furnaces" | "brewing" | "crafting" }`, with the same limits on `id` and `name`. A task run is always private; `ask` and `askx` ignore the field.

## Response: Server-Sent Events

`Content-Type: text/event-stream`. Every event is `event: <name>` + `data: <json>`. A `: ping` comment goes out every 15 s.

| Event | Data | Meaning |
|---|---|---|
| `start` | `{ "run_id": "uuid", "model": "…" }` | The run began; `run_id` addresses tool results |
| `reasoning` | `{ "delta": "…" }` | A piece of the model's reasoning, when the model exposes it |
| `tool_call` | `{ "call_id": "…", "name": "get_inventory", "args": { … } }` | The plugin must run this client tool and post the result |
| `tool_status` | `{ "call_id": "…", "name": "search_web", "kind": "client" \| "server", "state": "started" \| "finished" \| "failed", "args": { … }, "summary": "5 sources", "summary_key"?: "sources", "summary_values"?: { "count": 5 } }` | Progress of any tool, for display. Client tools get `started` right before `tool_call`. Since 2.4, server tools add `summary_key` and `summary_values` so the plugin can show the summary in the player's language; `summary` stays in English |
| `text` | `{ "delta": "…" }` | A piece of the answer. In task mode, a piece of the agent's note to itself: don't show it |
| `commands` | `{ "is_sequence": true, "commands": ["give @s diamond_sword 1"] }` | askx only: the commands to run (≤ 12, no leading slash) |
| `usage` | `{ "input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0, "cost": 0.0 }` | Totals for the run so far: sent after every model step and once more, final, right before `done`. Each one replaces the last |
| `done` | `{ "answer": "full text", "duration_ms": 5321 }` | The run finished; for askx `answer` may be a short note; for task it is the agent's note to itself, often empty |
| `error` | `{ "code": "AI_REQUEST_FAILED", "message": "…" }` | The run failed; the stream ends after it. Codes stay compatible with v1 (`QUESTION_TOO_LONG`, `NETWORK_ERROR`, …) plus `TOOL_TIMEOUT`, `RUN_NOT_FOUND` |

## Tool results

`POST /api/v2/chat/{run_id}/tools/{call_id}` with

```json
{ "ok": true, "result": { … } }
{ "ok": false, "error": "player is offline" }
```

with the same `Authorization` as the question. Answers: `200 { "accepted": true }`, `401` without credentials, `404` unknown or finished run or call, or another tenant's run (since 6.0), `409` already answered. The backend waits up to 15 s per client call; past that the model gets an error result and the run goes on.

## Client tools (run by the plugin, on the server thread, about the asking player only)

2.4 merged and reshaped tools, and the backend serves only the 2.4 set: plugins before 2.4 lose the tools whose names changed. Since backend 5.5 the model sees some of these as one tool (`notes` for the three note tools, `inventory` for `get_inventory`, `get_item_durability`, `get_food_options`, and `get_brewing_items`, `locate` for both locate tools, `get_recipes` with `get_brewing_recipe`, `get_locations` with `get_death_info`, `get_player_status` with `get_xp_info`, `allay_settings` with `set_timezone`), but the backend still calls the plugin by the names below, so nothing changes for a plugin. Every spot comes as absolute `x`, `y`, `z` with `distance` (horizontal, in blocks) and `direction` (north, north-east…); dimensions are `overworld`, `the_nether`, `the_end`, and tools accept Bukkit's old `normal` and `nether` too.

| Name | Args | Returns |
|---|---|---|
| `get_player_status` | – | gamemode, health, max_health, food, saturation, level, level_progress, x, y, z, dimension, biome, light, facing, flying, effects [{type, level, seconds}], held_item |
| `get_inventory` | `{ "include_enderchest"?: bool }` | main [item], armor {head, chest, legs, feet}, offhand, and inside_containers {id: count} with what the shulker boxes and bundles in main and offhand hold; with `include_enderchest`, enderchest [item] and enderchest_inside_containers. Items as in “Items” below |
| `get_surroundings` | `{ "radius"?: 1–16 }` default 8 | radius, blocks {id: count} (top 12), notable [{id, x, y, z, distance, direction}] (ores, chests, spawners, portals; 15 nearest), entities [{type, count, nearest, hostile?}] within 32 blocks, other_players (a count only) |
| `look_at` | `{ "detail"?: bool }` | What's under the crosshair. `kind: "nothing"`; or `kind: "block"` (within 6): id, state?, x, y, z, distance, hardness, blast_resistance, preferred_tool?, needs_tier?, held_tool_is_right, break_seconds?, drops_with_held_item [item], age/max_age?, waterlogged?, block_light, sky_light, plus container {name?, slots, used_slots, items {id: count}, more_kinds?, inside_shulker_boxes?, inside_bundles?} — or with `detail`, stacks [item with slot] up to 54 and more_stacks — and enchanting {bookshelves, counted_max, top_offer_min_level, top_offer_max_level, player_level, lapis_in_inventory}; or `kind: "entity"` (within 16): type, name?, distance, item? (dropped items, item frames), for living ones health, max_health, armor, attack_damage?, hostile, your_hit {weapon, damage_per_hit, hits_to_kill?, estimate}, for traders profession, level?, trades [trade]. Another player is only `{kind, type: "player", distance}`. Since plugin 5.5, a container the asker couldn't open comes with `locked` (why) instead of `container` |
| `get_world` | – | dimension, time, phase, day, moon, weather, difficulty, rules {…}, border |
| `get_statistics` | – | play_time_hours, deaths, mob_kills, player_kills, walked_km, flown_km, jumps, fish_caught, minutes_since_death, minutes_since_rest |
| `get_advancements` | `{ "filter"?: "todo" \| "done" \| "all" }` default todo | done_count, todo_count, and up to 40 per list: todo and/or done [{key, title, description, started?}]; `key` is what `goals` takes for an advancement |
| `get_recipes` | `{ "item": "beacon" }` | item, recipes [{type, shape?, key?, ingredients?, input?, seconds?, experience?, template?, base?, addition?, makes?}] up to 5, more_recipes. Crafting, cooking, stonecutting, and smithing only |
| `locate_structure` | `{ "structure": "village" }` | `{ found, structure, x, z, distance, direction }` within `tools.locate_structure_radius` chunks, or `{ found: false, radius_blocks }` |
| `locate_biome` | `{ "biome": "cherry_grove" }` | `{ found, biome, x, y, z, distance, direction }` within `tools.locate_biome_radius` blocks, searched like `/locate biome`; a part of a name matches |
| `get_server` | – | software, version, online, max_players, plugin_version, plugins [{name, version, description?}]: the enabled plugins, minus those the admin hides in `tools.server.hidden_plugins`; description ≤ 120 chars (since 3.0) |
| `get_locations` | – | respawn_point, world_spawn, last_death: each {x, y, z, dimension, distance?, direction?} or null |
| `get_nearby_players` | – | Since plugin 5.4. The asker's locator bar, by the game's rules: players in the asker's dimension with a transmit range above 0 (crouching, a carved pumpkin or a mob head, and invisibility make it 0) and within both players' ranges; a spectator sees all who transmit, nobody sees a spectator. Vanished players stay hidden. `{ locator_bar, players [{name, distance, direction, height?: "above" \| "below"}] nearest first, others_online [name] }`; `locator_bar` is the game rule in the asker's world. Private: a public run doesn't get it |
| `get_death_info` | – | place {x, y, z, dimension, distance?, direction?}, minutes_ago, kept_inventory, dropped {id: count}, dropped_experience, area_loaded, items_on_ground and seconds_until_first_despawn when loaded. Drops are known only since the last plugin start |
| `find_villagers` | `{ "item"?: "enchanted_book", "profession"?: "librarian", "radius"?: 4–64 }` | radius, villagers (up to 10, nearest first) [{profession, level?, x, y, z, distance, direction, trades [trade] (up to 10; with `item`, only those trades)}] |
| `scan_nearby_containers` | `{ "radius"?: 1–52 }` default 32 (1–24, default 16, in plugin 5.14.1; 1–12, default 8, before it; older plugins clamp) | radius, containers (20 nearest) [{type, x, y, z, distance, direction, name?, used_slots, top {id: count}, inside_containers?}], more_containers. Since plugin 5.5, only containers the asker could open: outside a GriefPrevention claim or with container trust in it, and never an unopened structure chest. Since plugin 5.7 a double chest counts once, the containers found glow for the asker with a label (`highlighted`), and a way button goes under the answer when the nearest is far or out of sight |
| `find_item` | `{ "item": "diamond", "radius"?: 1–52 }` default 32 (1–24, default 16, in plugin 5.14.1; 1–12, default 8, before it; older plugins clamp) | query, matched_ids (when `item` isn't an exact id and matched as part of ids), total, radius, places (up to 30) [{where: inventory \| offhand \| armor \| enderchest, slot, count, inside?} or {where: container, type, x, y, z, distance, direction, name?, count, inside_boxes?}], more_places. Counts shulker boxes and bundles one level deep. Since plugin 5.5, only containers the asker could open: outside a GriefPrevention claim or with container trust in it, and never an unopened structure chest. Since plugin 5.7 a double chest counts once, the containers found glow for the asker with a label (`highlighted`), and a way button goes under the answer when the nearest is far or out of sight |
| `inspect_item` | `{ "from"?: "hand" \| "offhand" \| "head" \| "chest" \| "legs" \| "feet" \| "inventory" \| "enderchest" \| "container", "slot"?: 0–53, "inner_slot"?: 0–63 }` | One item in full: `from`, `slot`, with `inner_slot` also `inside` and `inner_slot`, then everything an item has (below), plus lore (≤ 10 lines), unbreakable, attributes [{attribute, amount, operation, slot}], tooltip {attack_damage, attack_speed}, effects [{type, level, seconds \| instant}], dye_color, repair_cost, book {title?, author?, generation?, pages}, firework {flight?, explosions [{shape, colors, fade_colors?, trail?, twinkle?}]}, map {scale_level, blocks_per_side, center_x, center_z, dimension, locked, player_inside}, contents [item with slot] up to 27 and more_stacks. `slot` is required for inventory (0–35), enderchest (0–26), and container (the one under the crosshair, 6 blocks); `inner_slot` reads that slot inside the shulker box or bundle found there |
| `get_item_durability` | – | items [{from, slot?, id, damage, max_damage, percent_left, unbreaking?, expected_uses?, mending?, almost_broken?}] for armor, offhand, and every inventory slot (0–8 the hotbar) |
| `get_xp_info` | `{ "target_level"?: 0–100 }` | level, progress, total_points, points_to_next_level, target_level?, points_to_target? |
| `get_food_options` | – | food, saturation, food_missing, foods [{id, count, nutrition, saturation, note?}] |
| `get_anvil_plan` | `{ "enchantments"?: { "sharpness": 5, "mending": 1 }, "slots"?: [0–35] }` | For the item in hand. With `enchantments`: ideal books, as item, item_repair_cost, steps [{left, right, levels}] where pieces are `item` or `<enchantment> <level>`, total_levels, too_expensive. Without (plugin 5.3+): what the player has, the enchanted books and enchanted items of the same kind in the inventory (or only `slots`), priced as the game does: found, item, pieces [{piece: `hand` \| `hotbar N` \| `inventory row R column C`, slot?, kind, enchantments, repair_cost}], steps [{left, right, levels, gives}], result, total_levels, too_expensive, unused?; `{ found: false, reason }` when nothing improves the item |
| `inspect_redstone` | `{ "radius"?: 1–10, "around"?: "look" \| "player" }` default 6, look | Since plugin 5.6. Every redstone part within the radius (80 nearest the center): `{ id, x, y, z, … }` with dust `power` and `connects`, repeaters `input_from`, `outputs`, `delay_ticks`, `powered`, `locked`?, comparators `mode`, observers `watches`, pistons `pushes`, `extended`, `sticky`, and `received` for mechanisms; `issues [{ id, x, y, z, issue, detail }]` with `dust_dot`, `torch_burned_out`, `piston_jammed`, `hopper_locked`, `repeater_locked`, `dust_runs_past`. Only blocks where the asker may build (outside claims, or with build trust in GriefPrevention); refused when the center is in someone else's claim |
| `get_light_spawn_check` | `{ "radius"?: 1–16 }` default 8 | radius, dark_spots (solid floor, two free blocks, block light 0, within ±6 height), nearest [{x, y, z, distance, direction}] (10), rule |
| `get_brewing_recipe` | `{ "potion": "night_vision", "form"?: "potion" \| "splash_potion" \| "lingering_potion" }` | Since plugin 5.3, read from the game's brewing recipes (26.3 keeps them as data): potion, form, steps [{bottle, add, makes}] from a water bottle, fuel. Drink first, then gunpowder and dragon's breath turn the bottle |
| `get_brewing_items` | – | inventory [item] for brewing, brewing_stands (up to 4 within 8 blocks) [{x, y, z, distance, direction, fuel_level, seconds_left?, ingredient?, fuel?, bottles}] |
| `scan_farm` | `{ "radius"?: 1–16 }` default 8 | radius, crops {id: {total, ripe, max_age, by_age}}, farmland {hydrated, dry}, composter_levels?, hoppers?, spawners? {mob: count}, animals {type: count}, within ±4 height |
| `point_to` | `{ "x", "z", "y"?, "dimension"?, "label"?, "seconds"?: 1–3600, "style"? }` or `{ "player", "seconds"?, "style"? }` | Points the compass and draws a trail only the player sees. Since plugin 5.3: `seconds` up to `tools.point_to.max_seconds` (600 by default; older plugins allow 30 and refuse more), 30 by default; the trail ends when the player arrives, and a new one replaces the old. `style` is `sparkle` (default), `flame`, `soul`, `glow`, `magic`, `spark`, `cherry`, `notes`, `hearts`, `snow`, `totem`, or `happy`; older plugins ignore it. A `dimension` other than the player's is refused. Returns `{ distance, direction, seconds?, style?, compass }`. Since plugin 5.4, `player` instead of `x` and `z`: a trail that follows that player while they're on the asker's locator bar (as `get_nearby_players` says), goes dark while they hide, and ends when the asker reaches them, when they leave, or after 15 s off the bar; `seconds` defaults to `tools.point_to.follow_seconds` (180). A player off the bar is refused. Returns `{ player, distance, direction, seconds, style, follows, compass }` |
| `show_marks` | `{ "marks"?: [{ "x", "y", "z", "block"?, "label"?: "≤ 48", "color"? }] (≤ 64), "seconds"?, "clear"?: true }` | Since plugin 5.5. Display entities only the asker sees, glowing through walls: a stained-glass box hugging the block there, or with `block`, a smaller ghost of that block on a free spot, each with an optional text label. `color` is `yellow` (boxes by default), `green`, `red`, `blue`, `aqua` (ghosts by default), `purple`, `orange`, or `white`. Refused per mark: farther than `tools.show_marks.radius` (48), ores, spawners, and vaults, containers the asker couldn't open (a GriefPrevention claim without container trust, or an unopened structure chest), a ghost on an occupied block. A new call replaces the set; they go after `seconds` (`tools.show_marks.default_seconds` 120, at most `max_seconds` 600), on `/allay cancel`, or when the player leaves; a ghost goes out once the player places a block on it. Returns `{ shown, seconds, refused?: [{x, y, z, reason}] }`, or `{ cleared }` |
| `show_draft` | `{ "action"?: "show" \| "add" \| "layer" \| "move" \| "rotate" \| "check" \| "clear", "title"?, "palette"?: [{ "char", "block": "id[states]", "label"? }], "layers"?: [[row]], "offset"?: { "right"?, "up"?, "forward"? }, "x"?, "y"?, "z"?, "y_offset"?, "layer"?: 1–15 \| "next" \| "prev" \| "all", "turns"?: 1–3 }` | Since plugin 5.6. A build up to 20 × 15 × 20 (width × height × depth) as ghosts only the asker sees, one layer at a time; the plugin checks the layer every 10 ticks, puts a red box with what belongs there on a wrong block, moves on when a layer is done, and counts in a boss bar. Written facing north: `right` east, `forward` north; layers bottom up, rows far to near, characters left to right; `.` or a space leaves a cell alone, `air` must stay empty. Only the states a palette entry spells out are checked (dust's are never). Labels show for entries used at most 6 times. `show` starts two blocks ahead, centered, at the feet plus `y_offset`, or at the corner `x`, `y`, `z`, and replaces the old draft; `add` merges cells at a non-negative `offset`; `move` shifts by `offset`; `rotate` turns clockwise around the middle; `check` returns `{ title, done, total, layers [{layer, done, total}], wrong [{layer, x, y, z, wanted, found}] (20) }`. Refused in a claim where the asker may not build, farther than 32 blocks, or over the size. One draft per player, in memory: `/allay cancel`, leaving, or a restart drops it. Returns `{ title, size, blocks, layer, corner, facing }` |
| `ping_me` | – | Note particles and a sound over the player that everyone nearby sees and hears; `{ pinged, y }` |
| `sort_inventory` | `{ "undo"?: bool (5.11+), "hotbar"?: bool, "offhand"?: bool, "pins"?: [{ "slot": 1–9 \| "inventory:1"–"inventory:27" (5.8+) \| "offhand", "item": "sword" \| "golden_apple" \| "potion:healing" }] }` (since plugin 5.7) | Merges stacks and sorts slots 9–35 by id, plus the hotbar and offhand when asked; pins put the best matching item (an id or a group) in a slot first. Since plugin 5.7.1 a sorted hotbar holds the pins (or, without pins, its hand items) and takes other items only when the main inventory is full; `layout` (5.8+): `{ order?, zones?: [{ items, where: row:N \| row:last \| column:N \| column:last \| slots:A-B \| start \| end }], by?: name \| category \| count, rows?, keep?, merge_only? }`, items as ids, groups, materials, categories, enchanted, named, damaged. `{ merged_stacks, pinned?, not_found?, hotbar, offhand, rows }`; `undo` puts back the last sort or chest change and returns `{ restored, chests_restored? }`, hotbar as 9 ids or null (5.7.1+), rows as the main inventory's 3 rows of 9 (5.8+) |
| `reminders` | `{ "action"?: "add" \| "list" \| "cancel", "minutes"?: 1–120, "text"?: "≤ 100", "id"?, "all"? }` | add: `{ id, minutes, text }`, a chat line with a sound after the delay (10 pending per player by default, `tools.reminders.max_pending`; lost on a restart or when the player leaves). list (default): `{ reminders: [{id, text, minutes_left, due_at}] }`. cancel by `id` or `all`: `{ cancelled }` |
| `goals` | `{ "action"?: "set" \| "list" \| "cancel", "kind"?, "title"?, "target"?, "statistic"?, "item"?, "entity"?, "advancement"?, "x"?, "z"?, "radius"?, "biome"?, "dimension"?, "color"?, "style"?, "id"?, "all"? }` | set: a boss bar goal counted from now; kinds `stat`, `pickup`, `level`, `advancement`, `reach`, `biome`, `dimension`; statistics in centimeters take `target` in blocks; ends with a sound and a chat line; returns `{ id, kind, title, progress, target }`. list (default): `{ goals: [{id, kind, title, progress, target, done?}] }`. cancel by `id` or `all`: `{ cancelled }` |
| `add_note` | `{ "text": "≤ 200", "here"?: true, "x"?, "y"?, "z"?, "dimension"? }` | A note kept on disk (200 per player by default, `tools.notes.max_per_player`). By default where the player stands; with `here: false`, the given `x`, `z` (and optional `y`, `dimension`), or no place at all. Returns `{ id, text, x?, y?, z?, dimension? }` |
| `find_notes` | `{ "query"?, "near"?, "limit"?: 1–50 }` | matched, total, notes [{id, text, x?, y?, z?, dimension?, distance?, direction?, created_at}] |
| `delete_note` | `{ "id": "k3f9" }` | `{ deleted }` |
| `add_buttons` | `{ "buttons": [{ "type", "label", "question"?, "x"?, "y"?, "z"?, "dimension"?, "player"?, "text"?, "item"?, "potion"?, "form"?, "slots"? }] }` | Puts up to 5 buttons under the answer (6 since plugin 5.4). `ask` asks `question` on click; `point` shows the way to x, y, z; `note` saves `text` with x, y, z; `copy` (since plugin 5.3; older plugins refuse it) puts `text` into the clipboard; `brewing` (5.3) opens the brewing steps for `potion` in `form`; `anvil` (5.3) opens the anvil plan with what the player has, or only `slots`; `recipe` opens the recipe window for `item`; `enchants` the enchanting window for the item in hand; `villagers` the villager window, optionally for `item`. Under a public answer (since plugin 5.3) every player online gets the buttons, and `ask` asks everyone. Returns `{ added, total }`. Since plugin 5.4, `point` with `player` instead of coordinates follows that player, checked against the presser's locator bar on every press; under a public answer nobody gets the way to themself |
| `write_book` | `{ "title": "≤ 32", "text": "≤ 8000" }` | Writes the text into a book and adds buttons to open and take it under the answer; returns `{ pages }` |
| `set_timezone` | `{ "zone": "Asia/Yekaterinburg" }` | Stores the player's IANA zone for later requests; returns `{ zone, local_time }` |
| `get_allay_guide` | – | Since 4.0 (3.x calls it `get_buddy_guide`). How Allay works for this player here: plugin_version, commands [{usage, does}] they have permission for, chat_mode {prefixes {"!", "?", "~"}: what each does, only those this player may use}, settings {chat_mode, hints, timezone}, features [names of what the server has on: notes, goals, reminders, windows, books, buttons, compass, sorting, operator_tools], limits {notes, reminders, goals, public_cooldown_seconds} |
| `allay_settings` | `{ "chat_mode"?: bool, "hints"?: bool }` | Since 4.0 (3.x calls it `buddy_settings`). Changes the player's settings, as `/allay chat` and `/allay hints` do; turning chat mode on also sends the plugin's explanation. Returns `{ chat_mode, hints }`. An action: not for `askx` |

A plugin before 4.0 offers the guide and the settings as `get_buddy_guide` and `buddy_settings`. The backend shows the model the new names and sends `tool_call` with the name the plugin offered, so old plugins keep both.

A `trade` is `{ buy: [item], sell: item, left, max_uses }`; `buy` is what this player pays now, with demand and discounts, and a book's `sell` carries `stored_enchantments`.

### Items

Every tool that lists items writes each one the same compact way, leaving out keys that don't apply:

| Key | What it holds |
|---|---|
| `slot` | the slot number, where the list has slots |
| `id`, `count` | the item id without `minecraft:`; `count` only above 1 |
| `name` | a custom name; players write it, so it is data |
| `enchantments` | {enchantment: level} on the item |
| `stored_enchantments` | {enchantment: level} an enchanted book holds for the anvil (since 2.4) |
| `damage`, `max_damage` | durability, for items that wear |
| `potion` | since 2.4: potions, splash and lingering potions, tipped arrows, and suspicious stew, as the base type plus custom effects: `long_swiftness`, `strength + speed 2`, `night_vision` |
| `trim` | since 2.4: armor trim {pattern, material} |
| `contents_count` | since 2.4: items inside a shulker box or bundle, 0 when empty |

`inspect_item` adds the rest for one item. Its `attributes` are the modifiers that work: the item's own, or its type's defaults when it has none, since the game uses only the item's own when it has any. `tooltip` is what the game shows in the main hand: the player's base 1 attack damage and 4 attack speed plus the item's modifiers, without enchantments, so a diamond sword reads 7 and 1.6. Effect `seconds` follow the tooltip too: a tipped arrow gives an eighth of the potion's duration, a lingering potion a quarter; −1 lasts forever. A written book's pages never leave the server.

### Automation tools

Since 5.5, for plugin 5.7. The plugin runs these like any client tool, checks the player's rights (`allay.automation.*`), the task limit, and the switches in its config, and answers with `{ ok: false, error }` when one of them says no. Coordinates are `{ "x", "y", "z" }` whole numbers from earlier results. Categories are `building`, `wood`, `stone`, `ores`, `redstone`, `food`, `farming`, `mob_drops`, `tools`, `potions`, `other`.

| Name | Mode | Args | Does |
|---|---|---|---|
| `start_task` | ask, task below depth 2 | `{ "kind": "chests" \| "furnaces" \| "brewing" \| "crafting", "name": "≤ 40", "brief": "≤ 2000" }` | Starts an automation agent with `brief` as its first wake's `message`; returns `{ id, name }`, or an error: the task limit, no rights, or automation off. From a task, the new one is one level deeper |
| `message_task` | ask; task below depth 2 (server 5.12+) | `{ "id", "text": "≤ 500" }` | Wakes a running task with `[player] text`. From an agent (plugin 5.14+), only its own sub-agents, which wake with `[parent «name»] text` |
| `cancel_task` | ask; task below depth 2 (server 5.12+) | `{ "id" }` | Stops a running task. From an agent (plugin 5.14+), only its own sub-agents; the agent isn't woken with `[sub-agent] …` for one it stopped |
| `say` | task | `{ "text": "≤ 500", "buttons"?: [{ "label": "≤ 24", "reply": "≤ 200" }] (≤ 4) }` | A chat line to the player under “Automation agent: <name>”; a click wakes the task with `[button] reply` |
| `wait` | task | `{ "seconds"?: 1–600 }` | Ends the wake. The plugin wakes the task with `[player] …` on an answer, `[button] …` on a click, `[job] …` when its job ends (smelting or brewing done, a picking mode closed), `[sub-agent] …` when a sub-agent it started ends (since 5.10.1), `[parent «name»] …` from the agent that started it (plugin 5.14+), or `[timer] …` after `seconds` |
| `finish` | task | `{ "summary": "≤ 500", "handoff"?: bool (server 5.12+) }` | Ends the task; the player sees `summary`. Since plugin 5.14, refused while a sub-agent of the task runs, unless `handoff` is true: the agent would never hear the report it needs. With `handoff`, the sub-agents carry on and report to the player themselves |
| `pick_blocks` | task | `{ "kind": "chests" \| "furnaces" \| "brewing_stands", "looking"?: bool }` | A picking mode with [Done] [All] [Cancel]; its end wakes the task with `[job] …`. `looking` takes the block under the crosshair at once and returns it |
| `chests` | task | `{ "action": "read" \| "plan" \| "apply" \| "undo", "mode"?: "sort" \| "group" \| "move" \| "take" (5.11+) \| "stash" (5.11+), "layout"?: as in sort_inventory (5.8+, sort and group), "chests"?: [xyz] (≤ 64), "assign"?: [{ x, y, z, "category"?, "items"?: [id] (≤ 27) }] (≤ 64), "items"?: [selector] (ids before 5.11), "categories"?: [category], "count"?: 1–2304 (5.11+), "amounts"?: [{ "item": selector, "count"? \| "up_to"? (take) }] (≤ 16, 5.11.1+), "up_to"?: 1–2304 (5.11+, take), "keep"?: [selector] (5.11+), "hotbar"?: bool (5.11+, stash), "to"?: [xyz] (≤ 64), "from"?: ["inventory" \| "nearby"] (5.10.2+) }` | Reads chests (contents, signs, item frames, problems, `only_adding` for a sorter's input), plans a sort, a grouping, a move, a take into the inventory, or a stash of the inventory as a preview, applies it, or undoes the last apply (the last five since 5.11). Copper chests and placed shulker boxes count as chests since 5.11 |
| `smelt` | task | `{ "action": "scan" \| "start" \| "add" (5.11+) \| "fuel" (5.10+) \| "status" \| "collect", "item"?, "count"?: 1–4096, "items"?: [{ "item", "count"? }] (≤ 8), "furnaces"?: [xyz] (≤ 16), "fuel"?, "each"?, "up_to"?, "need"?, "types"?, "to"?: "inventory" \| "auto" (5.11+) \| [xyz] (1–8), "remember"?: bool (5.11+) }` | Furnaces, blast furnaces, and smokers near the player; several items split by each furnace's speed. Since 5.11 `to` on start empties full furnaces and the rest at the end, collect pays the furnace's experience, `add` adds more of what the job cooks, and planks, sticks, bamboo, and lava burn |
| `brew` | task | `{ "action": "scan" \| "start" \| "status" \| "collect", "potion"?, "form"?: "potion" \| "splash_potion" \| "lingering_potion", "bottles"?: 1–64, "potions"?: [{ "potion", "form"?, "bottles"? }] (1–4, 5.11+), "fresh"?: bool, "stands"?: [xyz] (≤ 8), "to"?: "inventory" \| "auto" (5.11+) \| [xyz] (1–8), "remember"?: bool (5.11+) }` | Brewing stands near the player. Since 5.11 several potions at once, rounds on the same stands past three bottles a stand, water bottles filled from glass bottles at water or a cauldron, and `to` on start delivers by itself |
| `craft` | task | `{ "item", "count"?: 1–64, "dry_run"?: bool }` | Crafts at a crafting table near the player |

The plugin defines what each of them returns; the model reads whatever comes back.

### Operator tools

Listed only for operators and only when the admin enables them (`tools.operator` in the plugin config). The plugin checks `isOp()` again when it runs one. They act on the asking player only.

| Name | Args | Does |
|---|---|---|
| `give_item` | `{ "item": "diamond_sword", "count"?: 1–576, "enchantments"?: { "sharpness": 5 } }` | Puts the item into the player's inventory, dropping what doesn't fit at their feet |
| `teleport` | `{ "x", "y", "z", "dimension"? }` or `{ "player": "name" }` | Teleports the player |
| `set_gamemode` | `{ "mode": "survival" \| "creative" \| "adventure" \| "spectator" }` | Changes the player's game mode |
| `heal` | – | Full health, food, and saturation; puts out fire |
| `apply_effect` | `{ "effect": "night_vision", "seconds"?: 1–3600, "level"?: 1–10 }` or `{ "clear": true }` | Gives the player an effect, or clears all of them |
| `set_time` | `{ "time": "day" \| "noon" \| "night" \| "midnight" \| 0–23999 }` | Sets the time in the player's world |
| `set_weather` | `{ "weather": "clear" \| "rain" \| "thunder", "seconds"?: 1–86400 }` | Sets the weather in the player's world |

## Server tools (run by the backend)

| Name | Args | Notes |
|---|---|---|
| `search_web` | `{ "query": "…", "sites"?: [domain], "recency"?: "day" \| "week" \| "month" \| "year" }` | Since 5.5, with the backend's `PERPLEXITY_API_KEY` and no server key: Perplexity's Search API, up to 5 results {title, url, date?, snippet}. Otherwise, and for BYOK: `{ "query" }` through the search model, a summary with source URLs |
| `exact_calculations` | `{ "expressions": ["ceil(1000 / 64)", "(-1024 / 8)", "3 hours to seconds"] }` | Up to 10 expressions, each ≤ 300 chars, evaluated with math.js at 64 significant digits (units and conversions work). Returns `[{ expression, result }]` or `{ expression, error }` per line; each expression gets 1 s |
| `remember` | `{ "text": "≤ 200 chars" }` | Saves a lasting fact about the player (goals, what they've done, preferences; places go to the notebook with `notes`); at most 30 per player |
| `forget` | `{ "id": "…" }` | Deletes one remembered fact |

All server tools report progress only through `tool_status` (kind `server`).

## Automation agents

Since 5.5, for plugin 5.7. The chat hands work in the world (sorting chests, smelting, brewing, crafting) to an automation agent with `start_task`. The agent runs in wakes: each wake is an ordinary `POST /api/v2/chat` with `mode: "task"` and the `task` block, which the plugin opens when the task starts and every time something wakes it. No stream stays open and no tokens go while it waits.

- **Message.** The first wake's `message` is the brief from `start_task`. Later ones say what woke it: `[player] …`, `[button] …`, `[job] …`, `[sub-agent] …`, `[parent «name»] …`, or `[timer] …`, one per line, oldest first. The plugin keeps a message within 2000 characters; since plugin 5.14 what doesn't fit waits for the next wake instead of being cut off.
- **Sub-agent reports.** When a sub-agent ends, the plugin wakes the agent that started it with `[sub-agent] «name» (kind, id) finished: <summary>` or `stopped: <why>` (cancelled, interference, an error, the time or wake limit, the quota, the player leaving). Since plugin 5.14 a second line follows when the sub-agent's tools did something: `What its tools reported: …`, the plugin's own English record of what was crafted, smelted, brewed, collected, moved, or put on an anvil, with counts and where it went (at most six, newest last), so the parent can act on facts rather than the summary alone. Older backends read it as text.
- **Ending.** Since plugin 5.14, stopping an agent (`/allay cancel`, `cancel_task`, interference, the limits) also cancels its wake if one is out, and its tools refuse to act for it from then on.
- **End of a wake.** The agent ends every wake with `wait` or `finish`. Its final text, often empty, is a note for its own next wake; the backend records it and the plugin doesn't show it. An empty final text is not an error in task mode: `done` comes with `answer: ""`.
- **Steps.** A wake gets up to `MAX_TASK_STEPS` model steps (16 by default), against `MAX_AGENT_STEPS` (8) for a question.
- **Tools.** A wake gets the client tools the plugin offers minus operator tools, `add_buttons`, `write_book`, and `get_nearby_players`; `start_task`, `message_task`, and `cancel_task` only at depth 1 (before server 5.12, only `start_task`). Server tools: `exact_calculations` only, no `search_web`, no `remember` or `forget`. The prompt still shows the player's memories, read-only.
- **Prompt.** `minecraft-task.md` plus the agent's name, kind, and depth, and the player.
- **Depth.** The chat is depth 0. A task the chat starts is 1, a task started by a task is 2 and can't start another.

| Mode | Gets | Never gets |
|---|---|---|
| `ask` | `start_task`, `message_task`, `cancel_task` | `say`, `wait`, `finish`, `pick_blocks`, `chests`, `smelt`, `brew`, `craft` |
| public `ask` | — | all automation tools |
| `task` | `say`, `wait`, `finish`, `pick_blocks`, `chests`, `smelt`, `brew`, `craft`; `start_task`, `message_task`, `cancel_task` at depth 1 | operator tools, `add_buttons`, `write_book`, `get_nearby_players`, `search_web`, `remember`, `forget` |
| `askx` | — | all automation tools |

## Conversation memory

The backend keeps these per tenant and `user_id` (since 6.0; before, per `user_id` alone):

- **The session.** Whole exchanges verbatim (since 5.5 with the tool calls and their results, whole) plus a summary of everything older. The backend folds all but the newest 12 000 tokens (2 to 30 exchanges) into the summary with the model after an answer once the session passes about 32 000 tokens or 100 exchanges, and before an answer past 42 000. A quiet session isn't folded; it expires. A session lives 24 hours after the last question. `/askx` requests land in it as one short exchange (the request and the commands or the refusal), so a later `/ask` knows what was done.
- **The server's public thread** (since 3.0). Public questions with a `server.id` go to the tenant's thread for that id instead of the asker's session, each question prefixed with the asker's name in brackets, so a follow-up from another player continues the talk. It folds like a session and lives 2 hours after the last question (`PUBLIC_CHAT_TTL_SECONDS`). Without `server.id` a public question uses the asker's session.
- **A task's thread** (since 5.5). Each wake of an automation agent reads and extends its own thread under the player and `task.id`: the wake's message and the agent's final text, or `(waiting)` when it ended without one. It folds like a session and lives 2 hours after the last wake (`TASK_CHAT_TTL_SECONDS`). The player's session never sees it.
- **Memories.** Lasting facts the model saves with `remember`, kept in MongoDB until the player forgets them or, since 6.0, 365 days after their last question. They go into the system prompt with their ids.

Endpoints for the plugin's `/allay new`, `/allay memory [text]`, `/allay forget`, and (since 6.0) `/allay privacy`, and (since 6.1) the consent a player gives before their first question, all with `Authorization`:

| Request | Answer |
|---|---|
| `GET /api/v2/users/{user_id}` | Since 6.0. `200` with everything kept about the player: `{ user_id, tenant, pseudonym, memories, consent, session: { summary?, messages }, outcomes, tasks: { <task id>: session }, runs: [{ at, kind, model, input_tokens, output_tokens, cost, duration_ms, result }], retention }` |
| `DELETE /api/v2/users/{user_id}` | Since 6.0. `200 { "erased": true, "memories": 3, "runs": 12, "traces": 40 }`: memories, the consent (since 6.1), session, pending outcomes, and agents' threads go; the player's runs keep only numbers under `erased`; their traces go. The tenant's public thread expires by itself within 2 hours |
| `DELETE /api/v2/users/{user_id}/session` | `200 { "cleared": true }`; memories stay |
| `GET /api/v2/users/{user_id}/consent` | Since 6.1. `200 { "consent": { "version": 1, "accepted_at": "ISO-8601" } }`, or `{ "consent": null }` when the player hasn't agreed |
| `PUT /api/v2/users/{user_id}/consent` with `{ "version": 1 }` | Since 6.1. Records that the player agreed to the plugin's notice of that version (a whole number, 1–1000), replacing an older agreement: `200 { "consent": { "version", "accepted_at" } }` |
| `DELETE /api/v2/users/{user_id}/consent` | Since 6.1. `200 { "withdrawn": true }`, or `false` when there was none. What's kept stays until erased |
| `GET /api/v2/users/{user_id}/memories` | `200 { "memories": [{ "id": "k3f9a", "text": "…", "created_at": "ISO-8601" }] }`, oldest first |
| `POST /api/v2/users/{user_id}/memories` with `{ "text": "3–200 chars" }` | `200 { "memory": { "id", "text", "created_at" } }`; `409 MEMORY_FULL` at 30; `400` for other text. Since 5.1 |
| `DELETE /api/v2/users/{user_id}/memories` | `200 { "deleted": 4 }`: all of them |
| `DELETE /api/v2/users/{user_id}/memories/{id}` | `200 { "deleted": 1 }`, or `404` |

## Providers and billing

Since 5.0. A server pays for the model one of two ways, and the plugin picks with `provider.mode` in its config.

### Bring your own key (BYOK)

The request carries the server's own key in `X-Provider-Key` and the rest in the body:

```json
"provider": {
  "base_url": "https://openrouter.ai/api/v1", // any OpenAI-compatible API; empty means OpenRouter
  "model": "openai/gpt-6-luna",              // empty means the backend's default model
  "search_model": "perplexity/sonar"         // empty: the run gets no search_web
}
```

The backend uses the key for this run only. It never stores it, never logs it, and blanks it out of every error message it passes on. OpenRouter gets OpenRouter's own provider; any other `base_url` gets a plain OpenAI-compatible client. On a backend with billing on, `base_url` must be `https://` and resolve to a public address.

The model must call tools. For OpenRouter the backend checks the model's `supported_parameters` before the run; for other APIs it reads the provider's refusal. Errors before the stream starts:

| Code | Status | Meaning |
|---|---|---|
| `PROVIDER_AUTH_FAILED` | 401 | The provider refused the key |
| `MODEL_NOT_FOUND` | 400 | The provider doesn't know this model |
| `MODEL_NO_TOOLS` | 400 | The model can't call tools; Allay needs that |
| `PROVIDER_URL_REJECTED` | 400 | `base_url` isn't https, or points into a private network |
| `RATE_LIMITED` | 429 | Too many questions from this server; `retry_after` (seconds) says when to come back |

The same codes can arrive as an `error` event when the provider only fails mid-run. On a backend with billing on, BYOK is free and needs a license as the server's identity (since 6.0); it's limited per license: 20 questions a minute, 2000 a day, 4 at once, and all BYOK servers together take at most `BYOK_ACTIVE_RUNS` (100) slots, so paying servers always have room. A blocked license can't ask with its own key either. Every request to the provider goes through a guard that checks the address again and refuses redirects.

`X-OpenRouter-Token` without a `provider` block is BYOK on OpenRouter with the backend's default models.

### Subscription (hosted)

Without a key, the request runs on the backend's own key and models. The plugin sends `Authorization: Bearer <license>`, where the license is `<license id>.<secret>` from `POST /api/v2/license`. The backend ignores everything the plugin says about the model.

| Code | Status | Meaning |
|---|---|---|
| `LICENSE_REQUIRED`, `LICENSE_INVALID` | 401 | See “Who is asking” |
| `SUBSCRIPTION_INACTIVE` | 402 | Nothing paid for now, the period ended, or the license is blocked |
| `QUOTA_EXCEEDED` | 402 | This period's limit is spent; `resets_at` (ISO-8601) says when it refills, absent when only a new payment helps |
| `PLAYER_BLOCKED` | 403 | Since 6.2: the backend's operators blocked this player on this server (also from `/api/v1/ask` and `/api/v1/askx`). Plugins before 6.2 show it as a general error |

Before a stream these come as `{ "error": { "code", "message", "resets_at"?, "retry_after"? } }`.

The limit is a budget in US dollars: what the server's questions really cost, counting the model, web search, and the session summaries. Each run is charged when it ends, so one run can overshoot a little.

A backend with billing off (`SELFHOSTED=1`, as on a server's own backend) never asks for a license, only for its `PLUGIN_TOKEN`: it serves its plugins on its own key, and BYOK still works without limits. Since 5.5, such a backend honors `provider.model` from a request without a key: the run (and its session summary) uses that model on the backend's own key, so the plugin can give each player tier its own model. `base_url` and `search_model` are ignored there, and search stays the backend's own. With billing on, a request without a key never picks the model.

### License endpoints

| Request | Answer |
|---|---|
| `POST /api/v2/license` without `Authorization` | `200 { "license": "<id>.<secret>", "license_id", "claim_code", "pay_url": "https://t.me/<bot>?start=<claim code>", "claim_expires_at" }`: a new license. The plugin keeps `license` in `plugins/Allay/license.key` and shows `pay_url`. Free, and limited to 10 an hour per client address (an IPv6 /64 counts as one) and 500 an hour in all |
| `POST /api/v2/license` with `Authorization: Bearer <license>` | The same shape without `license`: a fresh claim code for the existing license |
| `GET /api/v2/license` with `Authorization` | `200` with the status below |
| any of them with billing off | `200 { "billing": false }` |

Both `POST`s take an optional body `{ "name": "…" }` (≤ 64 chars): the server's name as the bot shows it to the payer. The plugin sends its MOTD without formatting codes.

The status:

```json
{
  "billing": true,
  "license_id": "k3f9a2…",
  "linked": true,                         // a Telegram account claimed it
  "active": true,
  "plan": "month",                        // week | month | year; null before the first payment
  "paid_until": "2026-11-14T10:00:00Z",   // null before the first payment
  "renews": true,                         // a Telegram Stars subscription renews it by itself
  "quota": { "used_percent": 62, "resets_at": "2026-11-14T10:00:00Z" },
  "last_payment_at": "2026-10-14T10:00:00Z"
}
```

`quota.resets_at` is when the current budget ends: the period's end, or for a year the next monthly refill. A claim code works once and for 24 hours. The plugin polls the status every few minutes, tells online operators when `last_payment_at` changes, when `used_percent` passes 80 and 100, and three days before `paid_until`.

### Paying

`https://t.me/<bot>?start=<claim code>` opens the backend's Telegram bot. `/start <claim code>` ties the license to that Telegram account and shows the plans; payment goes in Telegram Stars.

| Plan | Stars | Period | Budget |
|---|---|---|---|
| `week` | 150 | 7 days | $0.75 |
| `month` | 500 | 30 days, renews by itself as a Stars subscription | $3.00 |
| `year` | 10 000 | 365 days | $6.00 a month, refilled every 30 days |

A payment while a period runs adds its budget at once and moves `paid_until` further.

## Admin panel setup

Since server 5.7 and plugin 5.9. The backend has a web admin panel at `<PUBLIC_URL>/admin`. On a self-hosted backend (`SELFHOSTED=1`), an operator creates its first account from the game with `/allay init`, which calls the following. Since 6.0 it wants the backend's `PLUGIN_TOKEN` (`401` without it): a recovery code resets any account's password, so only the backend's own plugin may ask for one.

| Request | Answer |
|---|---|
| `POST /api/v2/admin/init`, no body | `200 { "url": "<PUBLIC_URL>/admin/setup?code=<code>", "expires_at", "mode": "setup" }` while the panel has no admin. The code works once and for 30 minutes; a new call replaces a pending one |
| the same once an account exists (since server 5.10) | `200 { "url": "<PUBLIC_URL>/admin/recover?code=<code>", "expires_at", "mode": "recover" }`: a recovery link that sets a new password for any account the panel keeps. Same rules: once, 30 minutes, a new call replaces a pending one. Setup and recovery codes never stand in for each other |
| the same when the only admin is defined in the environment, or on servers before 5.10 once an admin exists | `409 { "error": { "code": "ADMIN_EXISTS", … }, "url": "<PUBLIC_URL>/admin" }` |
| the same on a backend with billing on | `404 { "error": { "code": "NOT_SELFHOSTED", … } }` for a license holder, `401` for anyone else: its first admin comes from a code in its own log |

The plugin shows the link only to whoever ran the command, as a clickable chat line, and never logs it; from the console it prints it to the console. It reads `mode` to say which link it is; an answer without `mode` is a setup link. Older backends answer `404` without that code: the plugin then says the backend has no panel.

The recovery page posts `{ code, username, password }` to the panel's `POST /api/admin/recover`. It sets the new password, ends every session of that account, writes `recover` to the audit log, and signs in. A wrong or spent code answers `400 BAD_CODE`, and five of them from one address lock recovery for 15 minutes. The environment's admin (`ENV_ADMIN`) and an unknown name (`NO_ACCOUNT`) keep the code alive.

## Compatibility

`POST /api/ask` and `POST /api/askx` keep their v1 request and response shapes, and since 6.0 want the same `Authorization` as v2 and a `user_id` of letters, digits, `-`, or `_` when they send one. They run the same agent without client tools.

`GET /api/health` answers `{ "name": "Allay", "status": "ok", "version", "billing" }`; since 6.0 nothing about the process.

| Plugin | Server before 6.0 | Server 6.0 |
|---|---|---|
| Allay 5.x | Works | `401` everywhere: it sends no token, and a BYOK server sends no license |
| Allay 6.0 | Works; a self-hosted backend ignores the token | Works |
