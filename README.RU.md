# 🛠️ Allay Server

[![GitHub Release](https://img.shields.io/github/v/release/allay-ai/server?style=flat&logo=github&color=blue)](https://github.com/allay-ai/server/releases) [![Build](https://img.shields.io/github/actions/workflow/status/allay-ai/server/build.yml?branch=master&style=flat&logo=githubactions&logoColor=white&label=build)](https://github.com/allay-ai/server/actions/workflows/build.yml) [![Docker image](https://img.shields.io/badge/ghcr.io-allay--ai%2Fserver-2496ED?style=flat&logo=docker&logoColor=white)](https://github.com/allay-ai/server/pkgs/container/server) [![License](https://img.shields.io/github/license/allay-ai/server?style=flat)](LICENSE)

[English version](https://github.com/allay-ai/server/blob/master/README.md)

**Allay Server** — мозг [Allay](https://github.com/allay-ai/minecraft), ИИ-помощника для игроков Minecraft. Он отвечает на каждый `/ask` с вашего сервера: заглядывает в игру игрока, ищет в интернете и помнит каждого. Запустите его сами одним файлом Docker Compose или пользуйтесь готовым на `allay.chat`.

## Что вы получаете

- **Ответы про ваш мир.** Прежде чем ответить, агент смотрит инвентарь спросившего, что вокруг, рецепты и плагины сервера.
- **Помощь прямо в мире.** Тропа к месту, призрачные блоки для постройки, подсвеченные сундуки с нужным, кнопки под каждым ответом.
- **Агенты для рутины.** Сортировку сундуков, переплавку, зельеварение и крафт ведут агенты автоматизации и сами отчитываются.
- **Свежие факты и точный счёт.** Поиск в интернете, когда вопрос того требует, и вычисления с 64 значащими цифрами.
- **Память для каждого игрока.** Сессия для уточняющих вопросов и до 30 долгих фактов, которыми игрок управляет сам.
- **Приватность по умолчанию.** Каждый запрос называет свой сервер, и сервер видит только своих игроков. Инструменты игры видят только спросившего, панель администратора называет игроков по нику, но никогда не показывает вопросы, а каждый игрок может получить копию своих данных или стереть их.
- **Панель администратора.** Все настройки, учётные записи с ролями и статистика по вопросам, расходам, моделям и инструментам.
- **Ваш ключ — ваши правила.** Свой ключ любого OpenAI-совместимого API, подписка за Telegram Stars или свой бэкенд без лимитов.

## С чего начать

1. Сохраните это как `compose.yaml`, подставьте [свежую версию](https://github.com/allay-ai/server/releases) и замените каждое `change-me` своим случайным значением (`openssl rand -hex 24`). Затем выполните `docker compose up -d`:

   ```yaml
   services:
     allay:
       image: ghcr.io/allay-ai/server:6.0.0
       restart: unless-stopped
       depends_on: [allay-mongo]
       ports: ["127.0.0.1:3000:3000"]
       environment:
         MONGODB_URI: mongodb://allay:change-me-mongo@allay-mongo:27017/?authSource=admin
         MONGODB_DATABASE: allay
         SELFHOSTED: "1"
         PLUGIN_TOKEN: change-me-to-24-random-characters
         SECRETS_KEY: change-me
         PUBLIC_URL: http://localhost:3000
     allay-mongo:
       image: mongo:8.0
       restart: unless-stopped
       environment:
         MONGO_INITDB_ROOT_USERNAME: allay
         MONGO_INITDB_ROOT_PASSWORD: change-me-mongo
       volumes: [mongo:/data/db]
   volumes:
     mongo:
   ```

2. Укажите в `config.yml` плагина `server.url` как `http://localhost:3000` и `server.token` — ваш `PLUGIN_TOKEN`, затем выполните `/allay reload`. После этого `/allay init` откроет панель администратора, где вы вставите ключ OpenRouter. Бэкенд слушает только эту машину; сервер Minecraft на другой машине достучится до него через обратный прокси с TLS.
3. Дальше — [Self-hosting with Docker](https://github.com/allay-ai/server/wiki/Self-hosting-with-Docker) в вики: прокси, пароли и обновления.

## Документация

Полное руководство — в [вики](https://github.com/allay-ai/server/wiki), на английском.

**Владельцам серверов:** [Self-hosting with Docker](https://github.com/allay-ai/server/wiki/Self-hosting-with-Docker) · [Environment variables](https://github.com/allay-ai/server/wiki/Environment-variables) · [Admin panel and settings](https://github.com/allay-ai/server/wiki/Admin-panel-and-settings) · [Who pays for the model](https://github.com/allay-ai/server/wiki/Who-pays-for-the-model) · [What Allay can do](https://github.com/allay-ai/server/wiki/What-Allay-can-do) · [Memory and traces](https://github.com/allay-ai/server/wiki/Memory-and-traces) · [Troubleshooting](https://github.com/allay-ai/server/wiki/Troubleshooting)

**Разработчикам:** [HTTP API](https://github.com/allay-ai/server/wiki/HTTP-API) · [Architecture](https://github.com/allay-ai/server/wiki/Architecture) · [Building from source](https://github.com/allay-ai/server/wiki/Building-from-source) · [Releasing](https://github.com/allay-ai/server/wiki/Releasing) · [Development](https://github.com/allay-ai/server/wiki/Development) · [Protocol v2](docs/protocol-v2.md)

## Связанные проекты

- **[Moonlands](https://minecraft.mairwunnx.com)** — сервер хардкорного выживания, где всё это работает.
- **[WorldAPI](https://github.com/MairwunNx/minecraft-worldapi)** — REST и WebSocket API к миру, игрокам и статистике сервера Paper.
- **[Minecraft MCP](https://github.com/MairwunNx/minecraft-mcp)** — даёт ИИ-клиенту читать сервер и управлять им через WorldAPI.
- **[Allay](https://github.com/allay-ai/minecraft)** — ИИ-помощник в игре: спрашивайте через `/ask` прямо в чате.
- **[Mo’Joins](https://github.com/MairwunNx/mojoins)** — сообщения о входе и выходе на языке каждого игрока.
- **[Mo’Afks](https://github.com/MairwunNx/moafks)** — безопасный AFK-режим, который не мешает пропустить ночь.
- **[Mo’Bosses](https://github.com/MairwunNx/mobosses)** — мобы, которые появляются боссами с классами, способностями и добычей.
- **[minecraft-exporter](https://github.com/MairwunNx/minecraft-exporter)** — метрики Prometheus из WorldAPI.
- **[minecraft-grafana](https://github.com/MairwunNx/minecraft-grafana)** — дашборд Grafana для WorldAPI.

> 🫡 Сделано Павлом Ерохиным (Pavel Erokhin), aka mairwunnx.
