# Changelog

The “Release” workflow takes the notes for a version from its section here, unless you type them into its `changelog` field.

## 5.6.0

For Allay 5.8; older plugins ignore `layout` and refuse main inventory pins.

- 🗂️ **Layouts.** `sort_inventory` and `chests` (sort and group) take `layout`: `order`, `zones` (`row:N`, `column:N`, `slots:A-B`, `start`, `end`), `by` (name, category, count), `rows`, `keep`, and `merge_only`, with items named by id, group, material, category, or `enchanted`, `named`, `damaged`. The chat and the chests agent learn to turn «сначала железо», «еда в последний ряд», and «не трогай книги» into it, and signs that say where things lie into zones.
- 📌 **Pins in the main inventory.** A `sort_inventory` pin takes `inventory:1`–`inventory:27` besides the hotbar's 1–9 and `offhand`, so “three bundles at the start of the inventory” works instead of a refusal.
- 🙅 **No opposite offers.** When a tool can't do what the player asked, the chat says so plainly instead of offering the opposite.

## 5.5.1

- 🧹 **`sort_inventory`** tells the model how a sorted hotbar works since plugin 5.7.1: with pins it holds just them, slots between pins stay empty, and the result's `hotbar` and `offhand` say what's really there, so the answer matches the game.

## 5.5.0

For Allay 5.7; older plugins keep working.

- 🤖 **Automation agents.** The chat hands work in the world to a background agent with `start_task`: sorting or grouping chests, moving items between them, smelting, brewing for the player, crafting. The prompt makes the chat write a full brief, with everything the player said and the language to talk in, since the agent starts with no history. It asks sort or group first when the player didn't say, and offers to brew a potion after explaining it. Sorting the player's own inventory stays `sort_inventory`, at once.
- ⏰ **Wakes.** An agent runs as `mode: "task"` requests, one per wake, with its own prompt (`minecraft-task.md`), up to 16 steps (`MAX_TASK_STEPS`), and its own thread `task:<user_id>:<task_id>` for 2 hours (`TASK_CHAT_TTL_SECONDS`). It talks to the player only through `say` with buttons, ends each wake with `wait` or `finish`, and leaves itself a one-line note; a wake that ends with no words is no error. It gets `pick_blocks`, `chests`, `smelt`, `brew`, and `craft`, and `start_task` for one level of sub-agents, but no web search, no memory tools (memories show read-only), no operator tools, no buttons, books, or locator bar.
- 💬 **Running tasks in the chat.** An ask lists the player's running tasks (`tasks`), and the chat passes free-text answers on with `message_task` or stops a task with `cancel_task`. A question everyone sees can't start or steer tasks.
- 🎒 **Pinned slots.** `sort_inventory` takes `hotbar`, `offhand`, and `pins` (plugin 5.7): “sword first, water second” puts the best sword in slot 1. The prompt saves a layout the player wants kept with `remember` and passes it back as pins.
- 🔥 **Several items in one smelt.** `smelt` takes `items` (plugin 5.7), and the prompts make “the iron and the gold” one start and a chain like “smelt, then make blocks” one furnaces agent that hands the crafting to its sub-agent. Pins name potions as `potion:healing`. `smelt` scan lists what the player has to smelt (`to_smelt_at_hand`), and start skips what they lack (`not_at_hand`).
- 🔦 **find_item lights up what it finds** (plugin 5.7) and adds the way button itself, so the prompt no longer asks for `show_marks` after it.
- 🗣️ **Agents tuned on real runs.** They talk to the player informally like Allay, apply a plan as soon as the player agrees, plan with the chests picked instead of asking for more, leave counting ingredients to the plugin, never finish a wake that asked something, and always leave themselves a note. The chat doesn't scan or look up recipes for an agent, and asks sort or group only when the player gave no hint.
- 🧰 **Fewer, clearer tools.** The model sees 35 tools instead of 45: `notes` adds, finds, and deletes notes; `inventory` covers the overview, repair, food, and brewing supplies; `locate` finds structures and biomes; `get_recipes` brews potions too; `get_locations` tells what lies at the death point; `get_player_status` carries the XP; `allay_settings` sets the time zone. The backend calls the plugin's own tools by their old names, so every plugin keeps working.
- 🪶 **A third fewer tokens per step.** Tool schemas went from 54 500 to 33 500 characters: every field goes to the model required and nullable in one small schema, instead of Mastra's strict layer that repeated each description. Left optional, the model filled every field with a placeholder, such as a note at 0 0 0. The prompt lost what the tools already say and the list of tool names, from 26 600 to 24 100 characters. Tools come in a fixed order, so the provider's cache holds whatever order a plugin sends.
- 🧠 **The session keeps tool results.** Each exchange goes into the session whole: the question, the tool calls with their results, whole, and the answer, so a follow-up needs no second call. It folds by size, not count: everything but the newest 12 000 tokens (`CHAT_KEEP_TOKENS`, 2 to 30 exchanges) goes into a summary of up to 3000 characters, which now notes what the tools found. That happens after an answer past about 32 000 tokens (`CHAT_FOLD_TOKENS`) or 100 exchanges, and before an answer past 42 000 (`CHAT_MAX_TOKENS`). A player who left costs nothing: the session just expires. A server's public thread keeps only the answers, since tool results belong to the asker. Sessions from before keep loading.
- 🔎 **Perplexity's Search API.** With `PERPLEXITY_API_KEY`, `search_web` reads up to five pages from Perplexity itself, in about a second instead of 13 and for $0.005 instead of $0.009, and may limit them to sites or a recent period. Without the key, and for servers with their own key, the search model answers as before.
- 🔭 **Traces.** Runs go into MongoDB through Mastra's observability, for Mastra Studio: each model step with its prompt, output, and tokens, and each tool call with its arguments and result, about 150 KB a run. A self-hosted backend traces every run and the hosted one a tenth (`TRACE_SAMPLE`); traces go after 7 days (`TRACE_DAYS`).
- ⬆️ **Mastra 1.78.**
- 🎚️ **A model per player on a self-hosted backend.** With billing off, a request without a key may name `provider.model`, and the run uses it on the backend's own key. With billing on, the backend still picks the model.

## 5.4.0

For Allay 5.6; older plugins keep working.

- 🏗️ **Drafts.** `show_draft` (plugin 5.6) draws any build up to 20×15×20 as ghosts the player builds into, layer by layer. The prompt writes it facing north, layers bottom up and rows far to near, spells out only the states that matter, and warns that a repeater's facing is where its signal comes from. Bigger builds go in parts instead of a refusal. For a redstone machine or an automatic farm the agent looks up a proven design first and traces the signal through its layers before drawing.
- 🔌 **Redstone.** `inspect_redstone` (plugin 5.6) reads the machine under the crosshair and the faults the plugin found by the game's rules; the agent explains the fault and its fix first, then marks it in red with `show_marks`.

## 5.3.0

For Allay 5.5; older plugins keep working.

- ✨ **Marks over blocks.** `show_marks` (plugin 5.5) draws glowing boxes, ghost blocks, and labels that only the asker sees. The prompt reaches for it whenever seeing beats coordinates: the chests `find_item` and `scan_nearby_containers` found, labeled with what's inside, ghost torches on the dark spots of `get_light_spawn_check`, a note or a death point close by. It marks only coordinates a tool returned, and what the plugin refuses (someone's claim, ores, spawners) it says briefly instead of retrying.

## 5.2.0

For Allay 5.4; older plugins keep working.

- 📍 **The way to another player.** `get_nearby_players` (plugin 5.4) lists who is on the asker's locator bar: names, distances, and directions, by the game's rules, plus the names of players online elsewhere without where they are. `point_to` takes `player` instead of `x` and `z`, and the plugin's trail follows that player. The prompt matches what the player says to a real name: a nickname they asked the agent to remember («shipilove — это Серёга»), a misspelling, a transliteration, a player named earlier in the conversation. When nobody fits or several do, it asks, with a way button for each.
- 🧠 **Nicknames are the one thing about other players the agent remembers**, and only when the player tells it.
- 🔘 **`add_buttons` takes up to six buttons**, and `point` takes `player`.
- 🔒 A public question goes without `get_nearby_players`: read out to everyone, the asker's locator bar would tell where others are.

## 5.1.0

For Allay 5.3; older plugins keep working.

- 🧭 **The agent knows which dimension the player is in.** The plugin now sends `player.dimension`, and the prompt places anything named without a dimension there. A Nether portal or a bastion a player asks to remember while standing in the Nether goes to the Nether, not to the overworld, and the agent never converts coordinates between dimensions unless asked.
- ✨ **Longer trails in many looks.** `point_to` takes `seconds` up to an hour (the plugin caps it, 10 minutes by default) and a `style`: sparkle, flame, soul, glow, magic, spark, cherry, notes, hearts, snow, totem, or happy. The agent uses what the player asks for, or picks by the walk ahead and the place.
- 🔘 **More buttons.** The agent offers a next question after most answers, a copy button next to every set of coordinates (`copy`, new), and buttons under public answers for everyone.
- 🧪 **`get_brewing_recipe`** (plugin 5.3): every step to any potion from the game's own recipes, so “how do I brew night vision?” no longer looks in the crafting recipes and comes back empty. A `brewing` button opens the steps in a window.
- ⚒️ **The anvil plans with what the player has.** `get_anvil_plan` without enchantments (plugin 5.3) takes the books and the second enchanted item from the inventory and prices every step as the game does; “how do I combine my two bows?” gets the order and the levels, and an `anvil` button opens the plan in a window.
- 🔥 Smelting gets a recipe button too.
- 🎨 **Coordinates and numbers stand out.** Coordinates always come as “X Y Z” in aqua, other numbers that matter in gold.
- 📝 **`POST /api/v2/users/{user_id}/memories`** saves a fact by hand for `/allay memory <text>`; `409 MEMORY_FULL` when 30 are kept.

## 5.0.0

For Allay 5.0. A server pays for the model with its own key or with a subscription in Telegram Stars. **A backend of your own needs `SELFHOSTED=1`:** without it, billing is on, and requests without a license or a key get `LICENSE_REQUIRED`.

- 🔑 **Bring your own key.** `X-Provider-Key` and a `provider` block (`base_url`, `model`, `search_model`) run the request on the server's own OpenRouter or any OpenAI-compatible API. The key lives for one run: never stored, never logged, blanked out of error messages. Before the run the backend checks the key and the model and answers `PROVIDER_AUTH_FAILED`, `MODEL_NOT_FOUND`, or `MODEL_NO_TOOLS`. Without a search model there's no `search_web`. With billing on, BYOK is free, limited to 20 questions a minute, 2000 a day, and 4 at once per server, and its base URL must be public `https://`.
- ⭐ **Subscriptions.** `POST /api/v2/license` makes a license and a one-time `t.me` link; `GET` answers its status. The backend serves its own Telegram bot through a webhook: `/start <code>` links the server, and the admin pays for a week (150 ⭐), a month (500 ⭐, a Stars subscription that renews), or a year (10 000 ⭐). Each plan is a budget in dollars of real model costs, counting web search and session summaries; a year refills monthly. Hosted requests carry `Authorization: Bearer <license>` and get `SUBSCRIPTION_INACTIVE` or `QUOTA_EXCEEDED` (with `resets_at`) when they can't run. `/status` in the bot shows every server and stops or resumes renewal; `/refund` is for the bot's admins.
- The old `X-OpenRouter-Token` keeps working, as BYOK with the backend's models. `/api/ask` and `/api/askx` follow the same rules.
- `/api/health` reports `billing`. Licenses, budget windows, and payments live in MongoDB next to the memories; a license's secret is kept only as SHA-256.

## 4.0.0

MCBuddy Server is now **Allay Server**, for Allay 4.0. Stored data stays as it was: chat sessions and public threads in Redis, memories in MongoDB.

- 🪽 **The agent is Allay.** The prompts introduce it as Allay, named after the friendly flying mob; it says so once when asked who it is, without playing the mob in its answers. “About MCBuddy” is “About Allay”, with `/allay` instead of `/buddy`.
- 🧰 **`get_allay_guide` and `allay_settings`** replace `get_buddy_guide` and `buddy_settings`. A 3.x plugin still offers the old names: the model sees the new ones, and the call goes to the plugin under the name it offered.
- `/api/health` says `"name": "Allay"`; the logs, the default `API_NAME` (`allay`), and the agent's id follow.

## 3.0.0

For MCBuddy Spigot 3.0. Older plugins keep working: everything new is optional in the request.

- 📣 **Public questions.** `visibility: "public"` marks a question every player online sees (`/askall`, or `?` in chat mode). The prompt keeps the asker's coordinates, notes, and memories out of the answer, and the run goes without a book.
- 🧵 **A shared thread per server.** Public questions go to their own thread, named by the plugin's `server.id`, with the asker's name in front of each question. A friend's follow-up continues the talk. The thread lives 2 hours (`PUBLIC_CHAT_TTL_SECONDS`).
- 📖 **MCBuddy explains itself.** `get_buddy_guide` asks the plugin which commands, chat prefixes, settings, and features this player has; the prompt sends every “what can you do?” and “how do I…” there instead of guessing. `buddy_settings` turns chat mode and its tip on or off when the player asks in words.
- 🧩 **Plugins.** `get_server` describes the plugin list the plugin now sends, and the prompt calls it when a question may touch a plugin.
- The prompts know chat mode: plain text, `!` for commands, `?` for everyone, `~` for the ordinary chat.

## 2.5.0

- `/api/health` reports the release version instead of “1.0.0”; builds from master say `dev-<commit>`.

## 2.4.0

Needs MCBuddy Spigot 2.4: the tool set changed, and older plugins lose the tools whose names changed.

- 👀 **Fewer, broader tools.** `look_at` replaces `get_target`, `get_block_info`, `get_container`, `get_enchant_options`, `get_mob_info`, and `get_villager_trades`; `inspect_item` reads maps instead of `get_map_info`; `reminders` and `goals` each take an `action` instead of three tools apiece; `find_item` searches the inventory, the ender chest, and the containers around, inside shulker boxes and bundles too. A player sees 35 tools instead of 44.
- 🔎 **`inspect_item`**: the agent examines one item in full (attack numbers as the tooltip shows them, potion seconds, trims, books, fireworks, maps, what a shulker box or bundle holds) and treats player-written names, lore, and book titles as data, not instructions.
- 🧭 Descriptions say what the plugin really returns: absolute coordinates, the game's dimension ids, advancement keys for goals, recipes beyond the first five, the whole inventory for durability. `point_to` needs no `y` and takes a dimension.
- 🛡️ `/askx` gets only the tools that read the game: no actions, no operator tools.
- 🌍 Server tools send `summary_key` and `summary_values` with their status, so the plugin shows “5 sources” in the player's language.
- The prompt routes questions to the merged tools; descriptions lost the repeated “game data” suffix, since the prompt already says it.
- README in English with a Russian copy, and the MIT license.
- 📦 Releases are made by hand from the “Release” workflow; it tags the version, publishes `ghcr.io/mcbuddy-ai/mcbuddy-server:<version>`, and writes these notes to the GitHub release.

## 2.3.0

- The player's real time goes in front of each question; the 2.3 tools (buttons, windows, goals, books) are described to the model; places go to the notebook.

## 2.2.1

- Accepts every tool a 2.2 plugin offers, not just 32.

## 2.2.0

- The notebook, container, and game-knowledge tools.

## 2.1.0

- Location, trade, compass, sorting, reminder, and operator-only tools; `exact_calculations`; a 24-hour session with a summary; memories in MongoDB and the endpoints behind `/ask new`, `/ask memory`, `/ask forget`; answers in the language of the question.

## 2.0.0

A rewrite as a Mastra agent on Bun 1.4.3.

- `/api/v2/chat` streams answers over Server-Sent Events and hands game tools to the plugin; web search for fresh facts; the prompts live in the repository.
- `/api/ask` and `/api/askx` keep their v1 shapes and run the same agent.

## 1.3.3

- Requests no longer go through a queue.

## 1.2.0

- A request queue, a system prompt for Telegram, and an automated image build.

## 1.1.0

- A client can pass its own OpenRouter token.

## 1.0.0

- `/api/ask` and `/api/askx` for the plugin and the Telegram bot.
