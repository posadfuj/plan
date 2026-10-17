# Imagen de producción de Aiment Wallet: API, worker y scripts de base de datos.
# Un solo build; cada servicio arranca un comando distinto (ver docs/runbook.md, sección 10):
#   API:         node --enable-source-maps dist/api.js       (puerto API_PORT, 8787 por defecto)
#   Worker:      node --enable-source-maps dist/worker.js
#   Migraciones: node dist/migrate.js  ·  rol de la API: node dist/roles.js
# La PWA no va aquí: se publica en Cloudflare.

FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && node scripts/build-server.mjs

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Única dependencia fuera del paquete: trae el binario nativo para Linux (hash de PIN, argon2id).
RUN npm install --no-save --no-package-lock --no-audit --no-fund @node-rs/argon2@2.2.1 && npm cache clean --force
COPY --from=build /src/dist/server ./dist
# Las migraciones se buscan junto al paquete (../migrations desde dist/).
COPY --from=build /src/packages/db/migrations ./migrations
# @aiment/config ubica la raíz del proyecto por este archivo.
COPY pnpm-workspace.yaml ./
USER node
EXPOSE 8787
CMD ["node", "--enable-source-maps", "dist/api.js"]
