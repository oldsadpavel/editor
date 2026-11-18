import type { MainEvent } from '../shared/types';
import { decoder, encode, packArgs, type Codec, type PcMsg, type PhoneMsg } from '../shared/remote-wire';
import { api, setWho } from './auth';

/**
 * window.bridge of the phone app: the editor's renderer (store, chats, tree, editor) runs unchanged, its calls go to
 * the editor on the PC through Insider (socket.mrkt.ru + POST /api/editor/remote/send). Layout state (open tabs…) stays
 * on the phone; what the PC doesn't allow from a phone gets a harmless local answer or an error.
 */

const WS_URL = localStorage.getItem('mpi.ws') || 'wss://socket.mrkt.ru/app/AvhruqKvgjpo6yhc2KHy';
const PHONE_ID = (() => {
  let id = localStorage.getItem('mpi.phoneId');
  if (!id) localStorage.setItem('mpi.phoneId', (id = crypto.randomUUID()));
  return id;
})();
const PHONE_NAME = localStorage.getItem('mpi.phoneName') || (navigator.userAgent.match(/Android[^;)]*;\s*([^;)]+)/)?.[1] ?? 'Телефон').trim();

async function stream(data: Uint8Array, kind: 'compress' | 'decompress') {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(kind === 'compress' ? new CompressionStream('deflate-raw') : new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
const codec: Codec = {
  deflate: async (t) => {
    const b = await stream(new TextEncoder().encode(t), 'compress');
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  },
  inflate: async (b64) => new TextDecoder().decode(await stream(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), 'decompress')),
};
const decode = decoder(codec);

export type LinkState = { state: 'connecting' | 'online' | 'error'; pc?: { name: string; version: string; at: number }; error?: string };
const stateListeners = new Set<(s: LinkState) => void>();
let link: LinkState = { state: 'connecting' };
function setLink(patch: Partial<LinkState>) {
  link = { ...link, ...patch };
  for (const l of stateListeners) l(link);
}
export const onLink = (fn: (s: LinkState) => void) => {
  stateListeners.add(fn);
  fn(link);
  return () => void stateListeners.delete(fn);
};

const listeners = new Set<(e: MainEvent) => void>();
let ws: WebSocket | null = null;
let socketId = '';
let channel = '';
let seq = 0;
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: number; acked?: boolean }>();
const subs = new Set<string>();
let pcTimer: number | undefined;

/** Layout keys of AppState kept on the phone (the PC's tabs stay as they are). */
const LOCAL_STATE = 'mpi.layout';
const localLayout = (): Record<string, unknown> => JSON.parse(localStorage.getItem(LOCAL_STATE) || '{}');

export function start() {
  connect();
  setInterval(() => void sendMsg({ k: 'hello', from: PHONE_ID, name: PHONE_NAME }).catch(() => {}), 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!ws || ws.readyState !== WebSocket.OPEN)) connect();
  });
}

async function connect() {
  try {
    ws?.close();
  } catch {
    /* closed */
  }
  setLink({ state: 'connecting' });
  try {
    const me = await api('/api/editor/remote/me');
    channel = me.channel;
    setWho(me.email, me.name);
  } catch (e: any) {
    setLink({ state: 'error', error: e.message });
    setTimeout(connect, 10_000);
    return;
  }
  const sock = new WebSocket(`${WS_URL}?protocol=7&client=mpi-remote&version=1.0`);
  ws = sock;
  let ping: number | undefined;
  sock.onmessage = async (m) => {
    if (ws !== sock) return;
    const e = JSON.parse(String(m.data));
    if (e.event === 'pusher:connection_established') {
      socketId = JSON.parse(e.data).socket_id;
      try {
        const a = await api('/api/editor/remote/auth', { socket_id: socketId, channel_name: channel });
        sock.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: a.auth, channel } }));
      } catch (err: any) {
        setLink({ state: 'error', error: err.message });
      }
    } else if (e.event === 'pusher_internal:subscription_succeeded') {
      ping = window.setInterval(() => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ event: 'pusher:ping', data: {} })), 25_000);
      void hello();
    } else if (e.event === 'pusher:ping') {
      sock.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
    } else if (e.event === 'f' && e.channel === channel) {
      const d = (typeof e.data === 'string' ? JSON.parse(e.data) : e.data)?.d;
      if (typeof d !== 'string') return;
      const msg = (await decode(d).catch(() => undefined)) as PcMsg | PhoneMsg | undefined;
      if (msg) onPc(msg as PcMsg);
    }
  };
  sock.onclose = () => {
    clearInterval(ping);
    if (ws !== sock) return;
    setLink({ state: 'error', error: 'Нет связи с сервером — переподключаюсь' });
    setTimeout(connect, 3000);
  };
}

/** Says hello; the PC answers with «pc». No answer — the editor is closed or the 📱 switch is off. */
async function hello() {
  await sendMsg({ k: 'hello', from: PHONE_ID, name: PHONE_NAME }).catch(() => {});
  if (subs.size) void sendMsg({ k: 'sub', from: PHONE_ID, ids: [...subs] }).catch(() => {});
  clearTimeout(pcTimer);
  pcTimer = window.setTimeout(() => !link.pc && setLink({ state: 'error', error: 'Компьютер не отвечает: редактор закрыт или на нём снята галочка «📱 Телефон»' }), 12_000);
}

function onPc(m: PcMsg) {
  if (m.k === 'pc') {
    if (m.to && m.to !== PHONE_ID) return;
    clearTimeout(pcTimer);
    const first = !link.pc;
    setLink({ state: 'online', pc: { name: m.name, version: m.version, at: Date.now() }, error: undefined });
    if (!m.to) void hello(); // the PC (re)connected: tell it who we are
    else if (first && subs.size) void sendMsg({ k: 'sub', from: PHONE_ID, ids: [...subs] }).catch(() => {});
  } else if (m.k === 'off') {
    setLink({ state: 'error', pc: undefined, error: 'На компьютере выключен доступ с телефона' });
  } else if (m.k === 'ack') {
    const w = m.to === PHONE_ID ? waiting.get(m.id) : undefined;
    if (w) w.acked = true;
  } else if (m.k === 'res') {
    if (m.to !== PHONE_ID) return;
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    clearTimeout(w.timer);
    if (m.ok) w.resolve(m.value);
    else w.reject(new Error(m.error || 'Ошибка'));
  } else if (m.k === 'ev') {
    for (const e of m.list as MainEvent[]) for (const l of listeners) l(e);
  }
}

let chain: Promise<void> = Promise.resolve();
function sendMsg(msg: PhoneMsg): Promise<void> {
  const p = chain.then(async () => {
    for (const d of await encode(msg, codec)) await api('/api/editor/remote/send', { d, socket_id: socketId });
  });
  chain = p.catch(() => {});
  return p;
}

function rpc(ch: string, args: unknown[]): Promise<any> {
  if (link.state !== 'online') return Promise.reject(new Error(link.error || 'Нет связи с компьютером'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      waiting.delete(id);
      reject(new Error('Компьютер не ответил за 2 минуты'));
    }, 120_000);
    waiting.set(id, { resolve, reject, timer });
    // the PC acknowledges every call at once: no ack in 10 s — it is gone (closed, switched off, asleep)
    window.setTimeout(() => {
      const w = waiting.get(id);
      if (!w || w.acked) return;
      waiting.delete(id);
      clearTimeout(w.timer);
      setLink({ state: 'error', pc: undefined, error: 'Компьютер не отвечает: редактор закрыт или на нём снята галочка «📱 Телефон»' });
      void hello();
      reject(new Error('Компьютер не отвечает'));
    }, 10_000);
    sendMsg({ k: 'rpc', from: PHONE_ID, id, ch, args: packArgs(args) }).catch((e) => {
      waiting.delete(id);
      clearTimeout(timer);
      reject(e);
    });
  });
}

function subscribe(id: string, on: boolean) {
  const had = subs.has(id);
  if (on) subs.add(id);
  else subs.delete(id);
  if (had !== on) void sendMsg({ k: 'sub', from: PHONE_ID, ids: [...subs] }).catch(() => {});
}

/** Channels answered on the phone: layout, desktop-only features, things the PC doesn't give to a phone. */
const LOCAL: Record<string, (...a: any[]) => unknown> = {
  'state:set': (patch: Record<string, unknown>) => {
    localStorage.setItem(LOCAL_STATE, JSON.stringify({ ...localLayout(), ...patch }));
  },
  'chat:close': (id: string) => subscribe(id, false),
  'fs:watch': () => undefined,
  'fs:unwatch': () => undefined,
  'notify:done': () => undefined,
  'notify:task': () => undefined,
  'sounds:system': () => [],
  'tests:list': () => [],
  'keys:last': () => null,
  'cache:last': () => null,
  'ping:list': () => [],
  'serverTests:list': () => ({}),
  'cloud:status': () => ({ server: '', signedIn: false, auto: false }),
  'auth:status': () => ({ loggedIn: true }),
  'setup:status': () => [],
  'app:pendingUpdate': () => null,
  'editor:context': () => undefined,
  'clipboard:text': () => navigator.clipboard?.readText?.() ?? '',
  'clipboard:files': () => [],
  'shell:open': (url: string) => window.open(url, '_blank'),
};

export const wsBridge = {
  async invoke<T = any>(channel: string, ...args: unknown[]): Promise<T> {
    if (LOCAL[channel]) return (await LOCAL[channel](...args)) as T;
    if (channel === 'state:get') {
      const s = await rpc('state:get', []);
      return { ...s, ...localLayout(), openChats: (localLayout().openChats as string[]) ?? [], chatPanes: [] } as T;
    }
    const v = await rpc(channel, args);
    if (channel === 'chat:open') subscribe(String(args[0]), true);
    if (channel === 'chat:new' && v && typeof v === 'object' && 'sessionId' in v) subscribe(String((v as any).sessionId), true);
    return v as T;
  },
  on(fn: (e: MainEvent) => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
  pathForFile: () => '',
};
