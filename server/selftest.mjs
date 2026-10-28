// End-to-end check of server.mjs without a real identity provider: a fake OIDC issuer, then the editor's flow
// (registration, PKCE sign-in, upload, versions, refresh). Run: node selftest.mjs
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const b64url = (b) => Buffer.from(b).toString('base64url');
const fakePort = 18801, port = 18802, cbPort = 18803;
const issuer = `http://127.0.0.1:${fakePort}`;
const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url, issuer);
  if (url.pathname === '/.well-known/openid-configuration') return res.end(JSON.stringify({ authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token` }));
  if (url.pathname === '/auth') {
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'upstream-code');
    back.searchParams.set('state', url.searchParams.get('state'));
    return res.writeHead(302, { Location: back.toString() }).end();
  }
  if (url.pathname === '/token') {
    const idToken = ['e30', b64url(JSON.stringify({ email: 'Tester@Example.com', name: 'Tester' })), 'sig'].join('.');
    return res.end(JSON.stringify({ id_token: idToken, access_token: 'x' }));
  }
  res.writeHead(404).end();
}).listen(fakePort);

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-server-'));
const srv = spawn(process.execPath, ['server.mjs'], {
  cwd: path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')),
  env: { ...process.env, PORT: String(port), PUBLIC_URL: `http://127.0.0.1:${port}`, DATA_DIR: data, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'id', OIDC_CLIENT_SECRET: 'secret', ALLOWED_DOMAINS: 'example.com', KEEP_VERSIONS: '3' },
  stdio: 'inherit',
});
await new Promise((r) => setTimeout(r, 700));
const base = `http://127.0.0.1:${port}`;
const ok = (cond, msg) => { if (!cond) { console.error('FAIL', msg); srv.kill(); fake.close(); process.exit(1); } console.log('ok  ', msg); };
try {
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  ok(meta.registration_endpoint, 'metadata');
  const redirect = `http://127.0.0.1:${cbPort}/callback`;
  const bad = await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) });
  ok(bad.status === 400, 'non-loopback redirect refused');
  const client = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'test', redirect_uris: [redirect] }) })).json();
  ok(client.client_id, 'client registered');
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const auth = new URL(meta.authorization_endpoint);
  Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st' }).forEach(([k, v]) => auth.searchParams.set(k, v));
  // follow the browser: server -> fake provider -> server callback -> editor loopback
  let loc = auth.toString();
  for (let i = 0; i < 3; i++) loc = (await fetch(loc, { redirect: 'manual' })).headers.get('location');
  const back = new URL(loc);
  ok(back.origin + back.pathname === redirect && back.searchParams.get('state') === 'st', 'redirected back to the editor with code');
  const tokenReq = (b) => fetch(meta.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(b) });
  const wrong = await tokenReq({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: redirect, client_id: client.client_id, code_verifier: 'wrong'.repeat(10) });
  ok(wrong.status === 400, 'wrong PKCE verifier refused (code burned)');
  // fresh sign-in for the real exchange
  loc = auth.toString();
  for (let i = 0; i < 3; i++) loc = (await fetch(loc, { redirect: 'manual' })).headers.get('location');
  const tok = await (await tokenReq({ grant_type: 'authorization_code', code: new URL(loc).searchParams.get('code'), redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier })).json();
  ok(tok.access_token && tok.refresh_token, 'tokens issued');
  const api = (p, init = {}) => fetch(`${base}/api/editor/config${p}`, { ...init, headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  ok((await api('/')).status === 404, 'empty before first upload');
  const me = await (await api('/me')).json();
  ok(me.email === 'tester@example.com', 'me: ' + me.email);
  for (let i = 1; i <= 4; i++) {
    const r = await api('/', { method: 'PUT', body: JSON.stringify({ config: { n: i }, device: 'pc' }) });
    ok(r.status === 201, `upload v${i}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  const same = await (await api('/', { method: 'PUT', body: JSON.stringify({ config: { n: 4 } }) })).json();
  ok(same.unchanged === 1, 'same content is not a new version');
  const list = (await (await api('/versions')).json()).versions;
  ok(list.length === 3, 'keeps last 3 versions (KEEP_VERSIONS=3)');
  const latest = await (await api('/')).json();
  ok(latest.config.n === 4, 'latest content');
  const old = await (await api(`/versions/${list[2].id}`)).json();
  ok(old.config.n === 2, 'older version content');
  ok((await api(`/versions/${list[2].id}`, { method: 'DELETE' })).status === 200, 'delete version');
  ok((await (await api('/versions')).json()).versions.length === 2, 'two left');
  const ref = await (await tokenReq({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: client.client_id })).json();
  ok(ref.access_token, 'refresh');
  ok((await tokenReq({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: client.client_id })).status === 400, 'refresh token rotated');
  ok((await fetch(`${base}/api/editor/config/me`)).status === 401, 'no token -> 401');
  console.log('all good');
} finally {
  srv.kill();
  fake.close();
  fs.rmSync(data, { recursive: true, force: true });
}
