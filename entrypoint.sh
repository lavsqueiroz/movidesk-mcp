#!/bin/sh
set -e

APP_DIR="/home/node/app"
LOG_DIR="${APP_DIR}/logs"

echo "[entrypoint] Movidesk MCP — iniciando..."
mkdir -p "${LOG_DIR}"

# ── Dependências ────────────────────────────────────────────────
echo "[entrypoint] Instalando dependencias de producao..."
cd "${APP_DIR}"
npm install --omit=dev --prefer-offline --no-audit --no-fund

# ── Build TS → JS (se dist/ não existir) ────────────────────────
if [ ! -d "${APP_DIR}/dist" ]; then
  echo "[entrypoint] Compilando TypeScript..."
  npm run build
fi

# ── PM2 plugins ─────────────────────────────────────────────────
echo "[entrypoint] Instalando pm2-logrotate e pm2-intercom..."
pm2 install pm2-logrotate  || true
pm2 install pm2-intercom   || true

pm2 set pm2-logrotate:max_size   50M
pm2 set pm2-logrotate:retain     7
pm2 set pm2-logrotate:compress   true
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'

# ── Sobe com pm2-runtime ────────────────────────────────────────
echo "[entrypoint] Subindo com pm2-runtime (5 workers, porta 3457)..."
exec pm2-runtime start ecosystem.config.cjs
