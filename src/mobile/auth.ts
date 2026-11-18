/**
 * MPI Remote sign-in: the same Insider OAuth as the editor (MS365, dynamic client registration + PKCE, scope
 * editor.config). Android has no loopback, so the redirect is https://parts.mrkt.ru/mpi-remote.html, which hands the
 * code to the app by its scheme mpiremote://callback (useless without the PKCE verifier, kept only here).
 */

export const SERVER = (localStorage.getItem('mpi.server') || 'https://parts.mrkt.ru').replace(/\/+$/, '');
const REDIRECT = localStorage.getItem('mpi.redirect') || 'https://parts.mrkt.ru/mpi-remote.html';
const SCOPE = 'editor.config';
const KEY = 'mpi.auth';

interface Auth {
  clientId: string;
  tokenEndpoint: string;
  access: string;
  refresh?: string;
  expiresAt?: number;
  email?: string;
  name?: string;
}

let auth: Auth | null = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
})();
function save(a: Auth | null) {
  auth = a;
  if (a) localStorage.setItem(KEY, JSON.stringify(a));
  else localStorage.removeItem(KEY);
}

export const signedIn = () => !!auth;
export const who = () => (auth ? { email: auth.email, name: auth.name } : null);

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const rnd = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function json(res: Response) {
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  if (!res.ok) throw new Error(data?.error_description || data?.error || `HTTP ${res.status}`);
  return data;
}

/** Opens the Insider sign-in in the browser; finish() gets the code back (deep link). */
export async function startLogin() {
  const meta = await json(await fetch(`${SERVER}/.well-known/oauth-authorization-server`));
  const client = await json(
    await fetch(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'MPI Remote (Android)',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: SCOPE,
      }),
    }),
  );
  const verifier = rnd(48);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = rnd(16);
  sessionStorage.setItem('mpi.pending', JSON.stringify({ verifier, state, clientId: client.client_id, tokenEndpoint: meta.token_endpoint }));
  localStorage.setItem('mpi.pending', JSON.stringify({ verifier, state, clientId: client.client_id, tokenEndpoint: meta.token_endpoint }));
  const url = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state, scope: SCOPE }))
    url.searchParams.set(k, v);
  const cap = (window as any).Capacitor;
  if (cap?.isNativePlatform?.()) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url: url.toString() });
  } else location.href = url.toString();
}

/** mpiremote://callback?code&state (or the same query on a web build) → tokens. */
export async function finishLogin(callbackUrl: string) {
  const u = new URL(callbackUrl.replace(/^mpiremote:\/\//, 'https://x/'));
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  const p = JSON.parse(localStorage.getItem('mpi.pending') || 'null');
  if (!code || !p) throw new Error(u.searchParams.get('error_description') || 'Вход не завершён');
  if (p.state !== state) throw new Error('Ответ входа не от этого запроса');
  localStorage.removeItem('mpi.pending');
  const tok = await json(
    await fetch(p.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: p.clientId, code_verifier: p.verifier }).toString(),
    }),
  );
  save({ clientId: p.clientId, tokenEndpoint: p.tokenEndpoint, access: tok.access_token, refresh: tok.refresh_token, expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined });
}

export function logout() {
  save(null);
}

let refreshing: Promise<void> | null = null;
function refresh() {
  return (refreshing ??= (async () => {
    if (!auth?.refresh) throw new Error('Сессия истекла — войдите снова');
    const res = await fetch(auth.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refresh, client_id: auth.clientId }).toString(),
    });
    if (res.status === 400 || res.status === 401) {
      save(null);
      throw new Error('Сессия истекла — войдите снова');
    }
    const tok = await json(res);
    save({ ...auth, access: tok.access_token, refresh: tok.refresh_token ?? auth.refresh, expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined });
  })().finally(() => (refreshing = null)));
}

/** JSON request to Insider with the token (refreshed on expiry / 401). */
export async function api(route: string, body?: unknown, retry = true): Promise<any> {
  if (!auth) throw new Error('Не выполнен вход');
  if (auth.expiresAt && auth.expiresAt < Date.now() + 60_000) await refresh();
  const res = await fetch(`${SERVER}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${auth!.access}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && retry && auth?.refresh) {
    await refresh();
    return api(route, body, false);
  }
  return json(res);
}

export function setWho(email?: string, name?: string) {
  if (auth) save({ ...auth, email, name });
}
