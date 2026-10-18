FROM oven/bun:1.4.3-alpine AS base
WORKDIR /usr/src/app

FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# The admin panel: React built by Vite into static files the backend serves at /admin.
FROM base AS admin
WORKDIR /usr/src/admin
COPY admin/package.json admin/bun.lock ./
RUN bun install --frozen-lockfile
COPY admin/ ./
RUN bun run build

FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

ENV NODE_ENV=production
RUN bun run build

FROM base AS release
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/dist ./dist
COPY --from=prerelease /usr/src/app/package.json .
COPY --from=admin /usr/src/admin/dist ./dist/admin

# The key that seals stored secrets lives here unless SECRETS_KEY is set; mount a volume, or they die with the container.
RUN mkdir -p /data && chown bun:bun /data

USER bun
EXPOSE 3000/tcp
CMD ["bun", "run", "dist/application/entrypoint.js"]