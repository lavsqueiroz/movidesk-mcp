# ────────────────────────────────────────────────────────────────
# Movidesk MCP — Dockerfile
# Base: node:22-alpine | PM2 | Health check porta 3457
# ────────────────────────────────────────────────────────────────

FROM node:22-alpine

# Metadados
LABEL maintainer="lavsqueiroz"
LABEL description="Movidesk MCP HTTP Server v3.0.0"

# Ferramentas mínimas para build TS e healthcheck
RUN apk add --no-cache curl

# PM2 global
RUN npm install -g pm2@latest --no-audit --no-fund

# Diretório da aplicação
WORKDIR /home/node/app

# Copia manifesto primeiro (cache de layer)
COPY package*.json ./
COPY tsconfig.json ./

# Instala TODAS as deps (incluindo devDeps para build TS)
RUN npm install --no-audit --no-fund

# Copia código-fonte
COPY src/       ./src/
COPY prompts/   ./prompts/
COPY server.js  ./
COPY ecosystem.config.cjs ./
COPY entrypoint.sh ./

# Compila TypeScript
RUN npm run build

# Remove devDeps após build
RUN npm prune --omit=dev

# Permissões
RUN chmod +x entrypoint.sh \
  && mkdir -p logs \
  && chown -R node:node /home/node/app

USER node

EXPOSE 3457

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:3457/health | grep -q '"status":"ok"' || exit 1

ENTRYPOINT ["./entrypoint.sh"]
