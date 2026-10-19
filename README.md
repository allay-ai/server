# 🛠️ Allay Server

[![GitHub Release](https://img.shields.io/github/v/release/allay-ai/server?style=flat&logo=github&color=blue)](https://github.com/allay-ai/server/releases) [![Build](https://img.shields.io/github/actions/workflow/status/allay-ai/server/build.yml?branch=master&style=flat&logo=githubactions&logoColor=white&label=build)](https://github.com/allay-ai/server/actions/workflows/build.yml) [![Docker image](https://img.shields.io/badge/ghcr.io-allay--ai%2Fserver-2496ED?style=flat&logo=docker&logoColor=white)](https://github.com/allay-ai/server/pkgs/container/server) [![License](https://img.shields.io/github/license/allay-ai/server?style=flat)](LICENSE)

[Русская версия](https://github.com/allay-ai/server/blob/master/README.RU.md)

**Allay Server** is the brain behind [Allay](https://github.com/allay-ai/minecraft), the AI helper for Minecraft players. It answers every `/ask` from your server: it looks into the player's game, searches the web, and remembers each player. Run it yourself with one Docker Compose file, or use the hosted one at `allay.chat`.

## What you get

- **Answers about your world.** The agent reads the asker's inventory, surroundings, recipes, and the server's plugins before it answers.
- **Help in the world.** Trails to a spot, ghost blocks to build into, glowing chests that hold what you need, buttons under every answer.
- **Agents that do the chores.** Sorting chests, smelting, brewing, and crafting run as automation agents that report back.
- **Fresh facts and exact math.** Web search when a question needs it, and calculations at 64 significant digits.
- **A memory per player.** A session for follow-ups, plus up to 30 lasting facts the player controls.
- **Privacy by design.** Game tools see only the asker, and the admin panel never shows what anyone asked or got as an answer.
- **An admin panel.** Every setting, accounts with roles, and statistics on questions, cost, models, and tools.
- **Your key, your rules.** Bring any OpenAI-compatible key, subscribe in Telegram Stars, or self-host with no limits.

## Get started

1. Save this as `compose.yaml` with the [newest version](https://github.com/allay-ai/server/releases) and a random `SECRETS_KEY`, then run `docker compose up -d`:

   ```yaml
   services:
     allay:
       image: ghcr.io/allay-ai/server:5.12.3
       restart: unless-stopped
       depends_on: [allay-mongo, allay-redis]
       ports: ["3000:3000"]
       environment:
         MONGODB_URI: mongodb://allay-mongo:27017
         MONGODB_DATABASE: allay
         REDIS_URL: redis://allay-redis:6379
         SELFHOSTED: "1"
         SECRETS_KEY: change-me
         PUBLIC_URL: http://localhost:3000
     allay-mongo:
       image: mongo:8.0
       restart: unless-stopped
       volumes: [mongo:/data/db]
     allay-redis:
       image: redis:8-alpine
       restart: unless-stopped
   volumes:
     mongo:
   ```

2. Set `server.url` in the plugin's `config.yml` to `http://your-host:3000` and run `/allay reload`. Then `/allay init` opens the admin panel, where you paste your OpenRouter key.
3. [Self-hosting with Docker](https://github.com/allay-ai/server/wiki/Self-hosting-with-Docker) goes further: proxies, passwords, and upgrades.

## Documentation

The [wiki](https://github.com/allay-ai/server/wiki) holds the full manual.

**For server owners:** [Self-hosting with Docker](https://github.com/allay-ai/server/wiki/Self-hosting-with-Docker) · [Environment variables](https://github.com/allay-ai/server/wiki/Environment-variables) · [Admin panel and settings](https://github.com/allay-ai/server/wiki/Admin-panel-and-settings) · [Who pays for the model](https://github.com/allay-ai/server/wiki/Who-pays-for-the-model) · [What Allay can do](https://github.com/allay-ai/server/wiki/What-Allay-can-do) · [Memory and traces](https://github.com/allay-ai/server/wiki/Memory-and-traces) · [Troubleshooting](https://github.com/allay-ai/server/wiki/Troubleshooting)

**For developers:** [HTTP API](https://github.com/allay-ai/server/wiki/HTTP-API) · [Architecture](https://github.com/allay-ai/server/wiki/Architecture) · [Building from source](https://github.com/allay-ai/server/wiki/Building-from-source) · [Releasing](https://github.com/allay-ai/server/wiki/Releasing) · [Development](https://github.com/allay-ai/server/wiki/Development) · [Protocol v2](docs/protocol-v2.md)

## Related projects

- **[Moonlands](https://minecraft.mairwunnx.com)**—the hard-survival server where all of these run.
- **[WorldAPI](https://github.com/MairwunNx/minecraft-worldapi)**—REST and WebSocket API to a Paper server's world, players, and stats.
- **[Minecraft MCP](https://github.com/MairwunNx/minecraft-mcp)**—lets an AI client read and run a server through WorldAPI.
- **[Allay](https://github.com/allay-ai/minecraft)**—an AI helper in the game: ask with `/ask`, right in the chat.
- **[Mo’Joins](https://github.com/MairwunNx/mojoins)**—join and quit messages in each player's language.
- **[Mo’Afks](https://github.com/MairwunNx/moafks)**—a safe AFK mode that doesn't block the night.
- **[Mo’Bosses](https://github.com/MairwunNx/mobosses)**—monsters that spawn as bosses with classes, abilities, and loot.
- **[minecraft-exporter](https://github.com/MairwunNx/minecraft-exporter)**—Prometheus metrics from WorldAPI.
- **[minecraft-grafana](https://github.com/MairwunNx/minecraft-grafana)**—the Grafana dashboard for WorldAPI.

> 🫡 Made by Pavel Erokhin (Павел Ерохин), aka mairwunnx.
