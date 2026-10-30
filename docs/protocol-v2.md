# Allay streaming protocol v2

The plugin opens one streaming request per question. The backend agent (Mastra) streams back what it is doing, and when it needs to know something about the game it asks the plugin to run a tool and post the result back. Web search runs on the backend.

Server 6.0 keeps the paths and the bodies of v2 but breaks one thing on purpose: **every request identifies its server.** A plugin before 6.0 (Allay 5.x) gets `401` from a 6.0 backend until it sends the credentials below.

## Who is asking

Since 6.0. Every endpoint below wants `Authorization: Bearer …`, except `GET /api/health`, `POST /api/v2/license` without a license, a player's copy by link (`GET /api/v2/exports/{token}`, since 6.9), and Telegram's webhook:

- **A hosted backend** (billing on) wants the server's license, `<license id>.<secret>`. A license only identifies: a server that brings its own key (BYOK) gets one free from `POST /api/v2/license` and sends it next to `X-Provider-Key`; paying for it is what turns on the backend's own key.
- **A self-hosted backend** (`SELFHOSTED=1`) wants its `PLUGIN_TOKEN`, a secret of at least 24 characters the operator sets in the backend's environment and in the plugin's `server.token`. A backend without one answers no plugin at all (`503 TOKEN_NOT_SET`), never everyone.

| Code | Status | Meaning |
|---|---|---|
| `LICENSE_REQUIRED` | 401 | A hosted backend got no `Authorization` (before 6.0: 402 without a key) |
| `LICENSE_INVALID` | 401 | Unknown license, wrong secret, or a license the backend revoked after a refund |
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
  "player": { "name": "Steve", "uuid": "5627dd98-…", "op": false, "dimension": "the_nether", "position": { "x": -212, "y": 64, "z": 540, "dimension": "the_nether", "world": "world_nether" } },
  "server": { "id": "0f8c…", "software": "Paper", "version": "26.3", "plugin_version": "3.0.0", "loader": "spigot", "side": "server" },
  "tools": ["get_player_status", "get_inventory", "get_surroundings", "look_at", "get_world", "get_statistics", "get_advancements", "get_recipes", "locate_structure", "get_server"]
}
```

`timezone` is the asker's IANA time zone (optional, since 2.3). The backend puts their real date and time in front of each `ask` question, as `[Mon, 12 Oct 2026, 23:42 Europe/Moscow] question`, and keeps it in the session history; without it the time is UTC.

`visibility` (since 3.0) is `private` by default. `public` marks a question from `/askall` or `?` in chat mode: the plugin shows the question and the answer to every player online, the prompt tells the model so, and the run goes without `write_book`. `askx` is always private. A public question reads and extends the server's shared thread instead of the asker's session (see “Conversation memory”); `server.id`, a random id the plugin keeps for its server, names that thread within the caller's tenant (since 6.0: another server sending the same id reaches its own thread, not this one).

`player.dimension` (optional, since 5.1) is the dimension the player stood in when they asked: `overworld`, `the_nether`, or `the_end`. The prompt tells the model, so a place named without a dimension lands where the player is; any other value is dropped.

`server.address` and `server.port` (optional, since 6.6) say where players join: the address the server's owner set in the plugin and the game port. The admin panel shows them with the address the request came from; a bad value is dropped, not refused.

`server.loader` and `server.side` (optional, since 6.12) say what Allay runs on and where. `loader` is `spigot` (the plugin for Bukkit, Spigot, Paper, and their forks), `fabric`, or `neoforge`. `side` is `server` for a dedicated server, `integrated` for the server inside a player's own game (a singleplayer world, or one opened to LAN), and `client` for a mod in the player's game on a server that runs no Allay. Without them a request counts as `spigot` on a `server`, as every plugin before 6.10 is. The prompt tells the model where it runs, and that a modded game has blocks and items the vanilla game doesn't; the admin panel shows both. Unknown values are dropped, not refused. `PUT /api/v2/server` and `POST /api/v2/license` take the same two.

`server.about` (optional, since 6.20) is what the server's operator wrote about it in the plugin's `server.about`: what the server is, its rules and places, and how they'd like Allay to talk with players. A question's prompt (mode `ask`) carries it under “About this server”, after the base prompt and the expansions' notes, framed so that Allay's own rules still come first; `askx` and automation agents don't get it. The backend trims it and reads at most 10,000 characters, cutting the rest rather than refusing the request; the plugin warns past 2,000, since every question pays for it. It isn't stored or shown in the admin panel.

`player.position` (optional, since 6.9) is where the player stands: whole `x`, `y`, `z`, a `dimension` as above, and the Bukkit `world` (≤ 64 chars). The backend measures distances and directions to remembered places and deaths from it, and the `memories` tool saves `here` there; a bad one is dropped, not refused.

Every request through OpenRouter carries `provider: { data_collection: "deny" }` since 6.9, so OpenRouter routes it only to providers that don't store or train on it (`OPENROUTER_DATA_COLLECTION=allow` lifts that).

`player.private` (optional, since 6.5) is `true` while the player has full privacy on. The backend then keeps no name, UUID, or operator status for the admin panel and forgets what it had, so the panel knows the player by pseudonym only; memories, the session, and traces work as before.

`tools` lists the client tools this plugin offers (server admins can switch some off). The backend registers only those for this run. The plugin lists operator tools only when the asking player is an operator, and the backend drops them anyway when `player.op` is false. An `askx` run gets only the tools that read the game: no actions (`point_to`, `show_marks`, `reminders`, `goals`, books, automations) and no operator tools; since 6.16 it finds the player's memories but never changes them. Since 5.5 the backend also sorts the automation tools by mode (see “Automation agents”): `ask` keeps `start_task`, `message_task`, and `cancel_task` and drops the ones only agents use; a public `ask` drops those three too.

`tasks` (optional, since 5.5) lists the asker's running automations, at most 8 since 6.22 (4 before; a newer plugin then sends the newest 4 again when the backend refuses more): `[{ "id": "k3f9", "name": "Furnaces", "state": "working" | "waiting" | "asking", "question"?: "≤ 200 chars" }]`. `id` is `[a-z0-9]{1,16}`, `name` ≤ 40 chars, `question` what a task in state `asking` asked the player. Since plugin 5.14, `asking` means the agent showed buttons or a picking mode, said a line with a question mark, or said a line with no job and no sub-agent left to wake it; a line said while a job runs (“smelting takes 3 minutes”) leaves it `waiting`. Its `question` stays until the player answers (`[player]`, `[button]`, or the end of picking), so a `[job]` or `[timer]` wake in between doesn't drop it. The prompt shows them to the model as data, so it can pass a free-text answer on with `message_task`. Since 5.10.1, `task` mode takes it too: there it lists the waking agent's own running sub-agents, so the agent never claims an ended one still works. `askx` ignores it.

`expansion_tools` and `expansions` (optional, since 6.14, from plugin 6.12) carry what other plugins and mods add through Allay's expansion API (`chat.allay:allay-expansion`); see “Expansions”. `task` mode ignores both.

`task` (required with `mode: "task"`, since 5.5) names the automation agent the run wakes: `{ "id": "k3f9", "name": "Сортировка сундуков", "depth": 1 | 2, "kind": "chests" | "furnaces" | "brewing" | "crafting" }`, with the same limits on `id` and `name`. A task run is always private; `ask` and `askx` ignore the field. Since 6.22 a `kind` this backend doesn't know answers `TASK_KIND_UNKNOWN` (400) instead of `BAD_REQUEST`, so a newer plugin can tell the player the backend needs an update; before, it was `BAD_REQUEST` with a message about `task.kind`, which plugin 6.22 reads the same way. Since plugin 6.22 a task's `id` is six characters and never names another task while the server runs.

## Response: Server-Sent Events

`Content-Type: text/event-stream`. Every event is `event: <name>` + `data: <json>`. A `: ping` comment goes out every 15 s.

| Event | Data | Meaning |
|---|---|---|
| `start` | `{ "run_id": "uuid", "model": "…" }` | The run began; `run_id` addresses tool results |
| `reasoning` | `{ "delta": "…" }` | A piece of the model's reasoning, when the model exposes it |
| `tool_call` | `{ "call_id": "…", "name": "get_inventory", "args": { … } }` | The plugin must run this client tool and post the result |
| `tool_status` | `{ "call_id": "…", "name": "search_web", "kind": "client" \| "server", "state": "started" \| "finished" \| "failed", "args": { … }, "summary": "5 sources", "summary_key"?: "sources", "summary_values"?: { "count": 5 } }` | Progress of any tool, for display. Client tools get `started` right before `tool_call`. Since 2.4, server tools add `summary_key` and `summary_values` so the plugin can show the summary in the player's language; `summary` stays in English |
| `text` | `{ "delta": "…" }` | A piece of the answer, in `&` codes (see “Answer text” below). In task mode, a piece of the agent's note to itself: don't show it |
| `commands` | `{ "is_sequence": true, "commands": ["give @s diamond_sword 1"] }` | askx only: the commands to run (≤ 12, no leading slash) |
| `usage` | `{ "input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0, "cost": 0.0 }` | Totals for the run so far: sent after every model step and once more, final, right before `done`. Each one replaces the last |
| `done` | `{ "answer": "full text", "duration_ms": 5321 }` | The run finished; for askx `answer` may be a short note; for task it is the agent's note to itself, often empty |
| `error` | `{ "code": "AI_REQUEST_FAILED", "message": "…" }` | The run failed; the stream ends after it. Codes stay compatible with v1 (`QUESTION_TOO_LONG`, `NETWORK_ERROR`, …) plus `TOOL_TIMEOUT`, `RUN_NOT_FOUND` |

### Checking askx commands

Since backend 6.18, when the plugin offers `search_commands` (plugin 6.16), an `askx` run checks the model's commands before it sends `commands`: the backend calls `search_commands` with `{ "check": ["sethome base", …] }` (no leading slash, as the model wrote them) as an ordinary `tool_call`. The plugin answers `{ "checks": [{ "command", "ok": bool, "error"?, "source"?, "usage"? }] }` in the same order: `ok` is false for a command this server doesn't have (the error names close ones), one the player may not run, one in `blocked_commands`, or, in the mods, arguments the game can't parse. A hidden plugin's command reads as unknown. When any isn't `ok`, the backend gives the model the reasons once, and sends whatever it answers then. The plugin checks again before it runs anything: unless every command exists and is the player's, nothing runs and the player hears why. A failed check call (an older plugin, a timeout) sends the commands as before.

### Answer text

The answer is Minecraft text: `&` codes and button tags, never Markdown. Since server 6.18.2 the backend turns any Markdown the model slips into codes before `text`, `done`, and the session get it, and does the same to `say`'s `text` and `finish`'s `summary`: `**x**` and `__x__` become `&lx&r`, `*x*` and `_x_` `&ox&r`, a `#` heading a bold line; backticks and code fences go. After the `&r` the color the line had comes back. Stars and underscores inside words, around spaces, or around a possible player name (`_Steve_`) stay, as do button tags and links. So that a `**` split over two deltas still pairs up, `text` arrives by whole lines in Minecraft runs, the last piece of a step when it ends; joined, the deltas are `done`'s answer.

### Buttons in the answer

Since server 6.11 the model writes buttons straight into the answer text, and the plugin (Allay 6.9 or newer) turns each into a clickable `[Label]` in place when it shows the finished answer. The tool that put buttons under the answer is gone, with no fallback: older plugins show the tags as text. The backend passes the tags through untouched in `text` and `done`.

```
<button action="ACTION" attr="value" …>Label</button>
```

- The label is the element's text: a word or two, at most 24 characters, in the answer's language, with no tags or line breaks inside.
- Attribute values go in double quotes; `&quot;`, `&amp;`, `&lt;`, and `&gt;` are the only escapes.
- At most 8 buttons in one answer, anywhere in it: mid-sentence, at the end of a line, or on a line of their own.
- A tag the plugin can't use (an unknown action, a missing attribute, a recipe that doesn't exist, a player not on the locator bar) shows as its plain label without a click. The model gets no error back.

| `action` | Attributes | The click | In a public answer |
|---|---|---|---|
| `ask` | `question` (≤ 200) | Asks Allay that question, as if typed | Yes: asks everyone again |
| `point` | `x`, `z`, `y`?, `dimension`? | A trail and the compass to the spot | Yes |
| `point` | `player`: an exact name on the clicker's locator bar | A trail that follows that player | Yes |
| `copy` | `text` (≤ 200), such as `-20 95 120` | Puts the text into the clipboard | Yes |
| `note` | `text` (≤ 200), `x`, `z`, `y`?, `dimension`? | Saves a memory with that place | Yes |
| `recipe` | `item` | The recipe window | Yes |
| `brewing` | `potion`, `form`? (`potion`, `splash_potion`, `lingering_potion`) | The brewing steps window | Yes |
| `anvil` | `slots`? (inventory slots 0–35, comma separated) | The anvil plan for the item in hand | The asker only |
| `enchants` | – | The enchanting window for the item in hand | Yes |
| `villagers` | `item`? | The villagers around and their trades | Yes |
| `command` | `command`, starting with `/` | Runs it as the player who clicks, minus the plugin's `blocked_commands` | Never: private answers only |
| `say` | `text` (≤ 256) | Sends the text to the public chat as the player who clicks, as if typed | Never: private answers only |

`dimension` is `overworld`, `the_nether`, or `the_end`; `x`, `y`, and `z` are integers. Books (`write_book`) and automation agents' `say` keep their own buttons.

## Tool results

`POST /api/v2/chat/{run_id}/tools/{call_id}` with

```json
{ "ok": true, "result": { … } }
{ "ok": false, "error": "player is offline" }
```

with the same `Authorization` as the question. Answers: `200 { "accepted": true }`, `401` without credentials, `404` unknown or finished run or call, or another tenant's run (since 6.0), `409` already answered. The backend waits up to 15 s per client call; past that the model gets an error result and the run goes on.

## Client tools (run by the plugin, on the server thread, about the asking player only)

2.4 merged and reshaped tools, and the backend serves only the 2.4 set: plugins before 2.4 lose the tools whose names changed. Since backend 5.5 the model sees some of these as one tool (`get_surroundings` with `get_light_spawn_check` and `scan_farm` from 6.16 to 6.20, when plugin 6.21 dropped both, `inventory` for `get_inventory`, `get_item_durability`, `get_food_options`, and `get_brewing_items`, `locate` for both locate tools, `get_recipes` with `get_brewing_recipe`, `get_locations` with `get_death_info`, `get_player_status` with `get_xp_info`, `allay_settings` with `set_timezone`, and since 6.17 `operator` for the seven operator tools, by `action`), but the backend still calls the plugin by the names below, so nothing changes for a plugin. Every spot comes as absolute `x`, `y`, `z` with `distance` (horizontal, in blocks) and `direction` (north, north-east…); dimensions are `overworld`, `the_nether`, `the_end`, and tools accept Bukkit's old `normal` and `nether` too.

Since plugin 6.21 results add, all optional: `look_at` with `kind: nothing` gives `block_range`, `entity_range`, and `block_beyond_reach`, and entities stop at walls; `scan_nearby_containers` and `find_item` give `locked_containers` and `unloaded_chunks`, a container `more_kinds` and `more_kinds_inside`; `get_food_options` and `get_brewing_items` give `inside_boxes_and_bundles`, brewing `more_stands`; `find_villagers` gives `more_villagers` and each villager `more_trades`; `get_anvil_plan` gives `capped_to` and `not_considered`; `goals` set returns `done` when already met, and a reach goal `x`, `z`, `radius`, `dimension`, and `counts_from_arrival_in`; `show_marks` gives `nearest` {x, y, z, distance, direction, above, turn}; `locate_structure` takes common names, and its not-found result gives `searched` and `dimension`; `get_world` from another dimension gives `overworld` {time, phase, weather}; `get_advancements` lists 15 todo, counts hidden ones once done, and takes `detail`; `get_recipes` lists `crafting_transmute` and `crafting_special` recipes and, for fireworks, `fireworks`; `give_item` takes `potion` and `firework`, `teleport` an optional `y` and returns `surface`, `safe`, and `danger`; `set_gamemode` returns `blocked`, `heal` `cleared_effects`, `apply_effect` `kept_stronger`, `set_time` and `set_weather` `world`, `frozen`, and `overridden`. The automation `craft` takes `count` up to 2304 and `firework`, and answers `in_ender_chest`; `chests` take answers `skipped_chests` and, per amount, `then`. A tool that answered no (nothing crafted, nothing found) still answers `ok: true`; the plugin shows its line as a refusal.

| Name | Args | Returns |
|---|---|---|
| `get_player_status` | – | gamemode, health, max_health, food, saturation, level, level_progress, x, y, z, dimension, biome, light, facing, flying, effects [{type, level, seconds}], held_item |
| `get_inventory` | `{ "include_enderchest"?: bool }` | main [item], armor {head, chest, legs, feet}, offhand, and inside_containers {id: count} with what the shulker boxes and bundles in main and offhand hold; with `include_enderchest`, enderchest [item] and enderchest_inside_containers. Items as in “Items” below |
| `get_surroundings` | `{ "radius"?: 1–16 }` default 8 | radius, blocks {id: count} (top 12), notable [{id, x, y, z, distance, direction}] (ores, chests, spawners, portals; 15 nearest; since plugin 6.21 ores, spawners, vaults, and budding amethyst only in the player's sight, and containers only ones they could open, in the counts too), entities [{type, count, nearest, hostile?}] within 32 blocks, other_players (a count only) |
| `look_at` | `{ "detail"?: bool }` | What's under the crosshair. `kind: "nothing"`; or `kind: "block"` (within 6): id, state?, x, y, z, distance, hardness, blast_resistance, preferred_tool?, needs_tier?, held_tool_is_right, break_seconds?, drops_with_held_item [item], age/max_age?, waterlogged?, block_light, sky_light, plus container {name?, slots, used_slots, items {id: count}, more_kinds?, inside_shulker_boxes?, inside_bundles?} — or with `detail`, stacks [item with slot] up to 54 and more_stacks — and enchanting {bookshelves, counted_max, top_offer_min_level, top_offer_max_level, player_level, lapis_in_inventory}; or `kind: "entity"` (within 16): type, name?, distance, item? (dropped items, item frames), for living ones health, max_health, armor, attack_damage?, hostile, your_hit {weapon, damage_per_hit, hits_to_kill?, estimate}, for traders profession, level?, trades [trade]. Another player is only `{kind, type: "player", distance}`. Since plugin 5.5, a container the asker couldn't open comes with `locked` (why) instead of `container` |
| `get_world` | – | dimension, time, phase, day, moon, weather, difficulty, rules {…}, border |
| `get_statistics` | – | play_time_hours, deaths, mob_kills, player_kills, walked_km, flown_km, jumps, fish_caught, minutes_since_death, minutes_since_rest |
| `get_advancements` | `{ "filter"?: "todo" \| "done" \| "all" }` default todo | done_count, todo_count, and up to 40 per list: todo and/or done [{key, title, description, started?}]; `key` is what `goals` takes for an advancement |
| `get_recipes` | `{ "item": "beacon" }` | item, name?, source?, recipes [{type, shape?, key?, ingredients?, input?, seconds?, experience?, template?, base?, addition?, makes?}] up to 5, more_recipes. Crafting, cooking, stonecutting, and smithing only. Since plugin 6.12 `item` may be a name in any language the game has («зелье заражения»), and the server's own things count: a mod's item (`mymod:wrench`), a plugin's or data pack's item built on a game item, by its model's id (`redbull:original`), and an expansion's; `name` is its name in the asker's language and `source` where it comes from when that isn't the game. A potion, or an item a brewing stand makes, answers `potions are brewed: call get_brewing_recipe with <id>`; an unknown name answers `no item called X on this server; close: Name (id), …`. Since plugin 6.13 `items` (1–5 names) asks for several at once: results [{query, …the same fields, or error}] in the order asked, up to 3 recipes each when there are several; the backend sends `item` beside it for older plugins, which answer only that one, and then asks for the rest one by one. Since plugin 6.19 `plan: true` (with `count`, 1–64, default 1) adds `plan` to each item: what crafting that many would take from the asker's inventory, bundles, ender chest (when one is near), and the chests near them they may open, planned as `craft` plans it, four levels deep, smelts included: takes {id: n}, makes {id: n}, steps ["N × id", "N × id smelted from x", …], smelt? {id: n} (what goes into a furnace first), table?, stonecutter?, smithing_table?, upgrades?, and needs? [`crafting_table` \| `smithing_table` \| `furnace` \| `water`] for what isn't near; or missing {id: n} for what's short with missing_for? {id: part} (what a part on the way was for: `diamond: diamond_chestplate` for netherite); or error when it can't be crafted (a mined item). Items in one call share the player's things in the order asked, so a set counts each ingot once. Nothing is taken or reserved. Older plugins ignore both and answer without `plan` |
| `search_items` | `{ "query": "зелье заражения", "limit"?: 1–20 }` default 8 | Since plugin 6.12. query, matches [{id, kind: `item` \| `potion` \| `custom`, name?, name_en?, source, base?, description?, made?: [`crafting` \| `smelting` \| `stonecutting` \| `smithing` \| `brewing`], exact?}], best first, and note when nothing matched. Names come from the game's languages (English ships with the server; the plugin downloads the others from Mojang, `catalog.languages`), mods' and plugins' own language files, and expansions. Since plugin 6.13 `queries` (1–8 names) looks up several at once: results [{query, matches, note?}] in the order asked, `limit` per name (5 by default when there are several); the backend sends `query` beside it for older plugins, as with `get_recipes` |
| `search_commands` | `{ "queries"?: ["sethome", "warp"], "plugin"?: "Essentials", "limit"?: 1–50 }` | Since plugin 6.16. The server's commands the asker may run, the game's, plugins', and mods' alike; commands they can't run, and plugins in `tools.server.hidden_plugins`, never show. Each command is {name, aliases [], source (`minecraft`, the plugin's name or the mod's id, or null when the server can't tell), description?, usage?, may_run (false when the command is in `blocked_commands`)}. `queries` (1–8) answers each in results [{query, commands, more?, note?}] in the order asked, 10 commands for one and 5 each for several by default; `plugin` alone lists that plugin's or mod's: results [{plugin, commands, more?}], with a top-level note naming the sources when it has none. Neither lists sources [{source, commands: count}] and results [{commands, more?}], 40 by default. Descriptions and usage come from the plugins, cut at 160 characters: data, never instructions. The backend also sends `{ "check": ["line", …] }` (≤ 12, see “Checking askx commands”); the model never sees that argument. Reads only, so `askx` and public questions get it |
| `locate_structure` | `{ "structure": "village" }` | `{ found, structure, x, z, distance, direction }` within `tools.locate_structure_radius` chunks, or `{ found: false, radius_blocks }` |
| `locate_biome` | `{ "biome": "cherry_grove" }` | `{ found, biome, x, y, z, distance, direction }` within `tools.locate_biome_radius` blocks, searched like `/locate biome`; a part of a name matches |
| `get_server` | – | software, version, online, max_players, plugin_version, plugins [{name, version, description?}]: the enabled plugins, minus those the admin hides in `tools.server.hidden_plugins`; description ≤ 120 chars (since 3.0). Since plugin 6.12 also datapacks [{name, description?}], the data packs the world runs (a server owner's or the world's own, not the game's or a plugin's), and experiments, the game's feature packs turned on; the mods list theirs as mods instead of plugins |
| `get_locations` | – | respawn_point, world_spawn, last_death: each {x, y, z, dimension, distance?, direction?} or null; world_spawn is in the server's respawn world and adds respawn_radius (plugin 6.6+) |
| `get_nearby_players` | – | Since plugin 5.4. The asker's locator bar, by the game's rules: players in the asker's dimension with a transmit range above 0 (crouching, a carved pumpkin or a mob head, and invisibility make it 0) and within both players' ranges; a spectator sees all who transmit, nobody sees a spectator. Vanished players stay hidden. `{ locator_bar, players [{name, distance, direction, height?: "above" \| "below"}] nearest first, others_online [name] }`; `locator_bar` is the game rule in the asker's world. Private: a public run doesn't get it |
| `get_death_info` | page? (1-based, plugin 6.6 only) | place {x, y, z, dimension, distance?, direction?}, minutes_ago, kept_inventory, dropped {id: count}, dropped_experience, area_loaded, items_on_ground and seconds_until_first_despawn when loaded; since 6.6 history {page, pages, total, deaths: [{at (ISO, the player's zone), minutes_ago or days_ago, x, y, z, dimension, distance?, direction?, cause?, killer?, killer_name?, message?, level, kept_inventory?, dropped_items?, dropped_experience?}]}, 10 a page newest first, and a page past the end is an error naming the count. Plugin 6.6 kept deaths on disk; since plugin 6.7 and server 6.9 the plugin reports each death (`POST /api/v2/users/{id}/deaths`), returns only the live facts here, and the backend adds `history` itself from what it keeps, preferring it over a 6.6 plugin's own |
| `find_villagers` | `{ "item"?: "enchanted_book", "profession"?: "librarian", "radius"?: 4–64 }` | radius, villagers (up to 10, nearest first) [{profession, level?, x, y, z, distance, direction, trades [trade] (up to 10; with `item`, only those trades)}] |
| `scan_nearby_containers` | `{ "radius"?: 1–52 }` default 32 (1–24, default 16, in plugin 5.14.1; 1–12, default 8, before it; older plugins clamp) | radius, containers (20 nearest) [{type, x, y, z, distance, direction, name?, used_slots, top {id: count}, inside_containers?}], more_containers. Since plugin 5.5, only containers the asker could open: outside a GriefPrevention claim or with container trust in it, and never an unopened structure chest. Since plugin 5.7 a double chest counts once, the containers found glow for the asker with a label (`highlighted`), and a way button goes under the answer when the nearest is far or out of sight |
| `find_item` | `{ "item": "diamond", "radius"?: 1–52 }` default 32 (1–24, default 16, in plugin 5.14.1; 1–12, default 8, before it; older plugins clamp) | query, matched_ids (when `item` isn't an exact id and matched as part of ids), total, radius, places (up to 30) [{where: inventory \| offhand \| armor \| enderchest, slot, count, inside?} or {where: container, type, x, y, z, distance, direction, name?, count, inside_boxes?}], more_places. Counts shulker boxes and bundles one level deep. Since plugin 5.5, only containers the asker could open: outside a GriefPrevention claim or with container trust in it, and never an unopened structure chest. Since plugin 5.7 a double chest counts once, the containers found glow for the asker with a label (`highlighted`), and a way button goes under the answer when the nearest is far or out of sight |
| `inspect_item` | `{ "from"?: "hand" \| "offhand" \| "head" \| "chest" \| "legs" \| "feet" \| "inventory" \| "enderchest" \| "container", "slot"?: 0–53, "inner_slot"?: 0–63 }` | One item in full: `from`, `slot`, with `inner_slot` also `inside` and `inner_slot`, then everything an item has (below), plus lore (≤ 10 lines), unbreakable, attributes [{attribute, amount, operation, slot}], tooltip {attack_damage, attack_speed}, effects [{type, level, seconds \| instant}], dye_color, repair_cost, book {title?, author?, generation?, pages}, firework {flight?, explosions [{shape, colors, fade_colors?, trail?, twinkle?}]}, map {scale_level, blocks_per_side, center_x, center_z, dimension, locked, player_inside}, contents [item with slot] up to 27 and more_stacks. `slot` is required for inventory (0–35), enderchest (0–26), and container (the one under the crosshair, 6 blocks); `inner_slot` reads that slot inside the shulker box or bundle found there |
| `get_item_durability` | – | items [{from, slot?, id, damage, max_damage, percent_left, unbreaking?, expected_uses?, mending?, almost_broken?}] for armor, offhand, and every inventory slot (0–8 the hotbar) |
| `get_xp_info` | `{ "target_level"?: 0–100 }` | level, progress, total_points, points_to_next_level, target_level?, points_to_target? |
| `get_food_options` | – | food, saturation, food_missing, foods [{id, count, nutrition, saturation, note?}] |
| `get_anvil_plan` | `{ "item"?: "diamond_sword", "slot"?: 0–40, "enchantments"?: { "sharpness": 5, "mending": 1 }, "slots"?: [0–40] }` | Since plugin 6.12 for any item the player has, wherever it lies: `slot` names it (0–35 the inventory, 36–39 boots to helmet, 40 the offhand), `item` by id, part of one (`sword`), or name in any language (`hand` is the hand, or the tool's own pick when the hand is empty); with neither the tool picks the item in hand when the books improve it, else the only item they improve, else answers `{ found: false, reason, choose: [{slot, where, item, gain}] }` for the model to ask. Results carry the item's `target` (where) and `slot`. Before 6.12, for the item in hand only. With `enchantments`: ideal books, as item, item_repair_cost, steps [{left, right, levels}] where pieces are `item` or `<enchantment> <level>`, total_levels, too_expensive. Without (plugin 5.3+): what the player has, the enchanted books and enchanted items of the same kind in the inventory (or only `slots`), priced as the game does: found, item, pieces [{piece: `hand` \| `hotbar N` \| `inventory row R column C`, slot?, kind, enchantments, repair_cost}], steps [{left, right, levels, gives}], result, total_levels, too_expensive, unused?; `{ found: false, reason }` when nothing improves the item |
| `inspect_redstone` | `{ "radius"?: 1–10, "around"?: "look" \| "player" }` default 6, look | Since plugin 5.6. Every redstone part within the radius (80 nearest the center): `{ id, x, y, z, … }` with dust `power` and `connects`, repeaters `input_from`, `outputs`, `delay_ticks`, `powered`, `locked`?, comparators `mode`, observers `watches`, pistons `pushes`, `extended`, `sticky`, and `received` for mechanisms; `issues [{ id, x, y, z, issue, detail }]` with `dust_dot`, `torch_burned_out`, `piston_jammed`, `hopper_locked`, `repeater_locked`, `dust_runs_past`. Only blocks where the asker may build (outside claims, or with build trust in GriefPrevention); refused when the center is in someone else's claim |
| `get_brewing_recipe` | `{ "potion": "night_vision", "form"?: "potion" \| "splash_potion" \| "lingering_potion" }` | Since plugin 5.3, read from the game's brewing recipes (26.3 keeps them as data): potion, form, steps [{bottle, add, makes}] from a water bottle, fuel. Drink first, then gunpowder and dragon's breath turn the bottle. Since plugin 6.12 the server's brews count too (mods' and data packs' recipes, Paper plugins' potion mixes made of items, expansions' brews), `potion` may be a name in any language (`infestation` and «зелье заражения» find `infested`), and a plugin's own bottle reads as its id alone (`redbull:crude_taurine`) |
| `get_brewing_items` | – | inventory [item] for brewing, brewing_stands (up to 4 within 8 blocks) [{x, y, z, distance, direction, fuel_level, seconds_left?, ingredient?, fuel?, bottles}] |
| `point_to` | `{ "x", "z", "y"?, "dimension"?, "label"?, "seconds"?: 1–3600, "style"? }` or `{ "player", "seconds"?, "style"? }` | Points the compass and draws a trail only the player sees. Since plugin 5.3: `seconds` up to `tools.point_to.max_seconds` (600 by default; older plugins allow 30 and refuse more), 30 by default (since plugin 6.22.1, a spot farther than 60 blocks gets about a second for every two blocks, up to `max_seconds`); the trail ends when the player arrives, and a new one replaces the old. `style` is `sparkle` (default), `flame`, `soul`, `glow`, `magic`, `spark`, `cherry`, `notes`, `hearts`, `snow`, `totem`, or `happy`; older plugins ignore it. A `dimension` other than the player's is refused. Returns `{ distance, direction, seconds?, style?, compass, action_bar? }`; since plugin 6.21, `action_bar` says whether an arrow toward the spot and the blocks left show above the hotbar (`tools.point_to.action_bar`). Since plugin 5.4, `player` instead of `x` and `z`: a trail that follows that player while they're on the asker's locator bar (as `get_nearby_players` says), goes dark while they hide, and ends when the asker reaches them, when they leave, or after 15 s off the bar; `seconds` defaults to `tools.point_to.follow_seconds` (180). A player off the bar is refused. Returns `{ player, distance, direction, seconds, style, follows, compass, action_bar? }` |
| `show_marks` | `{ "marks"?: [{ "x", "y", "z", "block"?, "label"?: "≤ 48", "color"? }] (≤ 64), "seconds"?, "clear"?: true }` | Since plugin 5.5. Display entities only the asker sees, glowing through walls: a stained-glass box hugging the block there, or with `block`, a smaller ghost of that block on a free spot, each with an optional text label. `color` is `yellow` (boxes by default), `green`, `red`, `blue`, `aqua` (ghosts by default), `purple`, `orange`, or `white`. Refused per mark: farther than `tools.show_marks.radius` (48), ores, spawners, and vaults, containers the asker couldn't open (a GriefPrevention claim without container trust, or an unopened structure chest), a ghost on an occupied block. A new call replaces the set; they go after `seconds` (`tools.show_marks.default_seconds` 120, at most `max_seconds` 600), on `/allay cancel`, or when the player leaves; a ghost goes out once the player places a block on it. Returns `{ shown, seconds, refused?: [{x, y, z, reason}] }`, or `{ cleared }` |
| `show_draft` | `{ "action"?: "show" \| "add" \| "layer" \| "move" \| "rotate" \| "check" \| "clear", "title"?, "palette"?: [{ "char", "block": "id[states]", "label"? }], "layers"?: [[row]], "offset"?: { "right"?, "up"?, "forward"? }, "x"?, "y"?, "z"?, "y_offset"?, "layer"?: 1–15 \| "next" \| "prev" \| "all", "turns"?: 1–3 }` | Since plugin 5.6. A build up to 20 × 15 × 20 (width × height × depth) as ghosts only the asker sees, one layer at a time; the plugin checks the layer every 10 ticks, puts a red box with what belongs there on a wrong block, moves on when a layer is done, and counts in a boss bar. Written facing north: `right` east, `forward` north; layers bottom up, rows far to near, characters left to right; `.` or a space leaves a cell alone, `air` must stay empty. Only the states a palette entry spells out are checked (dust's are never). Labels show for entries used at most 6 times. `show` starts two blocks ahead, centered, at the feet plus `y_offset`, or at the corner `x`, `y`, `z`, and replaces the old draft; `add` merges cells at a non-negative `offset`; `move` shifts by `offset`; `rotate` turns clockwise around the middle; `check` returns `{ title, done, total, layers [{layer, done, total}], wrong [{layer, x, y, z, wanted, found}] (20) }`. Refused in a claim where the asker may not build, farther than 32 blocks, or over the size. One draft per player, in memory: `/allay cancel`, leaving, or a restart drops it. Returns `{ title, size, blocks, layer, corner, facing }` |
| `ping_me` | – | Note particles and a sound over the player that everyone nearby sees and hears; `{ pinged, y }` |
| `sort_inventory` | `{ "undo"?: bool (5.11+), "hotbar"?: bool, "offhand"?: bool, "pins"?: [{ "slot": 1–9 \| "inventory:1"–"inventory:27" (5.8+) \| "offhand", "item": "sword" \| "golden_apple" \| "potion:healing" }] }` (since plugin 5.7) | Merges stacks and sorts slots 9–35 by id, plus the hotbar and offhand when asked; pins put the best matching item (an id or a group) in a slot first. Since plugin 5.7.1 a sorted hotbar holds the pins (or, without pins, its hand items) and takes other items only when the main inventory is full; `layout` (5.8+): `{ order?, zones?: [{ items, where: row:N \| row:last \| column:N \| column:last \| slots:A-B \| start \| end }], by?: name \| category \| count, rows?, keep?, merge_only? }`, items as ids, groups, materials, categories, enchanted, named, damaged. `{ merged_stacks, pinned?, not_found?, hotbar, offhand, rows }`; `undo` puts back the last sort or chest change and returns `{ restored, chests_restored? }`, hotbar as 9 ids or null (5.7.1+), rows as the main inventory's 3 rows of 9 (5.8+) |
| `reminders` | `{ "action"?: "add" \| "list" \| "cancel", "minutes"?: 1–120, "text"?: "≤ 100", "id"?, "all"? }` | add: `{ id, minutes, text }`, a chat line with a sound after the delay (10 pending per player by default, `tools.reminders.max_pending`; lost on a restart or when the player leaves). list (default): `{ reminders: [{id, text, minutes_left, due_at}] }`. cancel by `id` or `all`: `{ cancelled }` |
| `goals` | `{ "action"?: "set" \| "list" \| "cancel", "kind"?, "title"?, "target"?, "statistic"?, "item"?, "entity"?, "advancement"?, "x"?, "z"?, "radius"?, "biome"?, "dimension"?, "color"?, "style"?, "id"?, "all"? }` | set: a boss bar goal counted from now; kinds `stat`, `pickup`, `level`, `advancement`, `reach`, `biome`, `dimension`; statistics in centimeters take `target` in blocks; ends with a sound and a chat line; returns `{ id, kind, title, progress, target }`. list (default): `{ goals: [{id, kind, title, progress, target, done?}] }`. cancel by `id` or `all`: `{ cancelled }` |
| `write_book` | `{ "title": "≤ 32", "text": "≤ 8000" }` | Writes the text into a book and adds buttons to open and take it under the answer; returns `{ pages }` |
| `set_timezone` | `{ "zone": "Asia/Yekaterinburg" }` | Stores the player's IANA zone for later requests; returns `{ zone, local_time }` |
| `get_allay_guide` | – | Since 4.0 (3.x calls it `get_buddy_guide`). How Allay works for this player here: plugin_version, commands [{usage, does}] they have permission for, chat_mode {prefixes {"!", "?", "~"}: what each does, only those this player may use}, settings {chat_mode, hints, timezone}, features [names of what the server has on: notes, goals, reminders, windows, books, buttons, compass, sorting, operator_tools], limits {notes, reminders, goals, public_cooldown_seconds} |
| `allay_settings` | `{ "chat_mode"?: bool, "hints"?: bool }` | Since 4.0 (3.x calls it `buddy_settings`). Changes the player's settings, as `/allay chat` and `/allay hints` do; turning chat mode on also sends the plugin's explanation. Returns `{ chat_mode, hints }`. An action: not for `askx` |

A plugin before 4.0 offered the guide and the settings as `get_buddy_guide` and `buddy_settings`; since 6.16 the backend no longer knows those names.

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
| `wait` | task | `{ "seconds"?: 10–3600 }` (1–600 before 6.22) | Ends the wake. The plugin clamps `seconds` to at least 10 and at most `automation.max_wait_seconds` (600 by default, up to 3600). Since plugin 6.22 a `wait` without `seconds` while nothing else can wake the agent (no job, no sub-agent, no line or question to the player) counts as a silent wake: the agent is told once, then stopped. The plugin wakes the task with `[player] …` on an answer, `[button] …` on a click, `[job] …` when its job ends (smelting or brewing done, a picking mode closed), `[sub-agent] …` when a sub-agent it started ends (since 5.10.1), `[parent «name»] …` from the agent that started it (plugin 5.14+), or `[timer] …` after `seconds` |
| `finish` | task | `{ "summary": "≤ 500", "handoff"?: bool (server 5.12+) }` | Ends the task; the player sees `summary`. Since plugin 5.14, refused while a sub-agent of the task runs, unless `handoff` is true: the agent would never hear the report it needs. With `handoff`, the sub-agents carry on and report to the player themselves |
| `pick_blocks` | task | `{ "kind": "chests" \| "furnaces" \| "brewing_stands", "looking"?: bool }` | A picking mode with [Done] [All] [Cancel]; its end wakes the task with `[job] …`. `looking` takes the block under the crosshair at once and returns it |
| `chests` | task | `{ "action": "read" \| "plan" \| "apply" \| "undo", "mode"?: "sort" \| "group" \| "move" \| "take" (5.11+) \| "stash" (5.11+), "layout"?: as in sort_inventory (5.8+, sort and group), "chests"?: [xyz] (≤ 64), "assign"?: [{ x, y, z, "category"?, "items"?: [id] (≤ 27) }] (≤ 64), "items"?: [selector] (ids before 5.11), "categories"?: [category], "count"?: 1–2304 (5.11+), "amounts"?: [{ "item": selector, "count"? \| "up_to"? (take) }] (≤ 16, 5.11.1+), "up_to"?: 1–2304 (5.11+, take), "keep"?: [selector] (5.11+), "hotbar"?: bool (5.11+, stash), "to"?: [xyz] (≤ 64), "from"?: ["inventory" \| "nearby"] (5.10.2+) }` | Reads chests (contents, signs, item frames, problems, `only_adding` for a sorter's input), plans a sort, a grouping, a move, a take into the inventory, or a stash of the inventory as a preview, applies it, or undoes the last apply (the last five since 5.11). Copper chests and placed shulker boxes count as chests since 5.11 |
| `smelt` | task | `{ "action": "scan" \| "start" \| "add" (5.11+) \| "fuel" (5.10+) \| "status" \| "collect", "item"?, "count"?: 1–4096, "items"?: [{ "item", "count"? }] (≤ 8), "furnaces"?: [xyz] (≤ 16), "fuel"?, "each"?, "up_to"?, "need"?, "types"?, "to"?: "inventory" \| "auto" (5.11+) \| [xyz] (1–8), "remember"?: bool (5.11+) }` | Furnaces, blast furnaces, and smokers near the player; several items split by each furnace's speed. Since 5.11 `to` on start empties full furnaces and the rest at the end, collect pays the furnace's experience, `add` adds more of what the job cooks, and planks, sticks, bamboo, and lava burn |
| `brew` | task | `{ "action": "scan" \| "start" \| "status" \| "collect", "potion"?, "form"?: "potion" \| "splash_potion" \| "lingering_potion", "bottles"?: 1–64, "potions"?: [{ "potion", "form"?, "bottles"? }] (1–4, 5.11+), "fresh"?: bool, "stands"?: [xyz] (≤ 8), "to"?: "inventory" \| "auto" (5.11+) \| [xyz] (1–8), "remember"?: bool (5.11+) }` | Brewing stands near the player. Since 5.11 several potions at once, rounds on the same stands past three bottles a stand, water bottles filled from glass bottles at water or a cauldron, and `to` on start delivers by itself |
| `craft` | task | `{ "item", "count"?: 1–64, "dry_run"?: bool }` | Crafts at a crafting table near the player. Since plugin 6.19 a plan that smelts first crafts only what the furnaces need (raw iron from its block) and answers `{ crafted: false, smelt: {id: n}, crafted_for_the_furnace?: ["N × id"], note }`; a furnaces agent smelts, then `craft` runs again. Missing answers carry `missing_for` as `get_recipes`' plan does, and netherite gear crafts the diamond piece from diamonds when the player has none |
| `grindstone` | task | `{ "action"?: "plan" \| "apply", "item"?: "hand" \| id, "combine"?: bool }` | Since plugin 6.19. A grindstone near the player in plain sight, as the game's: takes every enchantment but curses off the item (a book with none left turns plain) and drops their experience at it, or with `combine` joins a second piece of the same item from the player's things (both durabilities plus 5% of the maximum, enchantments but curses gone from both). plan answers item, grindstone {x, y, z}, takes_off {id: level}, curses_stay?, with? {item, from, durability, enchantments_lost?}, durability? {before, after, max}, experience (“23–45”), levels 0; apply adds done and the experience dropped. No levels, no wear |

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

## Expansions

Since backend 6.14 and plugin 6.12. Other plugins and mods add tools, items, recipes, and prompt lines to Allay through its expansion API, the Java library `chat.allay:allay-expansion` (the plugin's wiki, “Expansions”, tells how to write one). The plugin sends what reaches the backend with each `ask` and `askx`:

```json
"expansion_tools": [
  { "name": "x_mana_status", "description": "The asking player's mana…", "parameters": { "type": "object", "properties": {}, "required": [] }, "access": "read", "expansion": "mana" }
],
"expansions": [
  { "id": "mana", "name": "Mana", "version": "1.0.0", "prompt": "Mana adds spells cast with a wand…" }
]
```

- `name` is `x_<expansion>_<tool>`: `x_`, then `[a-z0-9_]{1,24}`, `_`, and `[a-z0-9_]{1,32}`. `description` is 1–1000 characters, `parameters` a JSON Schema object, `access` `read` (reads the game), `own` (changes only the asker's own things), or `operator`. At most 32 tools and 16 expansions; `prompt` at most 2000 characters. A bad entry is dropped, not the request.
- The plugin sends only the tools this asker may use here: `operator` ones for operators, only `read` ones in `askx`, only those the expansion marks for public questions in a public `ask`, each behind the expansion's own permission, and none for the console or an automation agent. The backend checks access and mode again, and gives an agent (`task`) neither tools nor prompts.
- The model gets the tools after Allay's own, so their fixed order keeps the provider's prompt cache. Each description starts with `[Name, a plugin on this server]`, and the schema keeps only `type`, `description`, `properties`, `required`, `items`, `enum`, and the numeric bounds, four levels deep, with every field required and the optional ones nullable, as for Allay's own tools.
- A call goes to the plugin as any client tool, `tool_call` with the tool's `name`, and its result comes back the same way. The plugin runs only a tool this run offered, checks the asker's rights again, and cuts a result at 8000 characters; the backend at 10 000.
- The prompt gets a section “Plugins and mods that extend you”, after the base prompt and before “This conversation”: one line that frames what follows as the server's plugins' notes, under Allay's own rules, and then each expansion's `prompt` under “## Name's plugin prompt”.

## Server tools (run by the backend)

| Name | Args | Notes |
|---|---|---|
| `search_web` | `{ "query": "…", "sites"?: [domain], "recency"?: "day" \| "week" \| "month" \| "year" }` | Since 5.5, with the backend's `PERPLEXITY_API_KEY` and no server key: Perplexity's Search API, up to 5 results {title, url, date?, snippet}. Otherwise, and for BYOK: `{ "query" }` through the search model, a summary with source URLs |
| `exact_calculations` | `{ "expressions": ["ceil(1000 / 64)", "(-1024 / 8)", "3 hours to seconds"] }` | Up to 10 expressions, each ≤ 300 chars, evaluated with math.js at 64 significant digits (units and conversions work). Returns `[{ expression, result }]` or `{ expression, error }` per line; each expression gets 1 s |
| `memories` | `{ "action"?: "add" \| "find" \| "delete", "text"?: "≤ 200", "here"?: bool, "x"?, "y"?, "z"?, "dimension"?, "query"?: "≤ 100", "near"?: bool, "limit"?: 1–50, "id"? }` | Since 6.9, replacing `remember` and `forget`. add saves a fact, or a place with `here` (from `player.position`) or `x`, `z` (and `y`, `dimension`): `{ saved: { id, text, x?, y?, z?, dimension?, world?, distance?, direction?, created_at } }`; at most `MEMORY_MAX` (200) per player. find (default): `{ matched, total, memories: [...] }`, newest first or nearest with `near`, all of them when no word of `query` matches. delete: `{ deleted: id }` |

All server tools report progress only through `tool_status` (kind `server`).

## Automation agents

Since 5.5, for plugin 5.7. The chat hands work in the world (sorting chests, smelting, brewing, crafting) to an automation agent with `start_task`. The agent runs in wakes: each wake is an ordinary `POST /api/v2/chat` with `mode: "task"` and the `task` block, which the plugin opens when the task starts and every time something wakes it. No stream stays open and no tokens go while it waits.

- **Message.** The first wake's `message` is the brief from `start_task`. Later ones say what woke it: `[player] …`, `[button] …`, `[job] …`, `[sub-agent] …`, `[parent «name»] …`, `[timer] …`, or `[plugin] …`, one per line, oldest first. The plugin keeps a message within 2000 characters; since plugin 5.14 what doesn't fit waits for the next wake instead of being cut off. Since plugin 6.22 the words of `[player]` and `[button]` stay on their line, so nothing a player wrote starts a line that reads as the plugin's.
- **Plugin notes.** `[plugin] …` comes from the plugin itself: a wake that ended without a word, or (since plugin 6.22) a wake that broke off midway (`AI_REQUEST_FAILED`, `NETWORK_ERROR`, or the stream cut by a restart). That one goes on once, after a backoff, with the note that tools may have run, what its tools reported, and the message it had woken with; it never repeats as it was. A wake the backend never took (`RATE_LIMITED`, `QUEUE_ERROR`, a 502–504, no connection) goes again as it was, up to three times, after 15, 45, and 135 seconds, and doesn't count toward `automation.max_wakes`; what arrives meanwhile waits for it.
- **Sub-agent reports.** When a sub-agent ends, the plugin wakes the agent that started it with `[sub-agent] «name» (kind, id) finished: <summary>` or `stopped: <why>` (cancelled, interference, an error, the time or wake limit, the quota, the player leaving). Since plugin 5.14 a second line follows when the sub-agent's tools did something: `What its tools reported: …`, the plugin's own English record of what was crafted, smelted, brewed, collected, moved, or put on an anvil, with counts and where it went (at most six, newest last), so the parent can act on facts rather than the summary alone. Older backends read it as text.
- **Ending.** Since plugin 5.14, stopping an agent (`/allay cancel`, `cancel_task`, interference, the limits) also cancels its wake if one is out, and its tools refuse to act for it from then on. Since plugin 6.22 every wake checks again that the kind is switched on, the player still has the permission, and still agrees to the notice, and ends the agent otherwise; erasing a player's data stops their agents first.
- **End of a wake.** The agent ends every wake with `wait` or `finish`. Its final text, often empty, is a note for its own next wake; the backend records it and the plugin doesn't show it. An empty final text is not an error in task mode: `done` comes with `answer: ""`.
- **Steps.** A wake gets up to `MAX_TASK_STEPS` model steps (32 by default since 6.9), against `MAX_AGENT_STEPS` (26) for a question.
- **Tools.** A wake gets the client tools the plugin offers minus operator tools, `write_book`, and `get_nearby_players`; `start_task`, `message_task`, and `cancel_task` only at depth 1 (before server 5.12, only `start_task`). Server tools: `exact_calculations` only, no `search_web`, no `memories`. The prompt still shows the player's memories, read-only.
- **Prompt.** `minecraft-task.md` plus the agent's name, kind, and depth, and the player.
- **Depth.** The chat is depth 0. A task the chat starts is 1, a task started by a task is 2 and can't start another.

| Mode | Gets | Never gets |
|---|---|---|
| `ask` | `start_task`, `message_task`, `cancel_task` | `say`, `wait`, `finish`, `pick_blocks`, `chests`, `smelt`, `brew`, `craft` |
| public `ask` | — | all automation tools |
| `task` | `say`, `wait`, `finish`, `pick_blocks`, `chests`, `smelt`, `brew`, `craft`; `start_task`, `message_task`, `cancel_task` at depth 1 | operator tools, `write_book`, `get_nearby_players`, `search_web`, `memories` |
| `askx` | — | all automation tools |

## Conversation memory

The backend keeps these per tenant and `user_id` (since 6.0; before, per `user_id` alone):

- **The session.** Whole exchanges verbatim (since 5.5 with the tool calls and their results, whole) plus a summary of everything older. The backend folds all but the newest 12 000 tokens (2 to 30 exchanges) into the summary with the model after an answer once the session passes about 32 000 tokens or 100 exchanges, and before an answer past 42 000. A quiet session isn't folded; it expires. A session lives `CHAT_TTL_SECONDS` after the last question, 30 days by default since 6.9 (a day before). `/askx` requests land in it as one short exchange (the request and the commands or the refusal), so a later `/ask` knows what was done.
- **The server's public thread** (since 3.0). Public questions with a `server.id` go to the tenant's thread for that id instead of the asker's session, each question prefixed with the asker's name in brackets, so a follow-up from another player continues the talk. It folds like a session and lives 2 hours after the last question (`PUBLIC_CHAT_TTL_SECONDS`). Without `server.id` a public question uses the asker's session.
- **A task's thread** (since 5.5). Each wake of an automation agent reads and extends its own thread under the player and `task.id`: the wake's message and the agent's final text, or `(waiting)` when it ended without one. It folds like a session and lives 2 hours after the last wake (`TASK_CHAT_TTL_SECONDS`). The player's session never sees it.
- **Memories.** Lasting facts and, since 6.9, places the model saves with `memories`, kept in MongoDB until the player deletes them or, since 6.0, 365 days after their last question. The 30 newest facts without a place go into the system prompt with their ids, with a count of the rest.
- **Deaths and state** (since 6.9). The newest `DEATHS_MAX` (100) deaths and the plugin's state for the player (time zone, settings, goals), 365 days after the last question.
- **The player's name** (since 6.4). `player.name`, `user_id`, and `player.op` from the player's last question, so the admin panel can name them; kept 730 days after the last question (400 before 6.9).

Since 6.9 every one of these is sealed in MongoDB with AES-256-GCM (a random 96-bit IV per value), under a key derived with HMAC-SHA256 from the backend's `SECRETS_KEY` (or `/data/secrets.key`), as are traces' prompts, answers, and tool data. A dump or a backup alone reads none of it. Data written in the clear before 6.9 still reads, and goes as it expires.

Endpoints for the plugin's `/allay new`, `/allay memory [text]`, `/allay forget`, and (since 6.0) `/allay privacy`, and (since 6.1) the consent a player gives before their first question, all with `Authorization`:

| Request | Answer |
|---|---|
| `GET /api/v2/users/{user_id}` | Since 6.0. `200` with everything kept about the player: `{ user_id, tenant, pseudonym, name, memories, deaths, state, consent, session: { summary?, messages }, outcomes, tasks: { <task id>: session }, runs: [{ at, kind, model, input_tokens, output_tokens, cost, duration_ms, result }], retention }` (`deaths` and `state` since 6.9) |
| `DELETE /api/v2/users/{user_id}` | Since 6.0. `200 { "erased": true, "memories": 3, "deaths": 7, "runs": 12, "traces": 40 }`: memories, deaths and state (since 6.9), open export links, the consent (since 6.1), the name (since 6.4), session, pending outcomes, and agents' threads go; the player's runs keep only numbers under `erased`; their traces go. The tenant's public thread expires by itself within 2 hours |
| `POST /api/v2/users/{user_id}/export` | Since 6.9. `200 { "url": "<PUBLIC_URL>/api/v2/exports/<token>", "expires_at": "ISO-8601" }`: a link to the player's copy, good for 24 hours and any number of downloads. The token is 32 random bytes; the backend keeps only its SHA-256 |
| `GET /api/v2/exports/{token}` | Since 6.9, without `Authorization`: the token is the key. `200`, a JSON attachment with what `GET /api/v2/users/{user_id}` returns; `404` for a wrong, expired, or erased link, the same for each |
| `POST /api/v2/users/{user_id}/deaths` with `{ "at": ms, "world", "dimension", "x", "y", "z", "cause"?, "killer"?, "killer_name"?, "message"? (≤ 256), "level", "kept_inventory"?, "drops"?: { id: count } (≤ 20 kinds), "experience"? }` | Since 6.9. The plugin reports a death as it happens: `200 { "saved": true }`. Ids are as the game gives them (`minecraft:lava`); `at` more than a day ahead is `400`. A death at an `at` already kept for the player is a no-op answering `200`, so a retry is safe. The newest `DEATHS_MAX` stay |
| `GET /api/v2/users/{user_id}/state` | Since 6.9. `200 { "state": { "timezone"?, "settings"?, "goals"? } \| null, "updated_at": "ISO-8601" \| null }` |
| `PUT /api/v2/users/{user_id}/state` with `{ "timezone"?: "≤ 64", "settings"?: { … }, "goals"?: [ … ≤ 100 ] }` | Since 6.9. Replaces the player's state whole, at most 32 KB of JSON; the backend checks the shape, not what `settings` and `goals` hold. `200` with the same body as `GET` |
| `DELETE /api/v2/users/{user_id}/session` | `200 { "cleared": true }`; memories stay |
| `GET /api/v2/users/{user_id}/consent` | Since 6.1. `200 { "consent": { "version": 1, "accepted_at": "ISO-8601" } }`, or `{ "consent": null }` when the player hasn't agreed. Since 6.9 the consent adds `hash` and `revision` when it has them and always `age_confirmed` (false when the player wasn't asked), and the answer adds `revision`, the privacy policy's current revision (a date, also in `/api/health`): the plugin hashes its notice with it and asks again when the hash differs from the stored one |
| `PUT /api/v2/server` with `{ id, name?, motd?, software?, version?, plugin_version?, address?, port?, loader?, side? }` | Since 6.7. The plugin registers its server at start. `name` (2–32 letters, digits, spaces, or `. _ ' -`) belongs to one server on the backend: `409 NAME_TAKEN` when another tenant's server holds it; a server of the same tenant takes it over. `200 { "registered": true, "name" }` |
| `PUT /api/v2/users/{user_id}/privacy` with `{ "full": true }` | Since 6.5. The player turned full privacy on (`true`) or off: on, the admin panel forgets their name, UUID, and face at once: `200 { "full": true, "forgotten": true }`. Off changes nothing until the next question without `player.private`. The plugin keeps the switch |
| `PUT /api/v2/users/{user_id}/consent` with `{ "version": 1, "hash"?: "64 hex", "age_confirmed"?: true, "age_band"?: "16_17" }` | Since 6.1. Records that the player agreed to the plugin's notice of that version (a whole number, 1–1000), replacing an older agreement whole: `200 { "consent": { "version", "hash"?, "revision", "age_confirmed"?, "accepted_at" }, "revision" }`. Since 6.9 `hash` is the SHA-256 (hex) of the English notice texts the plugin showed, joined by newlines, a newline, and the revision; `revision` is the policy's revision then; `age_confirmed` says the player is old enough to agree where they play, and `age_band` is the age group they picked (`under_13`, `13`, `14_15`, `16_17`, `18_plus`), which plugin 6.7 asks every player. An agreement goes with the player 730 days after their last question |
| `DELETE /api/v2/users/{user_id}/consent` | Since 6.1. `200 { "withdrawn": true }`, or `false` when there was none. Since 6.9 it also erases what the agreement covered, memories and places, deaths, state, export links, the session, pending outcomes, and agents' threads, and answers `{ "withdrawn", "memories", "deaths" }` with the counts; the record stays, marked `withdrawn_at` in the player's copy, as proof, and `GET` answers `null` until the player agrees again. Before 6.9 what was kept stayed until erased |
| `GET /api/v2/users/{user_id}/memories` | `200 { "memories": [{ "id": "k3f9a", "text": "…", "place"?: { "x", "y", "z", "dimension", "world"? }, "created_at": "ISO-8601" }] }`, oldest first; `place` since 6.9 |
| `POST /api/v2/users/{user_id}/memories` with `{ "text": "3–200 chars", "place"?: { "x", "y", "z", "dimension", "world"? } }` | `200 { "memory": { "id", "text", "place"?, "created_at" } }`; `409 MEMORY_FULL` at `MEMORY_MAX` (200 since 6.9, 30 before); `400` for other text. Since 5.1; `place` since 6.9, for the plugin's note buttons |
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
| `SOLO_PLAYER_TAKEN` | 403 | Since 6.12: a Solo license answers the first player who asked on it, and this is another one (also from `/api/v1/ask` and `/api/v1/askx`). The payer hands it to another player in the bot, an admin in the panel |
| `CONSENT_REQUIRED` | 403 | Since 6.9, on a hosted backend: the player has no agreement in force on this server, so the backend runs, traces, and keeps nothing (also from `/api/v1/ask` and `/api/v1/askx`, and `POST /memories`, `POST /deaths`, `PUT /state`). `console` and requests without a player pass. The plugin shows the notice again |

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

Both `POST`s take an optional body `{ "name": "…", "loader"?, "side"? }`: `name` (≤ 64 chars) is the server's name as the bot shows it to the payer; the plugin sends its MOTD without formatting codes. Since 6.12, a new license whose `side` is `integrated` or `client` is a **Solo** license while the backend sells Solo plans (`SOLO_PLANS`); every other is a server's. A Solo license serves one player: the first who asks on it takes it, by pseudonym, and anyone else gets `SOLO_PLAYER_TAKEN`.

The status:

```json
{
  "billing": true,
  "license_id": "k3f9a2…",
  "linked": true,                         // a Telegram account claimed it
  "active": true,
  "kind": "server",                       // since 6.12: server, or solo for one player
  "bound": true,                          // solo only: a player has it
  "plan": "month",                        // week | month | year | solo_week | solo_month | solo_year; null before the first payment
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
| `infinity` | not sold | 366 days | $1000 for the whole period (`PLAN_INFINITY_BUDGET`); since 6.9 an owner grants it in the admin panel |

A payment while a period runs adds its budget at once and moves `paid_until` further.

Since 6.12 a Solo license buys Solo plans instead, and a server's license never does. The bot sells them only while `SOLO_PLANS` is on (off until the mods ship):

| Plan | Stars | Period | Budget |
|---|---|---|---|
| `solo_week` | 50 | 7 days | $0.25 |
| `solo_month` | 150 | 30 days, renews by itself as a Stars subscription | $1.00 |
| `solo_year` | 3000 | 365 days | $2.00 a month, refilled every 30 days |

In `/status` the payer hands a Solo license to another player, once every `SOLO_RELEASE_DAYS` (30); an admin may in the panel any time.

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

`GET /api/health` answers `{ "name": "Allay", "status": "ok", "version", "billing", "policy_revision" }`; since 6.0 nothing about the process, and since 6.9 the privacy policy's revision.

| Plugin | Server before 6.0 | Server 6.0 |
|---|---|---|
| Allay 5.x | Works | `401` everywhere: it sends no token, and a BYOK server sends no license |
| Allay 6.0 | Works; a self-hosted backend ignores the token | Works |

Since server 6.11 buttons come inline in the answer text (see “Buttons in the answer”) and the tool that put buttons under the answer is gone. Allay 6.8 and older keep working against it, but show the tags as text; Allay 6.9 or newer is needed for buttons.

Since server 6.9 the backend keeps what the plugin kept on disk. Allay 6.6 and older keep working against it: their own death history and their files stay as they were until the plugin updates, but since 6.16 the model no longer gets their notes tool. Allay 6.7 needs server 6.9: against an older backend its deaths, state, and export link answer `404`, and it keeps them in memory only.
