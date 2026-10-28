#!/usr/bin/env node
// Claude Editor — self-hosted settings storage. Node 20+, no dependencies.
//
// The same protocol as Insider (parts.mrkt.ru), so the editor works with either:
//   OAuth 2.1 authorization server for the editor (dynamic client registration + PKCE, loopback redirect),
//   sign-in delegated to any OpenID Connect provider (Microsoft Entra ID, Google, Keycloak, Authentik…),
//   config API: GET /api/editor/config/me, GET|PUT /api/editor/config/, GET /versions, GET|DELETE /versions/:id.
// Data lives in DATA_DIR as JSON files; the last KEEP versions per user are kept. See README.md.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const env = process.env;
const PORT = Number(env.PORT || 8787);
const PUBLIC_URL = (env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const DATA_DIR = path.resolve(env.DATA_DIR || './data');
const KEEP = Number(env.KEEP_VERSIONS || 10);
const MAX_BYTES = 4 * 1024 * 1024;
const ACCESS_TTL = 4 * 3600;
const REFRESH_TTL = 30 * 24 * 3600;
const OIDC = { issuer: (env.OIDC_ISSUER || '').replace(/\/+$/, ''), clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET };
const ALLOWED_EMAILS = (env.ALLOWED_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const ALLOWED_DOMAINS = (env.ALLOWED_DOMAINS || '').toLowerCase().split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean);

if (!OIDC.issuer || !OIDC.clientId || !OIDC.clientSecret) {
  console.error('Set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET (see README.md).');
  process.exit(1);
}
fs.mkdirSync(path.join(DATA_DIR, 'users'), { recursive: true });

// --- tiny JSON store ----------------------------------------------------------------------------

const file = (name) => path.join(DATA_DIR, name);
function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(name, data) {
  fs.mkdirSync(path.dirname(file(name)), { recursive: true });
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file(name));
}

const clients = readJson('clients.json', {});
const tokens = readJson('tokens.json', {}); // sha256(token) -> record
const pending = new Map(); // our upstream state -> authorize request (10 min)
const codes = new Map(); // our code -> grant (2 min)

const sha = (s) => createHash('sha256').update(s).digest('hex');
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n = 32) => b64url(randomBytes(n));
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function pruneTokens() {
  const now = Date.now();
  for (const [k, t] of Object.entries(tokens)) if (t.expiresAt < now && (!t.refresh || t.refreshExpiresAt < now)) delete tokens[k];
  writeJson('tokens.json', tokens);
}

// --- upstream OIDC ------------------------------------------------------------------------------

let discovery = null;
async function oidc() {
  if (discovery) return discovery;
  const r = await fetch(`${OIDC.issuer}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`OIDC discovery failed: HTTP ${r.status}`);
  return (discovery = await r.json());
}

/** Claims of an id_token received directly from the provider's token endpoint over TLS (OIDC Core 3.1.3.7). */
function claims(idToken) {
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function allowed(email) {
  if (!email) return false;
  const e = email.toLowerCase();
  if (!ALLOWED_EMAILS.length && !ALLOWED_DOMAINS.length) return true;
  return ALLOWED_EMAILS.includes(e) || ALLOWED_DOMAINS.includes(e.split('@')[1]);
}

// --- config storage -----------------------------------------------------------------------------

const userDir = (email) => path.join('users', sha(email.toLowerCase()).slice(0, 32));
const indexOf = (email) => readJson(path.join(userDir(email), 'index.json'), []);

function meta(v) {
  return { id: v.id, created_at: v.created_at, size: v.size, device: v.device ?? null, app_version: v.app_version ?? null };
}

// --- HTTP ---------------------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BYTES + 64 * 1024) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] || '';
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  return text ? JSON.parse(text) : {};
}

function bearer(req) {
  const m = /^Bearer\s+(\S+)/.exec(req.headers.authorization || '');
  if (!m) return null;
  const t = tokens[sha(m[1])];
  return t && t.kind === 'access' && t.expiresAt > Date.now() ? t : null;
}

function issue(grant) {
  const access = 'eca_' + rand(36);
  const refresh = 'ecr_' + rand(36);
  const now = Date.now();
  tokens[sha(access)] = { kind: 'access', email: grant.email, name: grant.name, clientId: grant.clientId, expiresAt: now + ACCESS_TTL * 1000 };
  tokens[sha(refresh)] = { kind: 'refresh', email: grant.email, name: grant.name, clientId: grant.clientId, expiresAt: now + REFRESH_TTL * 1000, refreshExpiresAt: now + REFRESH_TTL * 1000 };
  pruneTokens();
  return { token_type: 'Bearer', access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL, scope: 'editor.config' };
}

const routes = {
  'GET /.well-known/oauth-authorization-server': (req, res) =>
    send(res, 200, {
      issuer: PUBLIC_URL,
      authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
      token_endpoint: `${PUBLIC_URL}/oauth/token`,
      registration_endpoint: `${PUBLIC_URL}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['editor.config'],
    }),

  'GET /health': (req, res) => send(res, 200, { ok: true }),

  'POST /oauth/register': async (req, res) => {
    const b = await body(req);
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u) => typeof u === 'string' && u.length < 512) : [];
    // Only loopback redirects: this server is for desktop editors.
    if (!uris.length || !uris.every((u) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(u))) return send(res, 400, { error: 'invalid_redirect_uri' });
    const id = 'ec_' + rand(18);
    clients[id] = { name: String(b.client_name || 'Claude Editor').slice(0, 200), redirect_uris: uris, created_at: new Date().toISOString() };
    writeJson('clients.json', clients);
    send(res, 201, { client_id: id, client_name: clients[id].name, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
  },

  'GET /oauth/authorize': async (req, res, url) => {
    const q = Object.fromEntries(url.searchParams);
    const client = clients[q.client_id];
    if (!client) return send(res, 400, 'unknown client');
    if (!client.redirect_uris.includes(q.redirect_uri)) return send(res, 400, 'redirect_uri mismatch');
    if (!q.code_challenge || (q.code_challenge_method || 'S256') !== 'S256') return send(res, 400, 'PKCE S256 required');
    const d = await oidc();
    const upstreamState = rand();
    pending.set(upstreamState, { clientId: q.client_id, redirectUri: q.redirect_uri, challenge: q.code_challenge, state: q.state || '', at: Date.now() });
    const u = new URL(d.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: OIDC.clientId, redirect_uri: `${PUBLIC_URL}/oauth/callback`, scope: 'openid email profile', state: upstreamState, prompt: 'select_account' }))
      u.searchParams.set(k, v);
    send(res, 302, '', { Location: u.toString() });
  },

  'GET /oauth/callback': async (req, res, url) => {
    const p = pending.get(url.searchParams.get('state') || '');
    if (!p || Date.now() - p.at > 10 * 60_000) return send(res, 400, 'sign-in expired or unknown — start again from the editor');
    pending.delete(url.searchParams.get('state'));
    if (url.searchParams.get('error')) return send(res, 400, `Sign-in failed: ${url.searchParams.get('error_description') || url.searchParams.get('error')}`);
    const d = await oidc();
    const r = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: `${PUBLIC_URL}/oauth/callback`, client_id: OIDC.clientId, client_secret: OIDC.clientSecret }),
    });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.id_token) return send(res, 502, `Provider token exchange failed: ${t.error_description || t.error || r.status}`);
    const c = claims(t.id_token);
    const email = c.email || c.preferred_username || c.upn;
    if (!allowed(email)) return send(res, 403, `${email || 'This account'} is not allowed on this server`);
    const code = 'ecc_' + rand(32);
    codes.set(code, { ...p, email: email.toLowerCase(), name: c.name || email, at: Date.now() });
    const back = new URL(p.redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', p.state);
    send(res, 302, '', { Location: back.toString() });
  },

  'POST /oauth/token': async (req, res) => {
    const b = await body(req);
    if (b.grant_type === 'authorization_code') {
      const g = codes.get(b.code || '');
      codes.delete(b.code || '');
      if (!g || Date.now() - g.at > 2 * 60_000 || g.clientId !== b.client_id || g.redirectUri !== b.redirect_uri) return send(res, 400, { error: 'invalid_grant' });
      const expected = b64url(createHash('sha256').update(String(b.code_verifier || '')).digest());
      if (!same(expected, g.challenge)) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
      return send(res, 200, issue(g));
    }
    if (b.grant_type === 'refresh_token') {
      const key = sha(String(b.refresh_token || ''));
      const t = tokens[key];
      if (!t || t.kind !== 'refresh' || t.refreshExpiresAt < Date.now() || t.clientId !== b.client_id) return send(res, 400, { error: 'invalid_grant' });
      delete tokens[key]; // rotation
      return send(res, 200, issue(t));
    }
    send(res, 400, { error: 'unsupported_grant_type' });
  },
};

/** Config API, the same as Insider's api/editor/config. */
async function configApi(req, res, rest) {
  const user = bearer(req);
  if (!user) return send(res, 401, { ok: 0, error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
  const dir = userDir(user.email);
  const index = indexOf(user.email);
  const key = `${req.method} ${rest}`;

  if (key === 'GET /me') return send(res, 200, { ok: 1, email: user.email, name: user.name, keep: KEEP });
  if (key === 'GET /versions') return send(res, 200, { ok: 1, versions: index.slice(0, KEEP).map(meta) });
  if (key === 'GET /' || key === 'GET ') {
    if (!index.length) return send(res, 404, { ok: 0, error: 'empty' });
    return send(res, 200, { ok: 1, version: meta(index[0]), config: readJson(path.join(dir, `${index[0].id}.json`), null) });
  }
  if (key === 'PUT /' || key === 'PUT ') {
    const b = await body(req);
    if (!b.config || typeof b.config !== 'object') return send(res, 422, { ok: 0, error: 'config required' });
    const json = JSON.stringify(b.config, null, 2);
    if (json.length > MAX_BYTES) return send(res, 413, { ok: 0, error: 'config too large' });
    const md5 = createHash('md5').update(json).digest('hex');
    if (index[0]?.md5 === md5) return send(res, 200, { ok: 1, unchanged: 1, version: meta(index[0]) });
    const v = { id: Date.now(), md5, size: Buffer.byteLength(json), device: b.device ? String(b.device).slice(0, 191) : null, app_version: b.app_version ? String(b.app_version).slice(0, 64) : null, created_at: new Date().toISOString() };
    fs.mkdirSync(file(dir), { recursive: true });
    fs.writeFileSync(file(path.join(dir, `${v.id}.json`)), json);
    const next = [v, ...index];
    for (const old of next.slice(KEEP)) fs.rmSync(file(path.join(dir, `${old.id}.json`)), { force: true });
    writeJson(path.join(dir, 'index.json'), next.slice(0, KEEP));
    return send(res, 201, { ok: 1, version: meta(v) });
  }
  const m = /^\/versions\/(\d+)$/.exec(rest);
  const v = m && index.find((x) => String(x.id) === m[1]);
  if (m && req.method === 'GET') {
    if (!v) return send(res, 404, { ok: 0, error: 'not found' });
    return send(res, 200, { ok: 1, version: meta(v), config: readJson(path.join(dir, `${v.id}.json`), null) });
  }
  if (m && req.method === 'DELETE') {
    if (!v) return send(res, 404, { ok: 0 });
    fs.rmSync(file(path.join(dir, `${v.id}.json`)), { force: true });
    writeJson(path.join(dir, 'index.json'), index.filter((x) => x !== v));
    return send(res, 200, { ok: 1 });
  }
  send(res, 404, { ok: 0, error: 'not found' });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url || '/', PUBLIC_URL);
    try {
      if (url.pathname.startsWith('/api/editor/config')) return await configApi(req, res, url.pathname.slice('/api/editor/config'.length) || '/');
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return send(res, 404, { error: 'not found' });
      await route(req, res, url);
    } catch (e) {
      console.error(e);
      send(res, e.status || 500, { error: e.status ? e.message : 'server error' });
    }
  })
  .listen(PORT, () => console.log(`Claude Editor settings server on ${PUBLIC_URL} (port ${PORT}), data in ${DATA_DIR}, OIDC ${OIDC.issuer}`));

// Forget unfinished sign-ins.
setInterval(() => {
  const now = Date.now();
  for (const [k, p] of pending) if (now - p.at > 10 * 60_000) pending.delete(k);
  for (const [k, c] of codes) if (now - c.at > 2 * 60_000) codes.delete(k);
}, 60_000).unref();
