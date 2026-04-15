/**
 * server.js — Movidesk MCP HTTP Server v3.0.0
 * Express + JWT + rate-limit + security headers
 * Porta: 3457
 *
 * Rotas:
 *   POST /oauth/token          → emite JWT (Client Credentials)
 *   GET  /mcp                  → lista tools (requer Bearer)
 *   POST /mcp                  → executa tool  (requer Bearer)
 *   POST /webhook/movidesk     → recebe eventos Movidesk (valida HMAC opcional)
 *   GET  /health               → healthcheck (sem auth)
 */

import express          from 'express';
import rateLimit        from 'express-rate-limit';
import helmet          from 'helmet';
import crypto          from 'crypto';
import { issueToken, requireAuth } from './src/oauth.js';
import { handleTool }              from './src/handlers.js';
import { TOOLS }                   from './src/tools.js';

// ── Movidesk Client (JS wrapper sobre o TS compilado) ──────────────
// O TS ainda é compilado para dist/; importamos o cliente JS puro
// via dynamic import para suportar os dois modos (dev/prod).
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path              from 'path';
import fs                from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Importa MovideskClient — tenta dist/ (produção) e src/ (dev com ts-node)
async function loadMovideskClient() {
  // Caminho do cliente JS compilado
  const distPath = path.join(__dirname, 'dist', 'services', 'MovideskClient.js');
  if (fs.existsSync(distPath)) {
    const mod = await import(distPath);
    return mod.getMovideskClient();
  }
  // Fallback: carrega direto do TS via tsx/ts-node (apenas dev)
  const srcPath = path.join(__dirname, 'src', 'services', 'MovideskClient.js');
  const mod = await import(srcPath);
  return mod.getMovideskClient();
}

// ── App ───────────────────────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT || '3457', 10);

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Security headers (padrão Bridge)
app.use(helmet({
  contentSecurityPolicy:   false,   // MCP não usa CSP
  crossOriginEmbedderPolicy: false,
}));
app.disable('x-powered-by');

// Trust proxy (Nginx na frente)
app.set('trust proxy', 1);

// ── Rate limiting ─────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 min
  max:      20,
  message:  { error: 'too_many_requests' },
  standardHeaders: true,
  legacyHeaders:   false,
});

const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 min
  max:      120,
  message:  { error: 'rate_limit_exceeded' },
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => req.auth?.sub || req.ip,
});

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:  'ok',
    service: 'movidesk-mcp',
    version: '3.0.0',
    pid:     process.pid,
    uptime:  Math.floor(process.uptime()),
  });
});

// ── OAuth token ───────────────────────────────────────────────────
app.post('/oauth/token', authLimiter, issueToken);

// ── MCP GET — lista tools ─────────────────────────────────────────
app.get('/mcp', requireAuth, mcpLimiter, (_req, res) => {
  res.json({
    jsonrpc: '2.0',
    id:      null,
    result:  { tools: TOOLS },
  });
});

// ── MCP POST — executa tool ───────────────────────────────────────
app.post('/mcp', requireAuth, mcpLimiter, async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};

  if (jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', id: id ?? null,
      error: { code: -32600, message: 'Invalid Request' } });
  }

  // ── notifications/initialized — sem resposta ─────────────────
  if (method === 'notifications/initialized') {
    return res.status(204).end();
  }

  // ── initialize ───────────────────────────────────────────────
  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities:    { tools: {} },
        serverInfo:      { name: 'movidesk-mcp', version: '3.0.0' },
      },
    });
  }

  // ── tools/list ───────────────────────────────────────────────
  if (method === 'tools/list') {
    return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }

  // ── tools/call ───────────────────────────────────────────────
  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    if (!toolName) {
      return res.status(400).json({ jsonrpc: '2.0', id,
        error: { code: -32602, message: 'Missing tool name' } });
    }

    try {
      const client = await loadMovideskClient();
      const result = await handleTool(toolName, toolArgs, client);
      return res.json({ jsonrpc: '2.0', id, result });
    } catch (err) {
      console.error(`[mcp] tool=${toolName} error:`, err.message);
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          content:  [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }],
          isError:  true,
        },
      });
    }
  }

  // ── método desconhecido ───────────────────────────────────────
  return res.status(404).json({
    jsonrpc: '2.0', id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
});

// ── Webhook Movidesk (POST /webhook/movidesk) ─────────────────────
const WEBHOOK_SECRET = process.env.MOVIDESK_WEBHOOK_SECRET || '';

app.post('/webhook/movidesk', express.raw({ type: '*/*' }), (req, res) => {
  // Validação HMAC opcional — só ativa se MOVIDESK_WEBHOOK_SECRET estiver definido
  if (WEBHOOK_SECRET) {
    const sig = req.headers['x-movidesk-signature'] || '';
    const hmac = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(req.body)
      .digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac))) {
      return res.status(401).json({ error: 'invalid_signature' });
    }
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf-8'));
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }

  // Log estruturado — adapte para sua lógica de negócio
  console.log('[webhook] movidesk event:', JSON.stringify({
    event:    payload.event || payload.type || 'unknown',
    ticketId: payload.ticketId || payload.id || null,
    ts:       new Date().toISOString(),
  }));

  res.json({ received: true });
});

// ── 404 ───────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// ── Inicialização ─────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[movidesk-mcp] HTTP server listening on port ${PORT}`);
  console.log(`[movidesk-mcp] PID ${process.pid} | ${new Date().toISOString()}`);
});

export default app;
