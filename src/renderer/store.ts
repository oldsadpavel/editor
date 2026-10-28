import { useRef, useSyncExternalStore } from 'react';
import type {
  AppState,
  AuthStatus,
  CacheReport,
  ChatMeta,
  ChatSnapshot,
  DeployEvent,
  KeyScanResult,
  MainEvent,
  PanelId,
  Problem,
  SessionInfo,
  SetupItem,
  PingResult,
  TestResult,
} from '../shared/types';
import { bridge, call } from './api';

export interface OpenFile {
  path: string;
  text: string;
  savedText: string;
  mtime: number;
  binary: boolean;
  changedOnDisk?: boolean;
  /** Bumped when the content is replaced from disk so the editor reloads its document. */
  version: number;
}

export interface Store {
  app: AppState | null;
  auth: AuthStatus | null;
  files: OpenFile[];
  activeFile?: string;
  reveal?: { path: string; line?: number; nonce: number };
  chats: Record<string, ChatSnapshot>;
  sessions: Record<string, SessionInfo[]>;
  problems: Problem[];
  deploys: DeployEvent[];
  tests: TestResult[];
  keys: KeyScanResult | null;
  cache: CacheReport | null;
  setup: SetupItem[];
  ping: PingResult[];
  /** Project whose settings dialog is open. */
  projectSettings?: string;
  /** Turn to scroll to inside a chat (from the Files tab or a problem link). */
  focusTurn?: { sessionId: string; turnId: string; nonce: number };
  help?: string;
  toast?: { text: string; kind: 'info' | 'error'; nonce: number };
}

let state: Store = {
  app: null,
  auth: null,
  files: [],
  chats: {},
  sessions: {},
  problems: [],
  deploys: [],
  tests: [],
  keys: null,
  cache: null,
  setup: [],
  ping: [],
};

const listeners = new Set<() => void>();
export function set(patch: Partial<Store> | ((s: Store) => Partial<Store>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  for (const l of listeners) l();
}
export const get = () => state;
function shallowEqual(a: unknown, b: unknown) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  return false;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Selector hook. Results are cached per store version, and equal arrays keep their identity, so selectors may filter/map. */
export function useStore<T>(sel: (s: Store) => T): T {
  const cache = useRef<{ s: Store; v: T } | null>(null);
  return useSyncExternalStore(subscribe, () => {
    const c = cache.current;
    if (c && c.s === state) return c.v;
    const v = sel(state);
    cache.current = { s: state, v: c && shallowEqual(c.v, v) ? c.v : v };
    return cache.current.v;
  });
}

export function toast(text: string, kind: 'info' | 'error' = 'info') {
  set({ toast: { text, kind, nonce: Date.now() } });
}

async function guard<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e: any) {
    toast(e.message ?? String(e), 'error');
    return undefined;
  }
}

// --- app state ----------------------------------------------------------------------------

export async function saveApp(patch: Partial<AppState>) {
  const app = { ...state.app!, ...patch };
  set({ app });
  await guard(call('state:set', patch));
  if (!('ui' in patch && Object.keys(patch).length === 1)) refreshSetup();
}

let setupTimer: ReturnType<typeof setTimeout> | null = null;
/** Recomputes the setup checklist (debounced): called after settings change and on relevant events. */
export function refreshSetup() {
  if (setupTimer) clearTimeout(setupTimer);
  setupTimer = setTimeout(async () => {
    const setup = await call<SetupItem[]>('setup:status').catch(() => null);
    if (setup) set({ setup });
  }, 400);
}

export function setUi(patch: Partial<AppState['ui']>) {
  void saveApp({ ui: { ...state.app!.ui, ...patch } });
}

export function togglePanel(id: PanelId, value?: boolean) {
  const visible = { ...state.app!.ui.visible, [id]: value ?? !state.app!.ui.visible[id] };
  setUi({ visible });
}

export async function addProjects() {
  const dirs: string[] = (await guard(call('dialog:folder'))) ?? [];
  const projects = [...state.app!.projects];
  for (const d of dirs) {
    if (!projects.some((p) => p.path.toLowerCase() === d.toLowerCase())) projects.push({ path: d, name: d.split(/[\\/]/).pop() || d });
  }
  await saveApp({ projects, chatProject: state.app!.chatProject ?? projects[0]?.path });
}

export function toggleFavorite(path: string) {
  const fav = state.app!.favorites;
  void saveApp({ favorites: fav.includes(path) ? fav.filter((f) => f !== path) : [...fav, path] });
}

// --- files --------------------------------------------------------------------------------

export async function openFile(path: string, line?: number) {
  const existing = state.files.find((f) => f.path.toLowerCase() === path.toLowerCase());
  if (!existing) {
    const r = await guard(call<{ text: string; binary: boolean; mtime: number }>('fs:read', path));
    if (!r) return;
    void call('fs:watch', path);
    set((s) => ({ files: [...s.files, { path, text: r.text, savedText: r.text, mtime: r.mtime, binary: r.binary, version: 1 }] }));
  }
  const p = existing?.path ?? path;
  set({ activeFile: p, reveal: line ? { path: p, line, nonce: Date.now() } : state.reveal });
}

export function closeFile(path: string) {
  const f = state.files.find((x) => x.path === path);
  if (f && f.text !== f.savedText && !confirm(`Закрыть «${path.split(/[\\/]/).pop()}» без сохранения?`)) return;
  void call('fs:unwatch', path);
  set((s) => {
    const idx = s.files.findIndex((x) => x.path === path);
    const files = s.files.filter((x) => x.path !== path);
    const activeFile = s.activeFile === path ? files[Math.min(idx, files.length - 1)]?.path : s.activeFile;
    return { files, activeFile };
  });
}

export function editFile(path: string, text: string) {
  set((s) => ({ files: s.files.map((f) => (f.path === path ? { ...f, text } : f)) }));
}

export async function saveFile(path: string) {
  const f = state.files.find((x) => x.path === path);
  if (!f) return;
  const mtime = await guard(call<number>('fs:write', path, f.text));
  if (mtime === undefined) return;
  set((s) => ({ files: s.files.map((x) => (x.path === path ? { ...x, savedText: f.text, mtime, changedOnDisk: false } : x)) }));
}

export async function reloadFile(path: string) {
  const r = await guard(call<{ text: string; mtime: number; binary: boolean }>('fs:read', path));
  if (!r) return;
  set((s) => ({
    files: s.files.map((x) =>
      x.path === path ? { ...x, text: r.text, savedText: r.text, mtime: r.mtime, binary: r.binary, changedOnDisk: false, version: x.version + 1 } : x,
    ),
  }));
}

async function onFileChanged(path: string) {
  const f = state.files.find((x) => x.path.toLowerCase() === path.toLowerCase());
  if (!f) return;
  const r = await call<{ text: string; mtime: number }>('fs:read', f.path).catch(() => null);
  if (!r || r.text === f.savedText) return;
  if (f.text === f.savedText) await reloadFile(f.path);
  else set((s) => ({ files: s.files.map((x) => (x.path === f.path ? { ...x, changedOnDisk: true } : x)) }));
}

// --- chats --------------------------------------------------------------------------------

export const chatMeta = (id: string): ChatMeta => state.app?.chatMeta[id] ?? {};

export function isUnread(id: string, s: Store = state) {
  const m = s.app?.chatMeta[id];
  return !!m?.completedAt && (!m.seenAt || m.completedAt > m.seenAt);
}

export async function loadSessions(cwd: string) {
  const list = await guard(call<SessionInfo[]>('chat:list', cwd));
  if (list) set((s) => ({ sessions: { ...s.sessions, [cwd]: list } }));
}

export async function openChat(id: string, cwd?: string) {
  if (!state.chats[id]) {
    const snap = await guard(call<ChatSnapshot>('chat:open', id, cwd));
    if (!snap) return;
    set((s) => ({ chats: { ...s.chats, [id]: snap } }));
  }
  const openChats = state.app!.openChats.includes(id) ? state.app!.openChats : [...state.app!.openChats, id];
  await saveApp({ openChats, activeChat: id });
  if (!state.app!.ui.visible.chat) togglePanel('chat', true);
  markSeen(id);
}

export async function newChat(cwd: string) {
  const snap = await guard(call<ChatSnapshot>('chat:new', cwd));
  if (!snap) return;
  set((s) => ({ chats: { ...s.chats, [snap.sessionId]: snap } }));
  await saveApp({ openChats: [...state.app!.openChats, snap.sessionId], activeChat: snap.sessionId });
}

export async function closeChat(id: string) {
  const openChats = state.app!.openChats.filter((x) => x !== id);
  const activeChat = state.app!.activeChat === id ? openChats[openChats.length - 1] : state.app!.activeChat;
  await saveApp({ openChats, activeChat });
  void call('chat:close', id);
}

export function markSeen(id: string) {
  if (!isUnread(id)) return;
  const meta = { ...chatMeta(id), seenAt: Date.now() };
  set((s) => ({ app: { ...s.app!, chatMeta: { ...s.app!.chatMeta, [id]: meta } } }));
  void call('chat:seen', id);
}

export async function renameChat(id: string, title: string) {
  title = title.trim();
  if (!title) return;
  set((s) => ({
    chats: s.chats[id] ? { ...s.chats, [id]: { ...s.chats[id], title } } : s.chats,
    sessions: Object.fromEntries(Object.entries(s.sessions).map(([k, v]) => [k, v.map((x) => (x.sessionId === id ? { ...x, title } : x))])),
  }));
  await guard(call('chat:rename', id, title));
}

export async function sendPrompt(id: string, text: string, mode?: string) {
  await guard(call('chat:send', id, text, mode));
}

/** A chat counts as "being read" only when its tab is active, the panel is open and the window has focus. */
export function chatIsVisible(id: string) {
  return state.app?.activeChat === id && state.app.ui.visible.chat && document.hasFocus();
}

// --- events -------------------------------------------------------------------------------

function onEvent(e: MainEvent) {
  switch (e.type) {
    case 'chat':
      set((s) => ({ chats: { ...s.chats, [e.snapshot.sessionId]: e.snapshot } }));
      return;
    case 'chatMeta':
      set((s) => ({ app: s.app && { ...s.app, chatMeta: { ...s.app.chatMeta, [e.sessionId]: e.meta } } }));
      if (chatIsVisible(e.sessionId)) markSeen(e.sessionId);
      else notifyDone(e.sessionId);
      return;
    case 'sessionsChanged':
      void loadSessions(e.cwd);
      return;
    case 'problems':
      set({ problems: e.problems });
      return;
    case 'deploys':
      set({ deploys: e.deploys });
      refreshSetup();
      return;
    case 'tests':
      set({ tests: e.results });
      return;
    case 'keys':
      set({ keys: e.result });
      refreshSetup();
      return;
    case 'ping':
      set({ ping: e.results });
      return;
    case 'appState':
      set((s) => ({ app: { ...e.state, ui: s.app?.ui ?? e.state.ui } }));
      refreshSetup();
      return;
    case 'cache':
      set({ cache: e.report });
      refreshSetup();
      return;
    case 'fileChanged':
      void onFileChanged(e.path);
      return;
    case 'openFile':
      void openFile(e.path, e.line);
      return;
  }
}

function notifyDone(id: string) {
  const chat = state.chats[id];
  if (!chat || !('Notification' in window)) return;
  const n = new Notification(chat.status === 'error' ? 'Чат завершился с ошибкой' : 'Claude закончил', { body: chat.title, silent: false });
  n.onclick = () => void openChat(id);
}

export async function init() {
  bridge.on(onEvent);
  const app = await call<AppState>('state:get');
  set({ app });
  const [problems, deploys, tests, keys, cache] = await Promise.all([
    call<Problem[]>('problems:list'),
    call<DeployEvent[]>('deploys:list'),
    call<TestResult[]>('tests:list'),
    call<KeyScanResult | null>('keys:last'),
    call<CacheReport | null>('cache:last'),
  ]);
  set({ problems, deploys, tests, keys, cache, ping: await call<PingResult[]>('ping:list') });
  for (const id of app.openChats) {
    const snap = await call<ChatSnapshot>('chat:open', id).catch(() => null);
    if (snap) set((s) => ({ chats: { ...s.chats, [id]: snap } }));
  }
  for (const p of app.projects) void loadSessions(p.path);
  call<AuthStatus>('auth:status').then((auth) => set({ auth }));
  refreshSetup();
  window.addEventListener('focus', () => {
    const id = state.app?.activeChat;
    if (id && chatIsVisible(id)) markSeen(id);
  });
}
