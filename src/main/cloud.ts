import { app, safeStorage, shell } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AppState, CloudStatus, CloudVersion } from '../shared/types';
import { emit } from './bus';
import { applySettings, exportable } from './settings-io';
import { withGitOrigins } from './git-info';
import { dataDir, stateFile } from './store';

/**
 * Cloud settings storage. The server is any OAuth 2.1 authorization server with dynamic client registration and
 * PKCE (Insider at parts.mrkt.ru signs in through Microsoft 365; server/ in this repo works with any OIDC provider)
 * plus the config API under /api/editor/config: GET /me, GET / (latest), PUT /, GET /versions, GET|DELETE /versions/:id.
 * The editor signs in through the system browser with a loopback redirect; tokens are kept encrypted (safeStorage).
 */

export const INSIDER = 'https://parts.mrkt.ru';
const SCOPE = 'editor.config';

interface Auth {
  server: string;
  clientId: string;
  tokenEndpoint: string;
  access: string;
  refresh?: string;
  expiresAt?: number;
}

const authFile = () => path.join(dataDir(), 'cloud-auth.bin');
let auth: Auth | null = loadAuth();
let busy: string | undefined;
let lastError: string | undefined;
let needsChoice = false;
let remote: CloudVersion | null | undefined;

function loadAuth(): Auth | null {
  try {
    const raw = fs.readFileSync(authFile());
    const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function saveAuth(a: Auth | null) {
  auth = a;
  if (!a) return void fs.rmSync(authFile(), { force: true });
  const text = JSON.stringify(a);
  fs.writeFileSync(authFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text));
}

const cfg = () => (stateFile.data.cloud ??= { server: INSIDER, auto: true });
const base = (server: string) => server.replace(/\/+$/, '');

export function status(): CloudStatus {
  const c = cfg();
  return {
    server: c.server,
    signedIn: !!auth && base(auth.server) === base(c.server),
    email: c.email,
    name: c.name,
    auto: c.auto,
    lastSyncAt: c.lastSyncAt,
    lastError,
    needsChoice,
    remote,
    busy,
  };
}

const publish = () => emit({ type: 'cloud', status: status() });

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  busy = label;
  lastError = undefined;
  publish();
  try {
    return await fn();
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    busy = undefined;
    publish();
  }
}

// --- sign in ------------------------------------------------------------------------------------

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function json(res: Response) {
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new Error(body?.error_description || body?.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
  return body;
}

/** Waits for the browser to come back to http://127.0.0.1:<port>/callback. */
function loopback(): Promise<{ redirect: string; code: Promise<{ code: string; state: string }>; close: () => void }> {
  return new Promise((resolve, reject) => {
    let done: (v: { code: string; state: string }) => void;
    let fail: (e: Error) => void;
    const code = new Promise<{ code: string; state: string }>((a, b) => ((done = a), (fail = b)));
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') return void res.writeHead(404).end();
      const err = url.searchParams.get('error');
      const ok = !err && url.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Claude Editor</title><body style="font:16px system-ui;background:#1e1f22;color:#dfe1e5;display:grid;place-items:center;height:90vh">` +
          (ok ? '<div>✓ Вход выполнен. Вернитесь в Claude Editor — эту вкладку можно закрыть.</div>' : `<div>Вход не удался: ${String(err ?? 'нет кода').replace(/[<>&]/g, '')}</div>`) +
          '</body>',
      );
      if (ok) done({ code: ok, state: url.searchParams.get('state') ?? '' });
      else fail(new Error(`Вход отклонён: ${url.searchParams.get('error_description') || err || 'нет кода'}`));
    });
    const timer = setTimeout(() => fail(new Error('Вход не завершён за 5 минут')), 5 * 60_000);
    const close = () => {
      clearTimeout(timer);
      server.close();
    };
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ redirect: `http://127.0.0.1:${port}/callback`, code, close });
    });
  });
}

export function login(server: string) {
  return step('Вход…', async () => {
    server = base(server.trim() || INSIDER);
    if (!/^https?:\/\//.test(server)) server = 'https://' + server;
    const meta = await json(await fetch(`${server}/.well-known/oauth-authorization-server`));
    if (!meta?.authorization_endpoint || !meta?.token_endpoint || !meta?.registration_endpoint) {
      throw new Error('Сервер не похож на хранилище настроек: нет OAuth-метаданных');
    }
    const lb = await loopback();
    try {
      const client = await json(
        await fetch(meta.registration_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            client_name: `Claude Editor (${os.hostname()})`,
            redirect_uris: [lb.redirect],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            scope: SCOPE,
          }),
        }),
      );
      const verifier = b64url(randomBytes(48));
      const challenge = b64url(createHash('sha256').update(verifier).digest());
      const state = b64url(randomBytes(16));
      const url = new URL(meta.authorization_endpoint);
      for (const [k, v] of Object.entries({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: lb.redirect,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        scope: SCOPE,
      }))
        url.searchParams.set(k, v);
      await shell.openExternal(url.toString());
      const back = await lb.code;
      if (back.state !== state) throw new Error('Ответ входа не от этого запроса (state)');
      const tok = await json(
        await fetch(meta.token_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code: back.code, redirect_uri: lb.redirect, client_id: client.client_id, code_verifier: verifier }),
        }),
      );
      saveAuth({ server, clientId: client.client_id, tokenEndpoint: meta.token_endpoint, access: tok.access_token, refresh: tok.refresh_token, expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined });
    } finally {
      lb.close();
    }
    const c = cfg();
    const switched = base(c.server) !== server;
    c.server = server;
    if (switched) {
      c.lastSyncAt = undefined;
      c.hash = undefined;
      c.choiceMade = false;
    }
    const me = await api('/me');
    c.email = me.email;
    c.name = me.name;
    stateFile.save();
    await afterSignIn();
    return status();
  });
}

/** On a machine that never synced with this storage and the storage already has settings, the user chooses. */
async function afterSignIn() {
  const c = cfg();
  const list = await versions();
  remote = list[0] ?? null;
  needsChoice = !c.choiceMade && !!remote;
  if (!remote) {
    c.choiceMade = true;
    stateFile.save();
    if (c.auto) await upload();
  }
}

export function logout() {
  saveAuth(null);
  const c = cfg();
  c.email = c.name = undefined;
  needsChoice = false;
  remote = undefined;
  stateFile.save();
  publish();
  return status();
}

// --- API ----------------------------------------------------------------------------------------

async function refresh() {
  if (!auth?.refresh) throw new Error('Сессия облака истекла — войдите снова');
  const tok = await json(
    await fetch(auth.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refresh, client_id: auth.clientId }),
    }),
  ).catch((e) => {
    saveAuth(null);
    throw new Error(`Сессия облака истекла — войдите снова (${e.message})`);
  });
  saveAuth({ ...auth, access: tok.access_token, refresh: tok.refresh_token ?? auth.refresh, expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined });
}

async function api(route: string, init: RequestInit = {}, retry = true): Promise<any> {
  if (!auth) throw new Error('Не выполнен вход в облако настроек');
  if (auth.expiresAt && auth.expiresAt < Date.now() + 60_000) await refresh();
  const res = await fetch(`${base(auth.server)}/api/editor/config${route}`, {
    ...init,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${auth!.access}`, ...(init.headers ?? {}) },
  });
  if (res.status === 401 && retry && auth.refresh) {
    await refresh();
    return api(route, init, false);
  }
  if (res.status === 404 && route === '/') return null;
  return json(res);
}

export async function versions(): Promise<CloudVersion[]> {
  return (await api('/versions'))?.versions ?? [];
}

/**
 * What goes to the cloud: settings without what only makes sense on this machine right now (open tabs, chats,
 * expanded folders) — otherwise every click would make a new version and push real changes out of the last 10.
 */
export function payload(): Partial<AppState> {
  const { openChats: _a, activeChat: _b, chatProject: _c, openFiles: _d, activeFile: _e, chatModels: _f, cloud: _g, ...rest } = exportable();
  const ui = rest.ui ? { ...rest.ui, treeOpen: undefined } : undefined;
  const groups = rest.groups?.map(({ openChats: _1, activeChat: _2, chatProject: _3, openFiles: _4, activeFile: _5, treeOpen: _6, ...g }) => g);
  // git origins go along, so a new machine can clone projects it doesn't have
  return withGitOrigins({ ...rest, ui, groups } as Partial<AppState>);
}

const hashOf = (p: unknown) => createHash('md5').update(JSON.stringify(p)).digest('hex');

export function upload() {
  return step('Сохраняю в облако…', async () => {
    const p = payload();
    const r = await api('/', { method: 'PUT', body: JSON.stringify({ config: p, device: os.hostname(), app_version: app.getVersion() }) });
    const c = cfg();
    c.hash = hashOf(p);
    c.lastSyncAt = Date.now();
    c.choiceMade = true;
    needsChoice = false;
    remote = r?.version ?? remote;
    stateFile.save();
    return status();
  });
}

/** Applies a cloud version (latest when no id). Open tabs, chats and other local state stay as they are. */
export function download(id?: number | string) {
  return step('Загружаю из облака…', async () => {
    const r = await api(id === undefined ? '/' : `/versions/${id}`);
    if (!r?.config) throw new Error('В облаке ещё нет настроек');
    const local = stateFile.data;
    const incoming = r.config as Partial<AppState>;
    // Groups keep their local open tabs and chats.
    const groups = incoming.groups?.map((g) => {
      const mine = local.groups?.find((x) => x.id === g.id);
      return { ...g, openChats: [] as string[], ...(mine ? { openChats: mine.openChats, activeChat: mine.activeChat, chatProject: mine.chatProject, openFiles: mine.openFiles, activeFile: mine.activeFile, treeOpen: mine.treeOpen } : {}) };
    });
    const cloud = local.cloud;
    applySettings({ ...incoming, ...(groups ? { groups } : {}), ui: { ...incoming.ui!, treeOpen: local.ui.treeOpen } } as Partial<AppState>);
    stateFile.data.cloud = cloud;
    const c = cfg();
    c.hash = hashOf(payload());
    c.lastSyncAt = Date.now();
    c.choiceMade = true;
    needsChoice = false;
    stateFile.save();
    return status();
  });
}

export function deleteVersion(id: number | string) {
  return step('Удаляю версию…', async () => {
    await api(`/versions/${id}`, { method: 'DELETE' });
    return versions();
  });
}

export function setOptions(o: { server?: string; auto?: boolean }) {
  const c = cfg();
  if (o.server !== undefined && base(o.server) !== base(c.server)) {
    c.server = base(o.server.trim() || INSIDER);
    c.lastSyncAt = undefined;
    c.hash = undefined;
    c.choiceMade = false;
  }
  if (o.auto !== undefined) c.auto = o.auto;
  stateFile.save();
  publish();
  return status();
}

/** Uploads on its own a little while after settings stop changing. */
export function startAutoSync() {
  let seen = '';
  let changedAt = 0;
  setInterval(() => {
    const c = cfg();
    if (!c.auto || !auth || busy || needsChoice || !c.choiceMade || base(auth.server) !== base(c.server)) return;
    const h = hashOf(payload());
    if (h !== seen) {
      seen = h;
      changedAt = Date.now();
    }
    if (h !== c.hash && Date.now() - changedAt > 20_000) void upload().catch(() => {});
  }, 10_000);
  // Signed in earlier: check whether this machine still has to choose (e.g. the first sign-in was cancelled).
  if (auth && !cfg().choiceMade) void afterSignIn().catch(() => {}).finally(publish);
}
