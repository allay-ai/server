# Changelog

The “Release” workflow takes the notes for a version from its section here, unless you type them into its `changelog` field.

## 6.15.0

Allay looks up several things in one step. Plugins before Allay for Minecraft 6.13 keep working: the backend asks them one name at a time, side by side.

- 🔎 **Several names at once.** `search_items` takes `queries`, up to 8 names, and `get_recipes` takes `items`, up to 5: a beacon and its parts, or a name with its other spellings, cost the model one step instead of one each. Each name's answer comes back under its query, in the order asked, a potion among the items brewed as before; with several, 5 matches and 3 recipes each keep the answer short. Plugin 6.13 answers the whole list in one call; docs/protocol-v2.md has the fields.

## 6.14.0

Allay answers from what the server really has, and other plugins and mods can extend it. Plugins before Allay for Minecraft 6.12 keep working as before.

- 🔎 **Nothing “doesn't exist” unchecked.** The model looks a thing up before it says there's no such item, potion, or recipe: the new `search_items` finds items and potions by name in any language or by id, mods', data packs', and plugins' included, and `get_recipes` takes names too («зелье заражения» brews as `infested`). The prompt says what tools return beats what the model remembers, and that “nothing here” isn't “doesn't exist”.
- 🧩 **Expansions.** A request may carry other plugins' and mods' tools (`expansion_tools`) and a few lines from each (`expansions`), as plugin 6.12 sends them from Allay's expansion API. The model calls them as `x_<expansion>_<tool>`, framed as the plugin's, with their schemas cut to what describes arguments; operator tools only for operators, reading ones only in `/askx`, none for automation agents. Each plugin's lines go under “## Name's plugin prompt”, behind Allay's own rules. docs/protocol-v2.md has the fields.
- ⚒️ **The anvil finds the item.** `get_anvil_plan` takes `item` or `slot` for an item anywhere in the inventory, worn, or in the offhand, and with neither picks the one the player's books improve, or asks which. The model no longer asks the player to take it in hand.
- 📦 **Data packs and mods.** `get_server` says which data packs the world runs, and on a mod server lists mods as mods.
- 🛡️ **No crash on dropped questions.** Two questions of one player cancelled at once (a server stopping mid-answer) left an aborted call nobody waited for, and it stopped the whole backend; an abort now ends only its own run.

## 6.13.0

@AllayChatBot talks like a guide. Nothing changes for the plugin's protocol.

- 👋 **Onboarding.** Someone who opens the bot before linking a server, with `/start` or any message, gets three steps with emoji: install the plugin or the mod, run `/allay link` in the game, tap the link to come back and pay. Buttons lead to the site's install section, in Russian or Spanish where the site has it, and to the setup guide.
- 📋 **Many servers.** `/status` opens one server straight as its card: state, limit, renewal, Solo, and buttons to pay, stop or resume renewal, or hand a Solo license on. Several servers are a list, one button each; a card opens in the same message and goes back to the list.
- 🤖 **No more silence.** A message from an account with servers gets a short answer: questions for Allay go in the game with `/ask`, with buttons to the servers and to linking another. Messages carry emoji, and a payment ends with a button to the servers.

## 6.12.0

Ready for Allay as a Fabric and NeoForge mod, on a server and in a player's own game. Nothing changes for servers that run the plugin.

- 🧩 **Where Allay runs.** A question, `PUT /api/v2/server`, and `POST /api/v2/license` may say what Allay runs on (`loader`: `spigot`, `fabric`, `neoforge`) and where (`side`: `server`, `integrated` for a player's own world, `client` for a mod on a server without Allay). The model hears where it is and that a modded game has more blocks and items; the admin panel's Servers page shows both.
- 👤 **Solo licenses.** A license made in a player's own game becomes Solo while `SOLO_PLANS` is on: it answers its first player only, kept by pseudonym, and anyone else gets `SOLO_PLAYER_TAKEN`. The bot sells it Solo plans (week, month, year, as settings `PLAN_SOLO_*`), and its payer hands it to another player in `/status` once every `SOLO_RELEASE_DAYS`. In the panel an owner makes a license Solo or a server's, and an admin hands a Solo license to the next player. `SOLO_PLANS` is off: nothing is sold until it's turned on in the panel.

## 6.11.0

Buttons move into the answer. **Allay for Minecraft 6.9.0 or newer is needed for buttons:** older plugins keep working, but show the tags as plain text.

- 🔘 **Buttons right in the text.** The model writes `<button action="…" …>Label</button>` anywhere in its answer, and the plugin turns each into a clickable `[Label]` in that place: mid-sentence, at the end of a line, or on a line of its own, up to 8 in an answer. The `add_buttons` tool is gone, with no fallback. `ask`, `point`, `copy`, `note`, `recipe`, `brewing`, `anvil`, `enchants`, and `villagers` work as before; docs/protocol-v2.md lists the attributes.
- ⌨️ **A command at a click.** A `command` button runs a command as the player who clicks, such as `/home` when they ask to go home; the plugin's `blocked_commands` still apply. Never an operator command, never in a public answer.
- 💬 **Say it for me.** Asked to write something to the other players («попроси вежливо в чате одолжить 12 алмазов», in Spanish if they want), Allay writes the message, shows it, and adds a `say` button that sends it to the public chat as the player. Nothing goes out until they click. Private answers only.

## 6.10.0

Allay Room, tidier, and licenses named after their servers. Nothing changes for the plugin's protocol.

- 🏷️ **Names, not MOTDs.** A license goes by the name its owner gave a server behind it (`server.name`), the newest one, everywhere the panel names it: the Licenses list and page, the Servers table's License button, a run's License, and the player picker. The name `/allay link` sent (the MOTD) shows only while no server of the license has a name, and an owner still edits it (`own_name` in `GET /api/admin/licenses/{id}`). The MOTD shows only on its server's page, in a block of its own under Details, line by line.
- 🤖 **The bot names servers right.** When a server registers with a name (`PUT /api/v2/server`), its license takes that name, so @AllayChatBot says “Moonlands” too, and a later `/allay link` no longer puts the MOTD back.
- ♾️ **Infinity is Infinity.** A license with a hand-given budget of `PLAN_INFINITY_BUDGET` or more, as 6.8 and older granted it, reads as Infinity instead of “Granted”.
- 📅 **How long it lasts.** Under “Paid until” a license's page says the days left. Under “Budget resets” it says how many days what's left lasts at the average a day the open budget windows have spent since they began (`daily_spend`), once anything was spent.
- 🗑️ **Delete says what it does.** The Delete card spans the row and says what goes (the license, its windows, its key) and what stays (payments, runs, statistics).
- 🧑 **Erase a player.** The picker shows the servers each player asked on by their own names, and the field lines up with the Erase button.
- 📊 **Busiest players** is a ranked table with questions and cost in their own columns and a bar of each player's share.
- 🧱 **Server cards fill the row.** One server takes the whole width, two or three share it, and more wrap three to a row, on a license's page and a player's.
- 🧾 **Audit log.** Each entry's first line sits on its icon's middle, and its changes start at the same edge.

## 6.9.0

For Allay 6.7, which keeps nothing about players on the server's disk anymore; Allay 6.6 and older keep working as before. Start it with the same `SECRETS_KEY` (or `/data` volume) as before: it now seals players' data with a key derived from it, and a new key would open none of it. **Pseudonyms change:** they're per server now, so the statistics start new pseudonyms for everyone; see “Pseudonyms per server” below.

- 🔐 **Players' data is sealed at rest.** Sessions and their summaries, automations' outcomes, memories, deaths, players' state, and the words in traces (prompts, answers, tool data, error texts) go into MongoDB encrypted with AES-256-GCM, under a key derived with HMAC-SHA256 from `SECRETS_KEY`. A dump or a backup alone reads none of it. Data from before 6.9 still reads, and goes as it expires.
- 📍 **Memories hold places.** A memory may carry coordinates and a dimension, what the plugin's notebook kept before. One `memories` tool saves facts and places (`here`, or coordinates), finds them by meaning or by distance with the way there from `player.position`, and deletes them; it replaces `remember` and `forget`. Up to `MEMORY_MAX` (200) per player; the prompt lists the 30 newest facts and counts the places. `POST /memories` takes a `place` for the plugin's note buttons.
- 💀 **Deaths live on the backend.** `POST /api/v2/users/{id}/deaths` keeps each death, the newest `DEATHS_MAX` (100), and a retry of the same one is a no-op. `get_locations` pages them itself, in the player's time zone and with the way there; a 6.6 plugin's own history still works.
- 🎒 **The player's state too.** `GET` and `PUT /api/v2/users/{id}/state` keep the plugin's time zone, settings, and goals for each player, up to 32 KB.
- 🔗 **A player's copy by link.** `POST /api/v2/users/{id}/export` gives a link good for 24 hours; `GET /api/v2/exports/{token}` downloads the JSON without credentials, since the 32-byte token is the key. Only its SHA-256 is kept, and an erasure ends it.
- ✍️ **Consent follows the policy.** A consent keeps the SHA-256 of the notice the player saw with the policy's revision, the revision (`POLICY_REVISION`, also in `/api/health`), `age_confirmed`, and `age_band` (`under_13`, `13`, `14_15`, `16_17`, `18_plus`), the age group the plugin asks every player for. `GET /consent` returns the current revision, so the plugin asks again when anything changed. A consent goes with the player, 730 days after their last question.
- 🚫 **No agreement, no answer, on a hosted backend.** A question, an automation's wake, a memory, a death, or a state from a player without an agreement in force gets `403 CONSENT_REQUIRED` before anything runs, is traced, or is kept, whatever the plugin's settings say. The server's console and v1 requests that name nobody still pass. A self-hosted backend leaves the notice to its operator, as before.
- ↩️ **Withdrawing erases what the agreement covered.** `DELETE /consent` removes the player's memories and places, deaths, state, export links, and session, and answers `{ withdrawn, memories, deaths }`. The record of the agreement stays, marked `withdrawn_at`, as proof of what the data rested on; agreeing again clears it. The runs keep their numbers under the pseudonym.
- 🎭 **Pseudonyms per server.** A pseudonym is now an HMAC of the tenant and the player's id, so the same account on two servers is two pseudonyms, and the statistics can't tie a player's servers together. Runs from before 6.9 keep their old pseudonyms and nobody to name until re-keyed; `migrate retag` re-keys the players it moves. Viewers of the panel see pseudonyms and numbers only: names, faces, ids, and search by name are for admins and owners.
- 🛡️ **Only providers that don't keep requests.** Every request through OpenRouter, on the backend's key or a server's own, sends `provider.data_collection: "deny"`, so OpenRouter routes only to providers that don't store or train on it. `OPENROUTER_DATA_COLLECTION=allow` lets it pick any.
- 🕵️ **An owner opens one run, on the record.** The panel's trace view still shows only shapes and numbers. `POST /api/admin/runs/{id}/reveal` with `{ reason }` (owners only, 10–500 characters) opens one run's trace to look into a reported problem and writes `run.reveal` with the reason to the audit log; the environment's account, which scripts use, gets `403 NOT_FOR_SCRIPTS`. `bun run dist/application/reveal.js <run id> --reason "…"` does the same in the container.
- 📣 **Write to every license holder.** An owner sends one text through @AllayChatBot to each license's Telegram chat, or the listed ones (`POST /api/admin/licenses/notify` with `{ text, licenses? }`, the button on the Licenses page), 20 a second; the answer says how many got it, failed, or have no chat yet. The audit log keeps `licenses.notify` with the counts, never the text. It's how a breach notice (GDPR art. 33(2)) reaches the servers' owners.
- 🗓️ **Longer retention.** Sessions (`CHAT_TTL_SECONDS`) and traces (`TRACE_DAYS`) 30 days; runs, the player directory, servers, and the audit log 730 days; memories, deaths, and state 365 days after the player's last question. Every question refreshes them. Indexes catch up at start. A grant's end reads as a date in the audit log.
- ♾️ **Infinity.** A plan an owner grants on a license's page, never sold: `PLAN_INFINITY_BUDGET` ($1000) for 366 days. With `SUPPORT_CONTACT` set, the bot's plans end with “Need more? Contact us”.
- 🧠 **New defaults.** `~anthropic/claude-haiku-latest` is the default and recommended model, `OPENROUTER_REASONING_EFFORT` is `medium` (`unset` sends none), and `MAX_AGENT_STEPS` and `MAX_TASK_STEPS` are 26 and 32. The stock compose files no longer pin `TRACE_DAYS` and `MAX_AGENT_STEPS`. A setting saved in the panel keeps its value.
- 🏠 **Allay Room.** The admin panel has a new name and the organization's icon. A self-hosted backend's sidebar links the project's source, issues, discussions, and releases.
- 🖥️ **Servers and licenses have pages of their own.** The Servers table shows Name, Domain, License, IP, Runtime, Questions, and Last used, and a click anywhere in a row opens the server: its details, players, and runs (`GET /api/admin/servers/{tenant}/{id}`). A license's page shows what's left with a bar that fills as money goes, its servers as cards, and its actions grouped by budget, access, and deletion; an owner renames it and sets its language (`PATCH /api/admin/licenses/{id}`). No table shows a MOTD, and detail rows say “No” or “Never” instead of a dash.
- 🧑 **Players.** The search is a dropdown that opens the player picked. A player's page lists every server they asked on. Runs name their server as a button.
- 🐛 **Erasing by name works on a hosted backend.** “Erase a player” searched only the backend's own key, so on allay.chat it found nobody by name; it searches every server now.
- 🔎 **Readable traces and audit log.** Traces show kind, player, server, model, steps, tokens, and cost. The audit log filters by area and by who (`GET /api/admin/audit?area=&actor=`), links what each entry was done to, and shows changes as a diff. **Show text** on a run's page opens it for an owner, who says why first. The sidebar's color reaches the bottom of long pages.
- ⚙️ **Settings and accounts.** Settings have plain names, the recommended model is marked and one click away, the reasoning choices are in words, and the secrets key shows its last four characters. A new account's password can be generated.
- 🧹 **No more migrations at start.** The steps for data from before 6.0 are gone, and with them the `migrations` collection; `migrate retag` also moves deaths and state.

## 6.8.1

- 🧹 **The move out of Redis is gone.** 6.8.0 moved every session it found; from 6.8.1 the backend never looks for Redis. Coming from 6.7 or older, start 6.8.0 once with Redis first, or players' conversations simply start over and admins sign in again.
- 🗑️ Two unused models from the first version are gone, and with them the last mention of the `uuid` package.

## 6.8.0

For Allay 6.6, which keeps players' deaths; older plugins answer about the last death only, as before. **Upgrading from 6.7:** start it once with Redis still configured, then remove Redis (see below).

- 💀 **Allay remembers every death.** `get_locations` takes `deaths_page` and reads the player's death history from the plugin, ten a page, newest first: when (in the player's time zone), where, what killed them, and what dropped. “When did I die?” and “what killed me last time?” get real dates and causes, and Allay turns the pages itself for older deaths.
- 🧭 **Where the spawn is.** The tool's description now says that `world_spawn` is where new players and players without a bed appear, within `respawn_radius` blocks.
- 🗄️ **No more Redis.** Chat sessions, automations' outcomes, and admin panel sessions live in MongoDB (`sessions`, `session_outcomes`, `admin_sessions`), so a backend needs MongoDB alone. Each expires exactly on time: reads never see an expired one and delete it on the spot, a new question after expiry starts a clean session, and MongoDB's TTL indexes only sweep up the rest. Panel sessions keep only the digest of the cookie, as before.
- 🚚 **Moving is automatic.** Keep `REDIS_URL` (or `REDIS_HOST`) and Redis for one start: the backend copies the sessions with a tenant, pending outcomes, and panel sessions into MongoDB with the time they had left, logs how many, and never touches Redis again. Then remove Redis from your `compose.yaml`. Skip that start, and players' conversations simply start over and admins sign in again.
- 🧹 A fold that was still summarizing when a player ran `/ask new` no longer writes the old summary into the new session; the in-memory store also keeps exchanges added during a fold, as the real one always did. The unused `bullmq`, `amqplib`, and `ioredis` packages are gone.

## 6.7.0

For Allay 6.5, which registers its server; older plugins show up by their id, as before.

- 🏷️ **Servers have names.** `PUT /api/v2/server` registers a server at the plugin's start with the name its owner set (`server.name`), its MOTD, address, and versions. A name belongs to one server on the backend: another tenant's server gets `409 NAME_TAKEN`, and a server of the same tenant takes the name over, as after a reinstall. A server without a name shows its random id.
- 🪧 **Headings read like a server list.** The Servers page, the licenses, and a license's page head each server with its name, then its domain or IP past a middle dot, and its MOTD a line below in smaller type. Registered servers show before their first question, and the Servers page's last column says when each was last seen.

## 6.6.0

- 🌐 **Servers show where they are.** The Servers page and a license's page show each server's join address and game port (from Allay 6.4's `server.address`), the game software and version, the plugin's version, and when it first asked. Admins also see the address each server connects from, marked **internal** when it shares a private network with the backend. A server on a license shows the license's name. Kept 400 days after the server's last question.

## 6.5.0

For Allay 6.3, which adds the full privacy switch; older plugins work as before.

- 🕶️ **Full privacy.** A question with `player.private` keeps the player's name, UUID, and face out of the admin panel, and forgets what the panel had; `PUT /api/v2/users/{id}/privacy` with `{ "full": true }` does it at once when the player flips the switch. Memories, the session, and traces work as before.
- 🙂 **Steve for the unknown.** Players the panel can't name (before 6.4, or with full privacy on) show Steve's head instead of a blank figure.

## 6.4.0

- 🏷️ **The panel names players.** Each question from the plugin notes the player's name, UUID, and operator status per server in a directory, so the Players page, runs, the dashboard, and a player's page show names instead of pseudonyms. Players from before 6.4 keep their pseudonym until their next question. A rename shows everywhere at once, and an erasure takes the name off every run. The directory lives 400 days after a player's last question, a player's export includes their name, and the audit log still keeps pseudonyms only.
- 🙂 **Faces.** The Players page opens with a “Skin” column, and names carry the player's head in runs, the dashboard, and the erase picker. The backend fetches heads from mc-heads.net (by UUID, or by name on offline-mode servers) and caches them for 6 hours, so the panel's CSP stays `'self'` and the viewer's browser never calls a third party.
- 🔎 **Find and erase by name.** The Players search takes a name's start, a UUID, or a pseudonym. “Erase a player” picks the player from a drop-down of that server's players, with face and UUID, and still takes a UUID or a pseudonym typed in; a name typed in whole works too, unless two players on the server shared it.
- 📊 **More numbers.** The Players table adds servers, errors, tokens, average answer time, and the first question. A player's page shows their name, UUID, pseudonym, operator status, and servers, eight tiles (questions, cost, error rate, typical and slowest time, tokens, tool calls, cancellations), questions by day and by hour, and their kinds of runs, models, and tools. A run's page adds the player's UUID, the license's name, the payment, web searches, spans in its trace, the error code, time per step, cost per 1000 tokens, and output speed; the runs table shows tokens and tool calls.
- 📈 **More charts.** The dashboard adds failed and cancelled questions stacked, tokens read and written, the typical answer time, the cost of a question, web searches, and the busiest players of the period.
- 🗑️ **Delete a license.** A license nobody paid for, or one refunded, deletes after one confirmation, with its budget windows; its payments stay as the record of money that moved. A paid license without a refund sends you to “Refund and revoke” first. An owner may delete it anyway after a warning about the payer's rights and a second agreement, and the audit log records the unrefunded Stars. `DELETE /api/admin/licenses/{id}` answers `409 PAID` without `{ "force": true }`, and `403` for a forced delete by anyone but an owner.
- 🪪 **Name players from before 6.4.** `migrate players <name>=<uuid> …` inside the container fills the directory for players who haven't asked since: their runs give the servers and the first and last question. A UUID without runs changes nothing, and a name from a newer question stays.
- 🔬 **Every run traced by default.** `TRACE_SAMPLE` defaults to 1 on hosted backends too, so the Traces page fills from the first question. A value saved in the panel or set in the environment still wins.

## 6.3.0

- 💸 **Refund a license and revoke it.** “Refund and revoke” on a license's page in the panel returns every payment that isn't refunded yet through the bot, stops the subscription, and tells the payer in their language. The license is revoked for good: its key answers `LICENSE_INVALID`, its claim code and invoices stop working, and the bot leaves it out of `/status`, so the server takes a new license with `/allay link` and pays again or uses its own key. When Telegram refuses one payment, the license stays and a second try returns the rest. Telegram refunds only whole payments, so a refund is always full.
- 🔓 **Unblock unblocks.** On MongoDB, unblocking a license and resuming renewal in the bot left the old date behind, so a blocked license stayed blocked. Clearing a field now removes it.

## 6.2.1

- 🧹 **Erase a player by pseudonym.** “Erase a player” takes the pseudonym from the list as well as a UUID, so an admin who never saw the player's id can still erase them. A player nothing on the server names (no consent, no memories) loses what's left of them, their runs' ties and traces, instead of the button staying grey.

## 6.2.0

For Allay 6.2, which tells a blocked player why; older plugins show a general error.

- 🚫 **Block a player.** An admin blocks a player on one server from their page in the panel, and Allay stops answering them there with `PLAYER_BLOCKED` (403) until someone unblocks them. Bans are kept by pseudonym, never by id, and outlive an erasure; “Blocked players” on the Players page lists them, erased players too.
- 🧹 **Clear a player's session, or erase them, from their page.** The backend finds who a pseudonym is among the players who agreed to the notice or have memories there; the panel still never sees the id. Erasing by id stays for players who send theirs.
- 🎛️ **The panel reads easier.** “Erase a player” picks the server from a list and lines its fields up; a license's long name glides back and forth instead of being cut, in the list and on its page; Active is green, Expired amber, Blocked red; the theme menu fits “System”.
- 🗂️ A player's export says whether they're blocked there.

## 6.1.1

- 🌐 **Buttons speak the answer's language.** An English question got an English answer with Russian buttons under it: the tools asked for labels “in the player's language”, which the model read as the game locale, and the prompt's examples are Russian. Now labels, button questions, mark titles, and task names follow the language of the answer, and the prompt says its Russian examples show the form only.

## 6.1.0

For Allay 6.1, which asks each player before their first question; older plugins work as before.

- ✅ **Players' consent is kept.** `GET`, `PUT`, and `DELETE /api/v2/users/{id}/consent` read, record, and withdraw a player's agreement to the plugin's notice: which version they agreed to and when, per tenant and player like everything else. It stays until the player withdraws it or their data is erased, as proof of the agreement (GDPR art. 7(1)).
- 🗂️ **Export, erasure, and moves know it.** A player's export carries `consent`, an erasure removes it, and `migrate retag` moves it with the memories.

## 6.0.0

For Allay 6.0, which sends the credentials this version wants. **Breaking:** Allay 5.x gets `401` from this backend; update the plugin first, then the backend. A self-hosted backend needs `PLUGIN_TOKEN` in its environment and the same value in the plugin's `server.token`.

- 🔐 **Every request says who sends it.** A hosted backend wants the server's license on every plugin request, a self-hosted one its new `PLUGIN_TOKEN` (24 characters or more, compared in constant time). Without one configured, a self-hosted backend answers no plugin instead of everyone. Only health, license creation, and Telegram's webhook stay open; a test walks the route table to keep it so.
- 🧱 **Servers never see each other's players.** Memories, sessions, task threads, task outcomes, and the public thread are kept per tenant (`license:<id>` or `self`) and player. Before, anyone who knew a player's UUID could read, add to, or wipe their memories through `/api/v2/users`, or send their `user_id` to `/api/v2/chat` and have the agent read out their memories and session; another server's public thread opened to anyone who sent its `server.id`.
- 🔑 **BYOK needs a license as identity.** It's free from `POST /api/v2/license` and pays for nothing. Limits count per license instead of the `server.id` a request claimed, all BYOK servers together take at most `BYOK_ACTIVE_RUNS` (100) slots so paying servers keep theirs, and a blocked license can't ask with its own key either.
- 🧰 **Tool results only from the run's own server.** `POST /api/v2/chat/{run}/tools/{call}` wants the same credentials as the question; another tenant's answer gets `404`.
- 🚪 **`/allay init` only for the backend's own plugin.** `POST /api/v2/admin/init` wants `PLUGIN_TOKEN`: its recovery code resets any admin's password, and before anyone who reached the backend could ask for one.
- 🌐 **Client addresses come only from trusted proxies.** New settings `TRUSTED_PROXIES` and `CLIENT_IP_HEADER`: forwarding headers count only when the peer is a proxy the operator named, `X-Forwarded-For` is read from the right, and an IPv6 /64 counts as one address. Behind a proxy, license creation and the panel's sign-in limits no longer share one bucket, and nobody can spoof their way around them. Moonlands-style setups set `TRUSTED_PROXIES` to their proxy's address.
- 🕵️ **Players are pseudonyms in the statistics.** Runs keep a keyed digest of the player instead of their UUID and name; the panel lists and searches players by it, and finds one from a UUID an operator types. The digest's key comes from `SECRETS_KEY`.
- 🗑️ **Export and erasure per player (GDPR).** `GET /api/v2/users/{id}` returns everything kept about a player, `DELETE` erases it: memories, sessions, outcomes, agents' threads, and their traces go, runs keep only numbers. Admins erase a player from the Players page by server and UUID; the audit log keeps only the pseudonym.
- ⏳ **Data doesn't stay forever.** Memories go 365 days after a player's last question, audit entries after 365 days, and days older than 400 keep how many players they had, not who.
- 🧹 **Less in logs and answers.** Logs carry run ids and tenants, never player names, ids, or questions; errors from inside the backend reach the client as a code without the details; `/api/health` no longer shows the process's memory and uptime; API answers carry `nosniff`, `DENY` framing, and `no-referrer`; bodies are capped at 2 MB.
- 🛡️ **BYOK requests can't be bounced inside.** Every request to a server's own provider checks its address again and refuses redirects; NAT64, 6to4, and benchmark ranges count as private too.
- 👀 **Viewers no longer see who paid.** Telegram ids of payers show to admins and owners only.
- 🐳 **The stock `docker-compose.yaml` publishes only the backend, on 127.0.0.1.** MongoDB and Redis have no ports and want their passwords (`MONGO_INITDB_ROOT_*`, `REDIS_PASSWORD`); `MONGODB_URI` carries the user with `?authSource=admin`.
- 🚚 **Data moves on its own.** On start, memories get their tenant (`self` on a self-hosted backend), runs lose players' ids and names, and sessions from before 6.0, which carry no tenant, are dropped. `bun run dist/application/migrate.js retag --from self --to license:<id>` moves an imported self-hosted dump to a license; `status` and `purge-untagged` help around it.

## 5.12.3

For Allay 5.14.3; older plugins work too.

- 🧪 **Brewing agents tell the player why a stand is skipped** (a reagent left in its top slot, finished potions to collect), say why water bottles are still missing in the plugin's own words, and know that stands of water bottles kept ready brew only what was asked.

## 5.12.2

For Allay 5.14.2; older plugins clamp the new radius.

- 🔎 **find_item and scan_nearby_containers reach 32 blocks** by default, up to 52, as far as automation agents now do.
- 🏷️ **Names forgive.** find_item says plurals work and that a name nothing matches comes back with close ids; smelt takes what a furnace makes (iron_ingot, glass) for everything that cooks into it.

## 5.12.1

For Allay 5.14.1; older plugins clamp the new radius.

- 🛡️ **“Craft me a shield” just works.** The chat starts a crafting agent at once with the item and the count, instead of searching 8 blocks itself and saying the iron isn't there, or writing the agent a recipe and a chest list. The crafting agent starts with a dry run, which takes from the inventory and the chests around and makes planks from logs and ingots from iron blocks on the way; it never sends a chests agent for ingredients, and a recipe that makes two blaze powders for one is fine.
- 🔎 **find_item and scan_nearby_containers reach 16 blocks** by default, up to 24, as far as automation agents do.

## 5.12.0

For Allay 5.14.0; older plugins work too.

- 🔗 **Agents work with sub-agents the way they should.** The task prompt teaches a self-contained brief with the coordinates already known, one sub-agent per step that can start now (bottles only after the glass is done), waiting for each report, acting on what its tools reported, and never asking the player for what a report or the brief already says.
- 🗣️ **Agents steer their own sub-agents.** A depth-1 agent gets `message_task` and `cancel_task`; plugin 5.14 lets them reach only its own sub-agents.
- ⏳ **`finish` takes `handoff`.** Plugin 5.14 refuses `finish` while a sub-agent runs, so the agent hears the report it needs; `handoff: true` leaves the rest to the sub-agent on purpose (“the crafting agent makes the blocks”).
- ✂️ An agent that can't start sub-agents no longer gets an empty “running sub-agents” section. A tool error over 2000 characters from the plugin is cut instead of refused, so the model no longer waits out the tool timeout.

## 5.11.2

For Allay 5.13.1; older plugins work too.

- 📦 **The chat knows chests go both ways.** After a cancelled or failed chests agent, the chat no longer says it can't move things into the inventory: it starts a new agent with what went wrong.
- 🧪 **Potions by name.** The chests agent takes “my infestation potions” as `potion:infestation`, which plugin 5.13.1 matches in every form.

## 5.11.1

For the same plugins as 5.11.0, with nothing new to configure.

- 💸 **Claude models cache their prompt.** With an Anthropic model in `OPENROUTER_API_MODEL` (like `anthropic/claude-haiku-5.5`), each request asks OpenRouter for Anthropic's automatic prompt caching, so the steps of a run read the system prompt, tools, and history from the cache. A furnace task measured $0.0021 without it and $0.00035 with it. OpenAI's and other models cache by themselves and send nothing new.

## 5.11.0

For Allay 5.13.0; older plugins work too.

- ⚡ **Leaner, faster agents.** An automation agent gets only its own kind's work tool (a brewing agent `brew`, not `craft` it can't use) and the reads its work needs, not structures, statistics, reminders, or redstone. Each step sends fewer tool schemas, so a wake costs fewer tokens and answers sooner.
- 🔗 **Results a parent can use.** A sub-agent's summary says what it made, how many, and where it lies, or what was missing, since the agent that started it acts on it.
- ✂️ **No lessons for tools that are off.** The prompt drops its drafts and redstone sections when the plugin doesn't offer `show_draft` or `inspect_redstone`.

## 5.10.1

For Allay 5.12.1, which wakes an agent when its sub-agent ends; older plugins send nothing new.

- 🔗 **An agent hears its sub-agents.** A wake that starts with `[sub-agent] …` carries how a sub-agent ended, and the agent goes on with its next step or tells the player what failed. Task wakes take `tasks`, the agent's running sub-agents, and its prompt lists them, so it never says a helper works after it ended. A sub-agent's outcome in the chat says it's a sub-agent's, and the chat passes the player's words to the agent that started it instead of starting the step again.
- 🔥 **Out of reach isn't busy.** When a scan finds no furnaces or stands near the player, the agent asks them to come closer to the nearest one instead of saying there are none free.

## 5.10.0

For Allay 5.12.0, which tells a recovery link from a setup link; older plugins call it a setup link.

- 🔑 **A way back after a forgotten password.** Once the panel has an account, `/allay init` on a self-hosted backend hands out a recovery link instead of “the panel has an admin already”. It works once, for 30 minutes, and opens a page where you enter your name and a new password; the account's other sessions end, and the audit log notes it. The sign-in page has a “Forgot your password?” link that explains both ways back: `/allay init`, or another owner. The environment's admin keeps its password in the environment.

## 5.9.2

For the same plugins as 5.9.1, with nothing new to configure.

- 📦 **Fresh dependencies.** TypeScript 7.0.2, tslog 5.4.0, the AI SDK 7.0.143, Mongoose 9.11.2, zod 4.6.7, and Recharts 3.10.1 in the admin panel. The compose files run MongoDB 8.0.34 and Redis 8.10.

## 5.9.1

For Allay 5.11.1.

- 🔢 **A number for each item.** The chests agent puts “6 lapis and 8 coal” into `amounts`, one plan with a count each, instead of one `count` over both.

## 5.9.0

For Allay 5.11.0; older plugins ignore the new modes and fields.

- 📥 **Chests take and stash.** The chests agent gets the modes `take` (out of the chests into the inventory, with `count` or `up_to`) and `stash` (the inventory into the chests where each item belongs), selectors in `items` (“all the iron”, “tools”), `count` for a move, `keep`, and `hotbar` for a stash. The chat knows the agent can do both.
- ↩️ **Undo a sort.** `sort_inventory` takes `undo`; the chat uses it for “put it back”.
- 🔥 **Smelting and brewing deliver by themselves.** `smelt` and `brew` take `to` on start, `auto` as an output, and `remember` to keep the player's choice; the agents check `player_output` before asking. `smelt` gets action `add` for more of the same while a job runs, and the agent knows about planks, sticks, bamboo, logs, and lava.
- 🧪 **Several potions in rounds.** `brew` start takes `potions` and up to 64 bottles; the agent tells the player when they brew in rounds, and that missing water bottles get filled from glass bottles at water.

## 5.8.2

For Allay 5.10.2; older plugins ignore `from` and move only between the chests given.

- 📦 **Chests move from the inventory and from every chest around.** `chests` plan with mode move takes `from`: `inventory`, `nearby`, or both. The chests agent uses it for “put all my wood into this chest” and “gather the wood from all the chests here”, picking only the target.

## 5.8.1

For Allay 5.10.1; older plugins still read `bottles` per stand.

- 🧪 **Brewing counts potions in all.** `brew` takes `bottles` as the number of potions the player wants, up to 24, and `fresh` to skip their own potions. The brewing agent upgrades the potions a player has when they ask for longer or stronger ones, instead of brewing new ones, and the chat writes its brief that way.

## 5.8.0

For Allay 5.10, which adds the fuel action, the anvil, and new crafting stations; older plugins keep working.

- ⚒️ **`anvil`** for the crafting agent: books and items of a kind onto an item in the cheapest order, from the inventory and chests near, and a new name, for the player's levels after their yes. The chat hands “put mending on my sword” or “rename my pickaxe” to a crafting agent.
- 🛠️ **`craft` knows its stations:** 2×2 by hand, 3×3 at a table, a stonecutter when it's near, and netherite gear on a smithing table, enchantments kept.

- 📬 **The chat knows how its tasks ended.** When an automation agent finishes, the chat reads its summary in front of the player's next message (“[Automation «Крафт наковален» (umu8) finished …: no crafting table near]”), and its instructions say a task missing from the running list has ended. Before, the chat saw only “the agent took it” in its history, so “make me two anvils” again got “I already started that”.
- ⏹️ **A wake ends at `wait` or `finish`.** The agent kept calling `wait` a dozen times in one wake, each a paid step; now the wake stops right there.
- 🪨 **`smelt` action `fuel`** puts fuel alone into the furnaces: `count` spread evenly, `each` per furnace, `up_to` a level in every slot, or `need` for just what's cooking, into the kinds in `types`. The agent's instructions map the player's words to them and ask when no amount was said.

## 5.7.1

- 🛠️ **The crafting agent knows 2×2 recipes need no crafting table.** `craft` and the agent's instructions say so, to match Allay 5.9.1, which crafts planks, sticks, and a crafting table without one.

## 5.7.0

For Allay 5.9, which adds `/allay init`; older plugins keep working, and so does every environment variable from before.

- 🖥️ **An admin panel at `/admin`.** Sign in and change every setting the environment held, manage admin accounts, and see statistics, players, servers, runs, traces, and on a backend with billing on, licenses, payments, and revenue. React with shadcn/ui, light and dark, down to phone width, built into the same image. Nobody sees what players asked, what Allay answered, tool data, or memories' text, in any role: only numbers and the shape of runs.
- 🔑 **The first admin.** A self-hosted backend hands out a one-time setup link through `POST /api/v2/admin/init` (`/allay init` in plugin 5.9), valid 30 minutes; a hosted one prints a setup code to its log at start. `ADMIN_USERNAME` with `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH` defines an owner in the environment and turns setup off.
- 👥 **Accounts and roles.** Owners manage accounts, admins change settings, players, and billing, viewers read. Argon2id passwords, 7-day sessions in Redis behind an HttpOnly, SameSite=Strict cookie, an Origin check on every change, and sign-in locks after 5 wrong passwords for a name or 10 from an address. Every change goes to an audit log with old and new values, secrets masked.
- ⚙️ **Settings in MongoDB.** One settings service reads the environment first, then what the panel saved, then the default, so deployments from before keep working; “Import from the environment” moves the values over so the variables can go. Changes apply to the next run without a restart, except `TRACE_SAMPLE` and `TRACE_DAYS`; the bot restarts by itself when its settings change. Keys and the bot token are sealed with AES-GCM by `SECRETS_KEY` or a key in `/data/secrets.key` (mount `/data`), and the panel shows only their last four characters. “Test key and model”, “Test Perplexity”, and “Test bot” check before saving; a main model OpenRouter doesn't know, or one without tools, is refused.
- 💰 **Plans and limits are settings:** `PLAN_WEEK_STARS`, `PLAN_WEEK_BUDGET` and the same for month and year (`PLAN_STARS` still works), `BYOK_PER_MINUTE`, `BYOK_PER_DAY`, `BYOK_CONCURRENT`, and `STAR_USD` for revenue estimates.
- 📊 **Statistics.** Each run leaves its numbers in a `runs` collection for 400 days: kind, who paid, player, model, tokens, cost, steps, tools and whether they worked, searches, duration, and result; daily rollups stay forever. The dashboard shows questions, cost, active players, errors, p50 and p95 answer times, models, and tools over 24 hours, 7 or 30 days, or a year.
- 🧾 **Billing actions.** Refund a payment (what `/refund` does in the bot), grant a budget or extend a period by hand, block a license, which then can't ask or pay.
- 🌐 **`PUBLIC_URL`** names where people reach the backend, with any path prefix; behind a proxy, send the prefix in `X-Forwarded-Prefix`.

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
