# 🛠️ Allay Server

[![AI Capable](https://img.shields.io/badge/AI-Capable-brightgreen?style=flat&logo=openai&logoColor=white)](https://github.com/allay-ai/server)
[![GitHub Release](https://img.shields.io/github/v/release/allay-ai/server?style=flat&logo=github&color=blue)](https://github.com/allay-ai/server/releases)
[![Docker](https://img.shields.io/badge/Docker-Available-2496ED?style=flat&logo=docker&logoColor=white)](https://github.com/allay-ai/server/pkgs/container/server)
[![Bun](https://img.shields.io/badge/Bun-1.2.18-000000?style=flat&logo=bun&logoColor=white)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB-8.0.15-47A248?style=flat&logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![Redis](https://img.shields.io/badge/Redis-8.2-DC382D?style=flat&logo=redis&logoColor=white)](https://redis.io/)

[Русская версия](https://github.com/allay-ai/server/blob/master/README.RU.md)

**Allay Server**—🛠️⚡ the backend for Allay, the AI helper named after the friendly mob that brings players what they need: a fast server on Bun with OpenRouter integration and web search, processing requests from Minecraft and Telegram. Provides REST API for getting AI answers about Minecraft with context and chat history. 🌟

> **Note**: This is the main backend for the Allay ecosystem, providing AI answers for all clients.

## How it works

Allay Server is a [Mastra](https://mastra.ai) agent on top of OpenRouter that answers players in Minecraft and in Telegram. In the game it sees what is going on with the player who asks: inventory, health, surroundings, the recipes of that server. It searches the web on its own when a question needs fresh facts.

The plugin opens one streaming request, `POST /api/v2/chat`, per question. The server answers with Server-Sent Events while the agent works:

- `reasoning` – pieces of the model's reasoning, when the model exposes it;
- `tool_call` – the agent needs something from the game, such as the inventory. The plugin runs the tool and posts the result to `POST /api/v2/chat/{run_id}/tools/{call_id}`;
- `tool_status` – what the agent is doing right now: reading the inventory, searching the web;
- `text` – the answer as it's written, then `usage` and `done`.

For `/askx`, a `commands` event with the command list replaces the text. The full protocol is in [docs/protocol-v2.md](docs/protocol-v2.md).

Game tools only see the player who asked and the world around them; other players' coordinates and inventories stay out of reach. Other players reach the agent only as the asker's locator bar shows them (`get_nearby_players`, plugin 5.4): a name, a distance, and a direction, by the game's rules, so whoever hides from the bar hides from the agent too. `point_to` with `player` draws a trail that follows that player. `show_marks` (plugin 5.5) draws glowing boxes, ghost blocks, and labels only the asker sees: the chests that hold what they look for, ghost torches on dark spots. `show_draft` (plugin 5.6) draws any build up to 20×15×20 as ghosts the player builds into, layer by layer, and `inspect_redstone` reads a machine and the faults the game's rules make certain. The agent matches the name the player says to a real one, a nickname it was asked to remember included, and asks with a way button for each player when it can't tell. The plugin sends the list of tools it offers, so a server admin can switch any of them off. Besides reading, everyone gets harmless actions: pointing the compass at a spot, sorting the inventory, reminders, and a notebook. The agent pins a note to a place (“a villager here sells arrows”), then finds it from a loose question later and points the way. The plugin tells the agent which dimension the player stands in, so a place named without one lands there. The way is a particle trail as long as the player asks or the walk needs, in a style that fits the place, and it ends when they arrive. In one call it sees whatever the player looks at: a block, a chest, a mob, or a villager. It finds where an item is, even inside shulker boxes and bundles, examines any item in full (a book’s enchantments, a potion’s effects, a weapon’s damage and speed, a shulker box’s contents), works out durability, XP, and food, tells where to put torches, and estimates a farm’s rate. Tools that give items, teleport, or change the game mode, time, or weather go to operators only. The backend drops them for everyone else, even if a plugin offers them, and `/askx` gets only the tools that read the game. Server tools send their short results as a key, so the plugin shows them in the player's language.

Three tools run on the backend:

- `search_web` searches the web through a search model. The agent decides when it's worth it instead of searching for every question;
- `exact_calculations` evaluates expressions exactly with [math.js](https://mathjs.org) at 64 significant digits: stacks, Nether coordinates, XP, unit conversions. Each expression runs in a worker for at most a second;
- `remember` and `forget` keep a lasting memory about the player.

The agent answers in the language of the question. The game locale only matters when the message has no clear language.

The backend puts the player’s real date and time in front of each Minecraft question, for example `[Mon, 12 Oct 2026, 23:42 Europe/Moscow]`. The plugin sends the time zone. The time goes into the message, not the system prompt, so the provider’s prompt cache keeps working.

Besides the text, the agent puts buttons under its answer (`add_buttons`): options for an ambiguous question, a next question, the way to coordinates, coordinates to copy, the brewing steps for a potion, the anvil plan for what the player has, and the recipe, enchanting, and villager windows. When the player asks for detail, it writes the answer into a book (`write_book`), and it sets goals like “collect 16 diamonds” as a bar at the top of the screen (`goals`).

The agent also knows Allay itself. Asked “what can you do?” or “how do I turn off chat mode?”, it calls `get_allay_guide`: the plugin answers with the commands this player may use, chat mode's prefixes, their settings, and what this server has switched on. So the agent never names a command that isn't there. `allay_settings` turns chat mode and its tip on or off when the player asks in words. `get_server` lists the server's plugins with versions, so a question about graves or land claims gets an answer for the plugin that really runs.

Work in the world goes to automation agents (plugin 5.7): sorting or grouping chests, smelting, brewing for the player, crafting. The agent in the chat starts one with `start_task` and writes it a full brief, since the new agent starts with no history. Each agent then runs in wakes, as `mode: "task"` requests the plugin sends when the task starts and when something wakes it: the player's answer, a button, a finished job, or a timer. Between wakes no stream stays open and no tokens go. An agent talks to the player only through `say` with buttons, waits with `wait`, and ends with `finish`. It keeps its own thread for 2 hours and sees the player's memories without changing them. It gets no web search, no operator tools, and at most one level of sub-agents. When a task asks something, the chat sees it among the running tasks and passes the player's answer on with `message_task`. Sorting the player's own inventory stays instant, without an agent.

A question from `/askall` comes with `visibility: "public"`: every player online sees it and the answer. The prompt tells the agent not to reveal the asker's coordinates, notes, or memories, and the run goes without a book or the locator bar. Every player gets the buttons under a public answer, and a question button asks everyone again.

### Memory

Each player has a session and a lasting memory. The session lives in Redis for 24 hours after the last question. It holds the last 8 to 12 questions verbatim and a short summary of everything before them. The model writes that summary after the answer, so the player never waits for it. `/askx` requests land in the session as one line: what was asked and which commands came out.

Public questions have their own thread, one per server, apart from players' sessions. Each question there starts with the asker's name, so when a friend follows up on someone else's question, the agent knows what it's about. The thread lives 2 hours after the last question. Each automation agent has a thread of its own too, apart from the player's session, for 2 hours after its last wake.

The lasting memory sits in MongoDB and never expires. It's up to 30 short facts: where the base is, what the player is working on, how they like answers. The agent saves them itself and says so. The plugin gives players `/allay new`, `/allay memory` (with text, it saves a fact by hand), and `/allay forget` through the `/api/v2/users/{user_id}/…` endpoints described in the protocol.

`POST /api/ask` and `POST /api/askx` work as before for the Telegram bot and plugins older than 2.0: the same agent without game tools, one JSON answer. The session is shared between both API versions.

> Pending tool calls live in the process's memory, so the server assumes a single instance. With several, the tool result must reach the instance that holds the stream.

### Who pays for the model

A Minecraft server picks one of two ways in the plugin's config:

- 🔑 **Its own key (BYOK).** The plugin sends a key for OpenRouter or any OpenAI-compatible API in `X-Provider-Key`, plus the base URL, the model, and a search model. The backend uses the key for that one run and never stores or logs it. The model must call tools: before a run the backend checks the key and the model, and answers with a clear code (`PROVIDER_AUTH_FAILED`, `MODEL_NOT_FOUND`, `MODEL_NO_TOOLS`) that the plugin explains to operators. Without a search model, the run has no web search.
- ⭐ **A subscription.** The server runs on the backend's own key and models, which the plugin can't change. An operator runs `/allay link`: the backend makes a license, which the plugin keeps in `license.key`, and a one-time link to the backend's Telegram bot. There the admin pays in Telegram Stars.

| Plan | Stars | Period | Limit |
|---|---|---|---|
| Week | 150 | 7 days | $0.75 of model costs |
| Month | 500 | 30 days, renews by itself | $3.00 |
| Year | 10 000 | 365 days | $6.00 a month, refilled every 30 days |

The limit counts what the server's questions really cost: the model, web search, and session summaries. A payment while a period runs adds its limit at once and moves the end date. The plugin shows operators the limit as a percentage and never in dollars.

On a backend with billing on, BYOK is free but limited per server to 20 questions a minute, 2000 a day, and 4 at once. Its base URL must be `https://` and public, so nobody reaches the backend's own network through it.

**Self-hosted backends.** Set `SELFHOSTED=1`, and billing is off: the backend serves every request on its own key, nobody needs a license, BYOK works without limits, and the plugin needs no `/allay link`. Such a backend also takes the plugin's `provider.model` without a key, so a server can give each player tier its own model on the backend's key. Without the variable, billing is on, so a server that runs its own backend should set it.

The old `X-OpenRouter-Token` header still works, as BYOK on OpenRouter with the backend's models.

### Examples

```bash
# v1: one JSON answer
curl -X POST https://allay.chat/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "How do I craft a diamond pickaxe?", "platform": "telegram", "user_id": "42"}'
# {"answer": "...", "status": "success", "timestamp": "...", "platform": "telegram", "user_id": "42"}

# v2: a stream of events
curl -N -X POST https://allay.chat/api/v2/chat \
  -H "Content-Type: application/json" -H "Accept: text/event-stream" \
  -d '{"mode": "ask", "message": "what should I do next?", "user_id": "5627dd98-...", "player": {"name": "Steve"}, "tools": ["get_inventory"]}'
```

Send your own key with `-H "X-Provider-Key: sk-or-..."`, or a license with `-H "Authorization: Bearer <license>"`.

## Environment

| Variable | Purpose | Default |
|---|---|---|
| `OPENROUTER_API_KEY` | OpenRouter key | required |
| `OPENROUTER_API_URL` | OpenRouter API address | `https://openrouter.ai/api/v1` |
| `OPENROUTER_API_MODEL` | The agent's model. It must support tool calling: `perplexity/sonar*` won't do | `openai/gpt-6-luna` |
| `SEARCH_MODEL` | Online model for web search | `perplexity/sonar` |
| `OPENROUTER_API_CTX` | Search context size: `low`, `medium`, `high` | `medium` |
| `OPENROUTER_REASONING_EFFORT` | Reasoning effort for models that reason: `low`, `medium`, `high` | unset |
| `TOOL_TIMEOUT_MS` | How long to wait for the plugin's tool result | `15000` |
| `MAX_AGENT_STEPS` | Model calls per question | `8` |
| `MAX_TASK_STEPS` | Model calls per wake of an automation agent | `16` |
| `MAX_ACTIVE_RUNS` | Streaming questions at once | `200` |
| `SSE_PING_MS` | Ping interval that keeps proxies from closing the stream | `15000` |
| `CHAT_TTL_SECONDS` | How long a chat session lives after the last question | `86400` |
| `PUBLIC_CHAT_TTL_SECONDS` | How long a server's thread of public questions lives after the last one | `7200` |
| `TASK_CHAT_TTL_SECONDS` | How long an automation agent's thread lives after its last wake | `7200` |
| `CALC_TIMEOUT_MS` | How long `exact_calculations` gives one expression | `1000` |
| `SELFHOSTED` | `1` turns billing off: everyone runs on this backend's key | unset, so billing is on |
| `API_URL` | The backend's public address; the Telegram webhook goes to `API_URL/api/telegram/webhook` | `https://allay.chat` |
| `TELEGRAM_BOT_TOKEN` | The payment bot's token; without it there are no payment links | unset |
| `TELEGRAM_ADMIN_IDS` | Telegram user ids, comma-separated, that may `/refund <charge id>` in the bot | unset |
| `TELEGRAM_WEBHOOK_SECRET` | The webhook's secret token | derived from the bot token |
| `TELEGRAM_POLLING` | `1` takes updates by long polling instead of the webhook, for local runs | unset |
| `TELEGRAM_API_URL` | A Bot API server of your own | `https://api.telegram.org` |
| `TELEGRAM_TEST_ENV` | `1` talks to Telegram's test environment | unset |
| `PLAN_STARS` | Other prices, such as `week=1,month=1,year=1` for a test payment you refund | unset |

Prompts live in [src/prompts](src/prompts) (`minecraft-ask.md`, `minecraft-askx.md`, `minecraft-task.md` for automation agents, `telegram.md`) and ship inside the build. Each run appends who asks, their language, the server version, and the available tools. Remove old `SYSTEM_MESSAGE*` variables to switch to the new prompts. The old `SYSTEM_MESSAGE*` variables are no longer read. A `perplexity/…` main model can’t call tools, so the server moves it to search and answers with the default model.

## Deployment

### Docker Compose (recommended for production)

1. **Prepare configuration:**
   ```bash
   # Clone the repository
   git clone https://github.com/allay-ai/server
   cd server
   
   # Copy environment variables example
   cp .env.sample .env
   
   # Edit the .env file with your settings
   nano .env
   ```

2. **Domain setup:**
   ```bash
   # Edit Caddyfile and replace allay.chat with your domain
   nano configurations/caddy/Caddyfile
   ```

3. **Start:**
   ```bash
   docker compose up -d
   ```

4. **Check status:**
   ```bash
   docker compose logs -f allay-server
   ```

### Docker Compose with pre-built image

If you want to use the pre-built image and manage MongoDB/Redis yourself:

1. Declare the allay-server service in `docker-compose.yml`:

```yaml
services:
  allay-server:
    image: ghcr.io/allay-ai/server:4.0.0
    env_file: .env
    environment:
      MONGODB_URI: ${MONGODB_URI}
      REDIS_URL: ${REDIS_URL}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
      # ... other environment variables
```

> **Note**: You need to provide all environment variables from the `.env` file or any other convenient way.

2. Declare MongoDB and Redis services in `docker-compose.yml`. 
> Important, **MongoDB** version should be `8.0+`, and **Redis** should be `8.0+`.

3. Start the services:
```bash
docker compose up -d
```

### Bare Metal

1. **Install dependencies:**
   ```bash
   # Install Bun.js
   curl -fsSL https://bun.sh/install | bash
   
   # Install packages
   bun install
   ```
> Important! Don't forget to deploy dependent services: Redis, MongoDB and Caddy if needed.

2. **Configure environment variables:**
   ```bash
   cp .env.sample .env
   # Edit .env with settings for MongoDB, Redis and OpenRouter
   ```

3. **Start:**
   ```bash
   # Development
   bun run dev
   
   # Production
   bun run build
   bun run start
   ```

**⚠️ Important:** Make sure to configure environment variables from the `.env.sample` file before running. Pay special attention to `OPENROUTER_API_KEY`, `MONGODB_URI` and `REDIS_URL` and prompts.

### Bare Metal

Requirements:
- Bun 1.0+
- PostgreSQL 13+
- Redis 6.0+

1. Install dependencies:
```bash
curl -fsSL https://bun.sh/install | bash
bun install
```

2. Configure environment variables:
```bash
cp .env.sample .env
# Edit .env with settings for PostgreSQL, Redis and OpenRouter
```

3. Run database migrations:
```bash
bun run migrate
```

4. Run the server:
```bash
# Development
bun run dev

# Production
bun run build
bun run start
```

### Runtime Configuration

A request can bring its own key instead of the backend's; see “Who pays for the model” above.

```bash
X-Provider-Key: sk-or-your-key
```

## Tech Stack

- **TypeScript** — main development language
- **Bun.js** — fast JS runtime and package manager
- **Mastra** — the agent, tools, and streaming on top of the AI SDK
- **AI SDK + @openrouter/ai-sdk-provider** — access to OpenRouter models
- **zod** — request and tool schemas
- **MongoDB + Mongoose** — users and metrics
- **Redis** — chat history
- **Caddy** — reverse proxy and SSL termination
- **Docker + Docker Compose** — containerization and orchestration
- **tslog** — structured logging

## AI Participation

AI tools were used selectively for specific tasks: optimizing prompts for OpenRouter, generating part of the documentation, and refactoring some TypeScript types. The main architecture, business logic, and critical components were developed manually. Commits were fully written by an AI agent, with AI participation minimized where possible.

The move to Mastra and protocol v2 (the agent with tools, streaming, new prompts, tests) was done entirely by the Claude AI agent from my brief.

## Related projects

[Allay for Minecraft](https://github.com/allay-ai/minecraft)—💬 brings Allay into the game: ask the AI anything with `/ask`, right in the chat, in each player's language. 🎮

## From the same author

[Mo’Joins](https://github.com/MairwunNx/mojoins)—🎉 greets players in their own language: join and quit lines, a welcome for newcomers, sounds, and particles.

[Mo’Afks](https://github.com/MairwunNx/moafks)—🛡️ a safe AFK mode: no damage, no pushing, mobs ignore you, and AFK players don't block the night.

[Mo’Bosses](https://github.com/mairwunnx/mobosses)—🏆 an RPG plugin that turns ordinary mobs into epic bosses, with a deep player progression system.

## License

MIT, see [LICENSE](https://github.com/allay-ai/server/blob/master/LICENSE).

> 🫡 Made by Pavel Erokhin (Павел Ерохин), aka mairwunnx.
