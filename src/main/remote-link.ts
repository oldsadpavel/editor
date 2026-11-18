import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { MainEvent, RemoteLinkStatus } from '../shared/types';
import { decoder, encode, unpackArgs, type Codec, type PcMsg, type PhoneMsg } from '../shared/remote-wire';
import { emit, listen } from './bus';
import * as cloud from './cloud';
import { handlers } from './rpc';
import { dataDir, stateFile } from './store';

/**
 * The phone link: MPI Remote (Android) controls this editor from anywhere, through Insider.
 *
 * Both sides sign in with the same Insider account (MS365) and listen on the user's private channel on socket.mrkt.ru
 * (laravel-websockets, Pusher protocol); frames are sent by POST /api/editor/remote/send. The phone calls the same
 * handlers as the window (rpc.ts), limited to ALLOWED and to the project folders; chat updates go only for the chats a
 * phone has open. Off by default; the «📱» switch in the top bar cuts it off completely (the socket is closed).
 */

const WS_URL = process.env.MPI_REMOTE_WS || 'wss://socket.mrkt.ru/app/AvhruqKvgjpo6yhc2KHy';

/** What a phone may call. Not here: terminal, sign-ins, keys, settings import/cloud, installs, dialogs, clipboard… */
const ALLOWED = new Set([
  'state:get',
  'fs:list',
  'fs:read',
  'fs:write',
  'fs:exists',
  'fs:stat',
  'fs:resolve',
  'files:search',
  'agents:list',
  'chat:exists',
  'chat:list',
  'chat:open',
  'chat:new',
  'chat:send',
  'chat:interrupt',
  'chat:restart',
  'chat:autoApprove',
  'chat:remote',
  'chat:rewindPreview',
  'chat:rewind',
  'chat:fork',
  'chat:stopTask',
  'chat:mode',
  'chat:options',
  'chat:status',
  'chat:commands',
  'chat:rename',
  'chat:permission',
  'chat:seen',
  'chat:image',
  'chat:busyCount',
  'chat:mcpList',
  'git',
  'usage:get',
  'usage:refresh',
  'problems:list',
  'stats:usage',
  'stats:cron',
  'deploys:list',
  'attach:saveDataUrl',
]);
/** First argument is a path that must be inside a project. */
const PATH_ARG = new Set(['fs:list', 'fs:read', 'fs:write', 'fs:exists', 'fs:stat']);
/** Changes something: written to the audit log. */
const READ_ONLY = /^(state:get|fs:(list|read|exists|stat|resolve)|files:search|agents:list|chat:(exists|list|open|status|commands|busyCount|mcpList|rewindPreview|image|seen)|usage:get|problems:list|stats:|deploys:list)/;
const READ_GIT = new Set(['repoRoot', 'status', 'diff', 'log', 'show', 'branches', 'stashList']);
/** Events a phone gets (chat only for the chats it has open). */
const FORWARD = new Set<MainEvent['type']>(['chat', 'chatMeta', 'problems', 'usage', 'toast', 'sessionsChanged', 'fileChanged']);

const codec: Codec = {
  deflate: async (t) => deflateRawSync(Buffer.from(t, 'utf8')).toString('base64'),
  inflate: async (b) => inflateRawSync(Buffer.from(b, 'base64')).toString('utf8'),
};
const decode = decoder(codec);

interface Phone {
  name: string;
  seen: number;
  subs: Set<string>;
}

let ws: WebSocket | null = null;
let socketId = '';
let channel = '';
let state: RemoteLinkStatus['state'] = 'off';
let error: string | undefined;
let retry: NodeJS.Timeout | null = null;
let backoff = 1000;
let pinger: NodeJS.Timeout | null = null;
const phones = new Map<string, Phone>();

export function status(): RemoteLinkStatus {
  const now = Date.now();
  for (const [id, p] of phones) if (now - p.seen > 3 * 60_000) phones.delete(id);
  return { enabled: !!stateFile.data.remoteAccess, state, error, phones: [...phones.values()].map((p) => ({ name: p.name, seen: p.seen })) };
}
const publish = () => emit({ type: 'remoteLink', status: status() });

export async function setEnabled(on: boolean) {
  stateFile.data.remoteAccess = on;
  stateFile.save();
  if (on) void connect();
  else {
    // phones are told at once (best effort, at most 2 s), then the socket is closed: nothing more is accepted
    if (state === 'online') await Promise.race([send({ k: 'off' }).catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    disconnect('off');
  }
  publish();
}

/** At start: reconnect when the switch was left on. */
export function init() {
  if (stateFile.data.remoteAccess) connect();
  setInterval(publish, 60_000).unref();
}

function disconnect(to: RemoteLinkStatus['state'], err?: string) {
  if (retry) clearTimeout(retry);
  retry = null;
  if (pinger) clearInterval(pinger);
  pinger = null;
  const old = ws;
  ws = null;
  try {
    old?.close();
  } catch {
    /* already closed */
  }
  socketId = '';
  phones.clear();
  state = to;
  error = err;
}

function scheduleRetry(err: string) {
  disconnect('error', err);
  publish();
  if (!stateFile.data.remoteAccess) return;
  retry = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 60_000);
}

async function connect() {
  if (!stateFile.data.remoteAccess) return;
  disconnect('connecting');
  publish();
  try {
    if (!cloud.signedServer()) throw new Error('Войдите в Insider: ☁ Облако → Войти');
    channel = (await cloud.authorizedJson('/api/editor/remote/me')).channel;
    if (!channel) throw new Error('Insider не вернул канал');
  } catch (e: any) {
    return scheduleRetry(e?.message ?? String(e));
  }
  if (!stateFile.data.remoteAccess) return;
  const sock = new WebSocket(`${WS_URL}?protocol=7&client=mpi&version=1.0`);
  ws = sock;
  sock.onmessage = (m) => void onSocket(sock, String(m.data));
  sock.onclose = () => ws === sock && scheduleRetry('Соединение с socket.mrkt.ru закрыто');
  sock.onerror = () => {
    /* onclose follows */
  };
}

async function onSocket(sock: WebSocket, raw: string) {
  if (ws !== sock) return;
  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.event === 'pusher:connection_established') {
    socketId = JSON.parse(m.data).socket_id;
    try {
      const a = await cloud.authorizedJson('/api/editor/remote/auth', { method: 'POST', body: { socket_id: socketId, channel_name: channel } });
      sock.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: a.auth, channel } }));
    } catch (e: any) {
      scheduleRetry(e?.message ?? String(e));
    }
  } else if (m.event === 'pusher_internal:subscription_succeeded') {
    state = 'online';
    error = undefined;
    backoff = 1000;
    if (pinger) clearInterval(pinger);
    pinger = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ event: 'pusher:ping', data: {} })), 25_000);
    void send(hello()).catch(() => {});
    publish();
  } else if (m.event === 'pusher:ping') {
    sock.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
  } else if (m.event === 'pusher:error') {
    const d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data;
    scheduleRetry(`socket.mrkt.ru: ${d?.message ?? 'ошибка'}`);
  } else if (m.event === 'f' && m.channel === channel) {
    const d = (typeof m.data === 'string' ? JSON.parse(m.data) : m.data)?.d;
    if (typeof d !== 'string') return;
    const msg = (await decode(d).catch(() => undefined)) as PhoneMsg | undefined;
    if (msg && typeof msg === 'object' && 'k' in msg) void onPhone(msg);
  }
}

const hello = (to?: string): PcMsg => ({ k: 'pc', to, name: os.hostname(), version: app.getVersion(), at: Date.now() });

async function onPhone(m: PhoneMsg) {
  if (!stateFile.data.remoteAccess || typeof m.from !== 'string') return;
  const p = phones.get(m.from) ?? { name: '', seen: 0, subs: new Set<string>() };
  const isNew = !phones.has(m.from);
  p.seen = Date.now();
  phones.set(m.from, p);
  if (m.k === 'hello') {
    p.name = String(m.name ?? '').slice(0, 60) || 'телефон';
    await send(hello(m.from));
    if (isNew) publish();
  } else if (m.k === 'bye') {
    phones.delete(m.from);
    publish();
  } else if (m.k === 'sub') {
    p.subs = new Set((m.ids ?? []).filter((x) => typeof x === 'string').slice(0, 20));
  } else if (m.k === 'rpc') {
    void send({ k: 'ack', to: m.from, id: m.id }).catch(() => {});
    let res: PcMsg;
    try {
      res = { k: 'res', to: m.from, id: m.id, ok: true, value: await call(m.from, m.ch, Array.isArray(m.args) ? unpackArgs(m.args) : []) };
    } catch (e: any) {
      res = { k: 'res', to: m.from, id: m.id, ok: false, error: e?.message ?? String(e) };
    }
    await send(res);
  }
}

function projectRoots() {
  return stateFile.data.projects.map((p) => path.resolve(p.path).toLowerCase());
}
function inProject(p: unknown) {
  if (typeof p !== 'string' || !p) return false;
  let real = path.resolve(p);
  try {
    real = fs.realpathSync.native(real);
  } catch {
    /* a new file: its folder decides */
    try {
      real = path.join(fs.realpathSync.native(path.dirname(real)), path.basename(real));
    } catch {
      /* keep */
    }
  }
  const r = real.toLowerCase();
  return projectRoots().some((root) => r === root || r.startsWith(root + path.sep));
}

async function call(from: string, ch: string, args: unknown[]) {
  if (!ALLOWED.has(ch)) throw new Error(`С телефона недоступно: ${ch}`);
  if (PATH_ARG.has(ch) && !inProject(args[0])) throw new Error('Путь вне проектов редактора');
  if (ch === 'git' && !inProject(args[1])) throw new Error('Репозиторий вне проектов редактора');
  const fn = handlers.get(ch);
  if (!fn) throw new Error(`Нет обработчика ${ch}`);
  if (!READ_ONLY.test(ch) && !(ch === 'git' && READ_GIT.has(String(args[0])))) audit(from, ch, args);
  const value = await fn(...args);
  if (ch === 'state:get') return safeState(value);
  return value;
}

/** The state without the cloud sign-in details. */
function safeState(s: any) {
  const { cloud: _c, ...rest } = s ?? {};
  return rest;
}

function audit(from: string, ch: string, args: unknown[]) {
  const short = JSON.stringify(args, (_k, v) => (typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v));
  const line = JSON.stringify({ at: new Date().toISOString(), phone: phones.get(from)?.name ?? from, ch, args: short.slice(0, 1000) });
  fs.appendFile(path.join(dataDir(), 'remote-audit.jsonl'), line + '\n', () => {});
}

// --- sending: one request at a time (keeps order); events batched and chat snapshots coalesced ----------------------

let chain: Promise<void> = Promise.resolve();
function send(msg: PcMsg): Promise<void> {
  const p = chain.then(async () => {
    if (!ws || state !== 'online') return;
    for (const d of await encode(msg, codec)) await cloud.authorizedJson('/api/editor/remote/send', { method: 'POST', body: { d, socket_id: socketId } });
  });
  chain = p.catch(() => {});
  return p;
}

const pendingChats = new Map<string, MainEvent>();
let pendingOther: MainEvent[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;

listen((e) => {
  if (state !== 'online' || !phones.size || !FORWARD.has(e.type)) return;
  if (e.type === 'chat') {
    if (![...phones.values()].some((p) => p.subs.has(e.snapshot.sessionId))) return;
    pendingChats.set(e.snapshot.sessionId, e);
  } else pendingOther.push(e);
  if (!flushTimer) flushTimer = setTimeout(flush, 300);
});

async function flush() {
  flushTimer = null;
  if (flushing) {
    flushTimer = setTimeout(flush, 300);
    return;
  }
  const list = [...pendingOther.slice(-50), ...pendingChats.values()];
  pendingOther = [];
  pendingChats.clear();
  if (!list.length) return;
  flushing = true;
  try {
    await send({ k: 'ev', list });
  } catch {
    /* the phone re-opens the chat after a gap */
  } finally {
    flushing = false;
  }
}
