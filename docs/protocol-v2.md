# Allay streaming protocol v2

The plugin opens one streaming request per question. The backend agent (Mastra) streams back what it is doing, and when it needs to know something about the game it asks the plugin to run a tool and post the result back. Web search runs on the backend.

## Request

`POST /api/v2/chat`

Headers: `Content-Type: application/json`, `Accept: text/event-stream`, `X-Plugin-Version`, and who pays for the model (since 5.0, see “Providers and billing”): `Authorization: Bearer <license>` for a subscription, or `X-Provider-Key` with a `provider` block for the server's own key. The v1 header `X-OpenRouter-Token` still works as such a key with the default models.

```json
{
  "mode": "ask",                      // "ask" answers a question; "askx" turns a request into commands
  "visibility": "private",            // "public" when every player online sees the question and the answer (since 3.0)
  "message": "what should I do next?", // ≤ 1000 chars for ask, ≤ 500 for askx
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

`visibility` (since 3.0) is `private` by default. `public` marks a question from `/askall` or `?` in chat mode: the plugin shows the question and the answer to every player online, the prompt tells the model so, and the run goes without `write_book`. `askx` is always private. A public question reads and extends the server's shared thread instead of the asker's session (see “Conversation memory”); `server.id`, a random id the plugin keeps for its server, names that thread.

`player.dimension` (optional, since 5.1) is the dimension the player stood in when they asked: `overworld`, `the_nether`, or `the_end`. The prompt tells the model, so a place named without a dimension lands where the player is; any other value is dropped.

`tools` lists the client tools this plugin offers (server admins can switch some off). The backend registers only those for this run. The plugin lists operator tools only when the asking player is an operator, and the backend drops them anyway when `player.op` is false. An `askx` run gets only the tools that read the game: no actions (`point_to`, `reminders`, `goals`, notes, buttons, books) and no operator tools.

## Response: Server-Sent Events

`Content-Type: text/event-stream`. Every event is `event: <name>` + `data: <json>`. A `: ping` comment goes out every 15 s.

| Event | Data | Meaning |
|---|---|---|
| `start` | `{ "run_id": "uuid", "model": "…" }` | The run began; `run_id` addresses tool results |
| `reasoning` | `{ "delta": "…" }` | A piece of the model's reasoning, when the model exposes it |
| `tool_call` | `{ "call_id": "…", "name": "get_inventory", "args": { … } }` | The plugin must run this client tool and post the result |
| `tool_status` | `{ "call_id": "…", "name": "search_web", "kind": "client" \| "server", "state": "started" \| "finished" \| "failed", "args": { … }, "summary": "5 sources", "summary_key"?: "sources", "summary_values"?: { "count": 5 } }` | Progress of any tool, for display. Client tools get `started` right before `tool_call`. Since 2.4, server tools add `summary_key` and `summary_values` so the plugin can show the summary in the player's language; `summary` stays in English |
| `text` | `{ "delta": "…" }` | A piece of the answer |
| `commands` | `{ "is_sequence": true, "commands": ["give @s diamond_sword 1"] }` | askx only: the commands to run (≤ 12, no leading slash) |
| `usage` | `{ "input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0, "cost": 0.0 }` | Totals for the run so far: sent after every model step and once more, final, right before `done`. Each one replaces the last |
| `done` | `{ "answer": "full text", "duration_ms": 5321 }` | The run finished; for askx `answer` may be a short note |
| `error` | `{ "code": "AI_REQUEST_FAILED", "message": "…" }` | The run failed; the stream ends after it. Codes stay compatible with v1 (`QUESTION_TOO_LONG`, `NETWORK_ERROR`, …) plus `TOOL_TIMEOUT`, `RUN_NOT_FOUND` |

## Tool results

`POST /api/v2/chat/{run_id}/tools/{call_id}` with

```json
{ "ok": true, "result": { … } }
{ "ok": false, "error": "player is offline" }
```

Answers: `200 { "accepted": true }`, `404` unknown or finished run or call, `409` already answered. The backend waits up to 15 s per client call; past that the model gets an error result and the run goes on.

## Client tools (run by the plugin, on the server thread, about the asking player only)

2.4 merged and reshaped tools, and the backend serves only the 2.4 set: plugins before 2.4 lose the tools whose names changed. Every spot comes as absolute `x`, `y`, `z` with `distance` (horizontal, in blocks) and `direction` (north, north-east…); dimensions are `overworld`, `the_nether`, `the_end`, and tools accept Bukkit's old `normal` and `nether` too.

| Name | Args | Returns |
|---|---|---|
| `get_player_status` | – | gamemode, health, max_health, food, saturation, level, level_progress, x, y, z, dimension, biome, light, facing, flying, effects [{type, level, seconds}], held_item |
| `get_inventory` | `{ "include_enderchest"?: bool }` | main [item], armor {head, chest, legs, feet}, offhand, and inside_containers {id: count} with what the shulker boxes and bundles in main and offhand hold; with `include_enderchest`, enderchest [item] and enderchest_inside_containers. Items as in “Items” below |
| `get_surroundings` | `{ "radius"?: 1–16 }` default 8 | radius, blocks {id: count} (top 12), notable [{id, x, y, z, distance, direction}] (ores, chests, spawners, portals; 15 nearest), entities [{type, count, nearest, hostile?}] within 32 blocks, other_players (a count only) |
| `look_at` | `{ "detail"?: bool }` | What's under the crosshair. `kind: "nothing"`; or `kind: "block"` (within 6): id, state?, x, y, z, distance, hardness, blast_resistance, preferred_tool?, needs_tier?, held_tool_is_right, break_seconds?, drops_with_held_item [item], age/max_age?, waterlogged?, block_light, sky_light, plus container {name?, slots, used_slots, items {id: count}, more_kinds?, inside_shulker_boxes?, inside_bundles?} — or with `detail`, stacks [item with slot] up to 54 and more_stacks — and enchanting {bookshelves, counted_max, top_offer_min_level, top_offer_max_level, player_level, lapis_in_inventory}; or `kind: "entity"` (within 16): type, name?, distance, item? (dropped items, item frames), for living ones health, max_health, armor, attack_damage?, hostile, your_hit {weapon, damage_per_hit, hits_to_kill?, estimate}, for traders profession, level?, trades [trade]. Another player is only `{kind, type: "player", distance}` |
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
| `scan_nearby_containers` | `{ "radius"?: 1–12 }` default 8 | radius, containers (20 nearest) [{type, x, y, z, distance, direction, name?, used_slots, top {id: count}, inside_containers?}], more_containers |
| `find_item` | `{ "item": "diamond", "radius"?: 1–12 }` | query, matched_ids (when `item` isn't an exact id and matched as part of ids), total, radius, places (up to 30) [{where: inventory \| offhand \| armor \| enderchest, slot, count, inside?} or {where: container, type, x, y, z, distance, direction, name?, count, inside_boxes?}], more_places. Counts shulker boxes and bundles one level deep |
| `inspect_item` | `{ "from"?: "hand" \| "offhand" \| "head" \| "chest" \| "legs" \| "feet" \| "inventory" \| "enderchest" \| "container", "slot"?: 0–53, "inner_slot"?: 0–63 }` | One item in full: `from`, `slot`, with `inner_slot` also `inside` and `inner_slot`, then everything an item has (below), plus lore (≤ 10 lines), unbreakable, attributes [{attribute, amount, operation, slot}], tooltip {attack_damage, attack_speed}, effects [{type, level, seconds \| instant}], dye_color, repair_cost, book {title?, author?, generation?, pages}, firework {flight?, explosions [{shape, colors, fade_colors?, trail?, twinkle?}]}, map {scale_level, blocks_per_side, center_x, center_z, dimension, locked, player_inside}, contents [item with slot] up to 27 and more_stacks. `slot` is required for inventory (0–35), enderchest (0–26), and container (the one under the crosshair, 6 blocks); `inner_slot` reads that slot inside the shulker box or bundle found there |
| `get_item_durability` | – | items [{from, slot?, id, damage, max_damage, percent_left, unbreaking?, expected_uses?, mending?, almost_broken?}] for armor, offhand, and every inventory slot (0–8 the hotbar) |
| `get_xp_info` | `{ "target_level"?: 0–100 }` | level, progress, total_points, points_to_next_level, target_level?, points_to_target? |
| `get_food_options` | – | food, saturation, food_missing, foods [{id, count, nutrition, saturation, note?}] |
| `get_anvil_plan` | `{ "enchantments"?: { "sharpness": 5, "mending": 1 }, "slots"?: [0–35] }` | For the item in hand. With `enchantments`: ideal books, as item, item_repair_cost, steps [{left, right, levels}] where pieces are `item` or `<enchantment> <level>`, total_levels, too_expensive. Without (plugin 5.3+): what the player has, the enchanted books and enchanted items of the same kind in the inventory (or only `slots`), priced as the game does: found, item, pieces [{piece: `hand` \| `hotbar N` \| `inventory row R column C`, slot?, kind, enchantments, repair_cost}], steps [{left, right, levels, gives}], result, total_levels, too_expensive, unused?; `{ found: false, reason }` when nothing improves the item |
| `get_light_spawn_check` | `{ "radius"?: 1–16 }` default 8 | radius, dark_spots (solid floor, two free blocks, block light 0, within ±6 height), nearest [{x, y, z, distance, direction}] (10), rule |
| `get_brewing_recipe` | `{ "potion": "night_vision", "form"?: "potion" \| "splash_potion" \| "lingering_potion" }` | Since plugin 5.3, read from the game's brewing recipes (26.3 keeps them as data): potion, form, steps [{bottle, add, makes}] from a water bottle, fuel. Drink first, then gunpowder and dragon's breath turn the bottle |
| `get_brewing_items` | – | inventory [item] for brewing, brewing_stands (up to 4 within 8 blocks) [{x, y, z, distance, direction, fuel_level, seconds_left?, ingredient?, fuel?, bottles}] |
| `scan_farm` | `{ "radius"?: 1–16 }` default 8 | radius, crops {id: {total, ripe, max_age, by_age}}, farmland {hydrated, dry}, composter_levels?, hoppers?, spawners? {mob: count}, animals {type: count}, within ±4 height |
| `point_to` | `{ "x", "z", "y"?, "dimension"?, "label"?, "seconds"?: 1–3600, "style"? }` or `{ "player", "seconds"?, "style"? }` | Points the compass and draws a trail only the player sees. Since plugin 5.3: `seconds` up to `tools.point_to.max_seconds` (600 by default; older plugins allow 30 and refuse more), 30 by default; the trail ends when the player arrives, and a new one replaces the old. `style` is `sparkle` (default), `flame`, `soul`, `glow`, `magic`, `spark`, `cherry`, `notes`, `hearts`, `snow`, `totem`, or `happy`; older plugins ignore it. A `dimension` other than the player's is refused. Returns `{ distance, direction, seconds?, style?, compass }`. Since plugin 5.4, `player` instead of `x` and `z`: a trail that follows that player while they're on the asker's locator bar (as `get_nearby_players` says), goes dark while they hide, and ends when the asker reaches them, when they leave, or after 15 s off the bar; `seconds` defaults to `tools.point_to.follow_seconds` (180). A player off the bar is refused. Returns `{ player, distance, direction, seconds, style, follows, compass }` |
| `ping_me` | – | Note particles and a sound over the player that everyone nearby sees and hears; `{ pinged, y }` |
| `sort_inventory` | – | Merges stacks and sorts slots 9–35 by id; `{ merged_stacks }` |
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
| `search_web` | `{ "query": "…" }` | Searches through an OpenRouter online model; the result keeps source URLs |
| `exact_calculations` | `{ "expressions": ["ceil(1000 / 64)", "(-1024 / 8)", "3 hours to seconds"] }` | Up to 10 expressions, each ≤ 300 chars, evaluated with math.js at 64 significant digits (units and conversions work). Returns `[{ expression, result }]` or `{ expression, error }` per line; each expression gets 1 s |
| `remember` | `{ "text": "≤ 200 chars" }` | Saves a lasting fact about the player (goals, what they've done, preferences; places go to the notebook with `add_note`); at most 30 per player |
| `forget` | `{ "id": "…" }` | Deletes one remembered fact |

All server tools report progress only through `tool_status` (kind `server`).

## Conversation memory

The backend keeps two things per `user_id`:

- **The session.** At least the last 8 exchanges verbatim plus a short summary of everything older. Once 12 pile up, the backend folds the oldest into the summary with the model, after the answer is out. A session lives 24 hours after the last question. `/askx` requests land in it as one short exchange (the request and the commands or the refusal), so a later `/ask` knows what was done.
- **The server's public thread** (since 3.0). Public questions with a `server.id` go to `public:<server.id>` instead of the asker's session, each question prefixed with the asker's name in brackets, so a follow-up from another player continues the talk. It folds like a session and lives 2 hours after the last question (`PUBLIC_CHAT_TTL_SECONDS`). Without `server.id` a public question uses the asker's session.
- **Memories.** Lasting facts the model saves with `remember`, kept in MongoDB without expiry. They go into the system prompt with their ids.

Endpoints for the plugin's `/allay new`, `/allay memory [text]`, and `/allay forget`:

| Request | Answer |
|---|---|
| `DELETE /api/v2/users/{user_id}/session` | `200 { "cleared": true }`; memories stay |
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

The same codes can arrive as an `error` event when the provider only fails mid-run. On a backend with billing on, BYOK is free and limited per server (`server.id`, or the client address without one): 20 questions a minute, 2000 a day, 4 at once.

`X-OpenRouter-Token` without a `provider` block is BYOK on OpenRouter with the backend's default models.

### Subscription (hosted)

Without a key, the request runs on the backend's own key and models. The plugin sends `Authorization: Bearer <license>`, where the license is `<license id>.<secret>` from `POST /api/v2/license`. The backend ignores everything the plugin says about the model.

| Code | Status | Meaning |
|---|---|---|
| `LICENSE_REQUIRED` | 402 | No license and no key |
| `LICENSE_INVALID` | 401 | Unknown license or wrong secret |
| `SUBSCRIPTION_INACTIVE` | 402 | Nothing paid for now, or the period ended |
| `QUOTA_EXCEEDED` | 402 | This period's limit is spent; `resets_at` (ISO-8601) says when it refills, absent when only a new payment helps |

Before a stream these come as `{ "error": { "code", "message", "resets_at"?, "retry_after"? } }`.

The limit is a budget in US dollars: what the server's questions really cost, counting the model, web search, and the session summaries. Each run is charged when it ends, so one run can overshoot a little.

A backend with billing off (`SELFHOSTED=1`, as on a server's own backend) never asks for a license: it serves everyone on its own key, and BYOK still works without limits.

### License endpoints

| Request | Answer |
|---|---|
| `POST /api/v2/license` without `Authorization` | `200 { "license": "<id>.<secret>", "license_id", "claim_code", "pay_url": "https://t.me/<bot>?start=<claim code>", "claim_expires_at" }`: a new license. The plugin keeps `license` in `plugins/Allay/license.key` and shows `pay_url` |
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

## Compatibility

`POST /api/ask` and `POST /api/askx` keep their v1 request and response shapes. They run the same agent without client tools, so the Telegram bot and older plugins keep working.
