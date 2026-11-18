import { api, signedIn } from './auth';

/**
 * Errors of the app go to Insider (POST /api/editor/remote/log → editor_remote_logs), so they can be read from the
 * editor (MCP tool remote_logs) without the phone. Uncaught errors, rejected promises, console.error and what the app
 * reports itself; repeats within a minute are counted, not resent. Kept in localStorage until sent.
 */

interface Entry {
  level: 'error' | 'warn' | 'info';
  message: string;
  context?: unknown;
  at: number;
}

const KEY = 'mpi.logQueue';
let queue: Entry[] = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
})();
const recent = new Map<string, { at: number; n: number }>();
let version = '';
let sending = false;

export function setAppVersion(v: string) {
  version = v;
}

export function log(level: Entry['level'], message: string, context?: unknown) {
  const text = String(message || '').slice(0, 4000);
  if (!text) return;
  const key = level + text;
  const r = recent.get(key);
  if (r && Date.now() - r.at < 60_000) {
    r.n++;
    return;
  }
  recent.set(key, { at: Date.now(), n: 1 });
  queue.push({ level, message: text, context: context === undefined ? undefined : safe(context), at: Date.now() });
  queue = queue.slice(-200);
  persist();
}

function safe(v: unknown) {
  try {
    if (v instanceof Error) return { name: v.name, stack: v.stack };
    return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'string' && x.length > 2000 ? x.slice(0, 2000) + '…' : x)));
  } catch {
    return String(v);
  }
}
function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(queue));
  } catch {
    /* full */
  }
}

async function flush() {
  if (sending || !queue.length || !signedIn()) return;
  sending = true;
  const batch = queue.slice(0, 50);
  try {
    await api('/api/editor/remote/log', {
      source: 'phone',
      device: navigator.userAgent.match(/Android[^;)]*;\s*([^;)]+)/)?.[1]?.trim() ?? navigator.platform,
      app_version: version,
      entries: batch,
    });
    queue = queue.slice(batch.length);
    persist();
  } catch {
    /* offline: next time */
  } finally {
    sending = false;
  }
}

export function startLogging() {
  window.addEventListener('error', (e) => log('error', e.message || 'Ошибка', { stack: e.error?.stack, src: `${e.filename}:${e.lineno}:${e.colno}`, screen: location.hash }));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    log('error', r?.message ?? String(r), { stack: r?.stack, kind: 'unhandledrejection' });
  });
  const orig = console.error.bind(console);
  console.error = (...a: unknown[]) => {
    orig(...a);
    log('error', a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' ').slice(0, 2000), { stack: a.find((x) => x instanceof Error) instanceof Error ? (a.find((x) => x instanceof Error) as Error).stack : undefined, kind: 'console.error' });
  };
  setInterval(() => void flush(), 5000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void flush());
}
