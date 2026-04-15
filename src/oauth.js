/**
 * src/oauth.js
 * OAuth 2.0 Client Credentials com JWT stateless
 * Padrão Bridge — emite tokens para clients autorizados
 */

import jwt from 'jsonwebtoken';

const JWT_SECRET     = process.env.JWT_SECRET;
const JWT_EXPIRATION = process.env.JWT_EXPIRATION || '1h';
const CLIENT_ID      = process.env.MCP_CLIENT_ID      || 'movidesk-mcp-client';
const CLIENT_SECRET  = process.env.MCP_CLIENT_SECRET;

if (!JWT_SECRET)     throw new Error('[oauth] JWT_SECRET nao configurado');
if (!CLIENT_SECRET)  throw new Error('[oauth] MCP_CLIENT_SECRET nao configurado');

// ─────────────────────────────────────────────
// Emissão de token — POST /oauth/token
// Body: { grant_type, client_id, client_secret }
// ─────────────────────────────────────────────
export function issueToken(req, res) {
  const { grant_type, client_id, client_secret } = req.body || {};

  if (grant_type !== 'client_credentials') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  if (client_id !== CLIENT_ID || client_secret !== CLIENT_SECRET) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  const payload = {
    sub:   client_id,
    scope: 'mcp:call',
    iat:   Math.floor(Date.now() / 1000),
  };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRATION });

  return res.json({
    access_token: token,
    token_type:   'Bearer',
    expires_in:   parseDuration(JWT_EXPIRATION),
  });
}

// ─────────────────────────────────────────────
// Middleware de autenticação JWT
// ─────────────────────────────────────────────
export function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'missing_token' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.auth = decoded;
    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token';
    return res.status(401).json({ error: msg });
  }
}

// ─────────────────────────────────────────────
// Helper: converte string de duração → segundos
// ─────────────────────────────────────────────
function parseDuration(str) {
  const match = String(str).match(/^(\d+)([smhd])$/);
  if (!match) return 3600;
  const [, n, unit] = match;
  const factors = { s: 1, m: 60, h: 3600, d: 86400 };
  return parseInt(n, 10) * (factors[unit] || 3600);
}
