import { useRef, useSyncExternalStore } from 'react';
import type {
  AppState,
  AuthStatus,
  CacheReport,
  ChatMeta,
  ChatSnapshot,
  ColumnId,
  DeployEvent,
  Layout,
  MainBlock,
  SendOptions,
  KeyScanResult,
  MainEvent,
  PanelId,
  Problem,
  SessionInfo,
  SetupItem,
  PingResult,
  ProjectGroup,
  TestResult,
  UsageInfo,
} from '../shared/types';
import { bridge, call } from './api';
import { isImage } from './clipboard';

export interface OpenFile {
  path: string;
  text: string;
  savedText: string;
  mtime: number;
  binary: boolean;
  /** 'image' files are shown in the image viewer instead of the code editor. */
  kind?: 'text' | 'image';
  /** Changed on disk (by Claude or another program) and not looked at since. */
  unseen?: boolean;
  /** When the file last changed on disk while open (for «recently edited first»). */
  changedAt?: number;
  size?: number;
  changedOnDisk?: boolean;
  /** Bumped when the content is replaced from disk so the editor reloads its document. */
  version: number;
}

export interface Draft {
  text: string;
  attachments: string[];
}

export interface LightboxItem {
  /** URL to show (efile:// or data:). */
  src: string;
  /** File on disk, if any (needed for Paint / reveal). */
  path?: string;
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
  lightbox?: { items: LightboxItem[]; index: number };
  usage: UsageInfo | null;
  /** Selected tree node (target folder for Ctrl+V). */
  treeSelected?: string;
  /** Unsent text and attachments per chat. */
  drafts: Record<string, Draft>;
  /** A newer build is installed (path of its exe): offer a restart. */
  update?: string;
  /** Chat whose /status (or /context) card is shown. */
  statusFor?: { sessionId: string; section?: 'context' };
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
  usage: null,
  drafts: {},
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

/** Tool blocks that live at the bottom or in the right dock. */
export const TOOL_PANELS: PanelId[] = ['setup', 'problems', 'ping', 'deploys', 'tests', 'keys', 'cache'];

export function togglePanel(id: PanelId, value?: boolean) {
  const ui = state.app!.ui;
  const on = value ?? !ui.visible[id];
  const visible = { ...ui.visible, [id]: on };
  // The right dock is narrow: opening a tool block there closes the others.
  if (on && ui.toolDock === 'right' && TOOL_PANELS.includes(id)) for (const t of TOOL_PANELS) if (t !== id) visible[t] = false;
  setUi({ visible });
}

/** Moves all tool blocks to the bottom of the center column or to a narrow column on the right. */
export function setToolDock(dock: 'bottom' | 'right') {
  const ui = state.app!.ui;
  const visible = { ...ui.visible };
  if (dock === 'right') {
    // Keep just one open (the first visible), the dock shows one at a time.
    const first = TOOL_PANELS.find((t) => visible[t]);
    for (const t of TOOL_PANELS) visible[t] = t === first;
  }
  setUi({ toolDock: dock, visible, bottomMax: false });
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

// --- project groups -----------------------------------------------------------------------

/** The active group's record, refreshed from the live top-level fields. */
function snapshotGroup(): ProjectGroup[] {
  const a = state.app!;
  return (a.groups ?? []).map((g) =>
    g.id === a.activeGroup
      ? { ...g, projects: a.projects, favorites: a.favorites, openChats: a.openChats, activeChat: a.activeChat, chatProject: a.chatProject, openFiles: state.files.map((f) => f.path), activeFile: state.activeFile, treeOpen: a.ui.treeOpen }
      : g,
  );
}

/** Activates a group: its projects, favorites, chats and files replace the current ones (which are saved into their group). */
export async function switchGroup(id: string) {
  const a = state.app!;
  if (id === a.activeGroup) return;
  const groups = snapshotGroup();
  const g = groups.find((x) => x.id === id);
  if (!g) return;
  for (const c of a.openChats) if (!g.openChats.includes(c)) void call('chat:close', c);
  for (const f of state.files) if (!(g.openFiles ?? []).includes(f.path)) void call('fs:unwatch', f.path);
  set({ files: [], activeFile: undefined, treeSelected: undefined });
  await saveApp({
    groups,
    activeGroup: id,
    projects: g.projects,
    favorites: g.favorites,
    openChats: g.openChats,
    activeChat: g.activeChat,
    chatProject: g.chatProject ?? g.projects[0]?.path,
    openFiles: g.openFiles ?? [],
    activeFile: g.activeFile,
    ui: { ...a.ui, treeOpen: g.treeOpen ?? [] },
  });
  for (const c of g.openChats) {
    if (!state.chats[c]) {
      const snap = await call<ChatSnapshot>('chat:open', c).catch(() => null);
      if (snap) set((s) => ({ chats: { ...s.chats, [c]: snap } }));
    }
  }
  for (const p of g.openFiles ?? []) if (await call<boolean>('fs:exists', p).catch(() => false)) await openFile(p);
  if (g.activeFile && state.files.some((f) => f.path === g.activeFile)) set({ activeFile: g.activeFile });
  for (const p of g.projects) void loadSessions(p.path);
  toast(`Группа «${g.name}»`);
}

export async function createGroup(name: string) {
  name = name.trim();
  if (!name) return;
  const id = crypto.randomUUID();
  const groups = [...snapshotGroup(), { id, name, projects: [], favorites: [], openChats: [] }];
  await saveApp({ groups });
  await switchGroup(id);
}

export async function renameGroup(id: string, name: string) {
  name = name.trim();
  if (!name) return;
  await saveApp({ groups: snapshotGroup().map((g) => (g.id === id ? { ...g, name } : g)) });
}

export async function deleteGroup(id: string) {
  const groups = snapshotGroup();
  if (groups.length <= 1) return toast('Последнюю группу удалить нельзя', 'error');
  const rest = groups.filter((g) => g.id !== id);
  if (id === state.app!.activeGroup) {
    await saveApp({ groups });
    await switchGroup(rest[0].id);
  }
  await saveApp({ groups: rest });
}

// --- files --------------------------------------------------------------------------------

/** Formats that are never text: opened straight in the system program. */
const SYSTEM_EXT = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|rtf|zip|rar|7z|gz|tar|exe|msi|dll|mp4|mov|avi|mkv|webm|mp3|wav|ogg|flac|psd|ai|ttf|otf|woff2?)$/i;

export async function openInSystem(path: string) {
  if (await guard(call('shell:openPath', path)) !== undefined) toast(`Открыто в системной программе: ${path.split(/[\\/]/).pop()}`);
}

/**
 * Opens a file: text → code editor tab, image → image viewer tab, anything else binary → the system program
 * (no tab, the editor can't show it anyway).
 */
export async function openFile(path: string, line?: number) {
  const existing = state.files.find((f) => f.path.toLowerCase() === path.toLowerCase());
  if (!existing) {
    if (isImage(path)) {
      const st = await guard(call<{ size: number; mtime: number }>('fs:stat', path));
      if (!st) return;
      void call('fs:watch', path);
      set((s) => ({ files: [...s.files, { path, text: '', savedText: '', mtime: st.mtime, size: st.size, binary: true, kind: 'image', version: 1 }] }));
    } else {
      if (SYSTEM_EXT.test(path)) return openInSystem(path);
      const r = await call<{ text: string; binary: boolean; mtime: number; size: number }>('fs:read', path).catch(() => null);
      if (!r || r.binary) return openInSystem(path);
      void call('fs:watch', path);
      set((s) => ({ files: [...s.files, { path, text: r.text, savedText: r.text, mtime: r.mtime, size: r.size, binary: false, kind: 'text', version: 1 }] }));
    }
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
  if (f.kind === 'image') {
    // Saved in Paint (or by Claude): bump the version so the viewer reloads the picture.
    const st = await call<{ size: number; mtime: number }>('fs:stat', f.path).catch(() => null);
    set((s) => ({ files: s.files.map((x) => (x === f ? { ...x, version: x.version + 1, size: st?.size ?? x.size, mtime: st?.mtime ?? x.mtime } : x)) }));
    markChanged(f.path);
    return;
  }
  const r = await call<{ text: string; mtime: number }>('fs:read', f.path).catch(() => null);
  if (!r || r.text === f.savedText) return;
  if (f.text === f.savedText) await reloadFile(f.path);
  else set((s) => ({ files: s.files.map((x) => (x.path === f.path ? { ...x, changedOnDisk: true } : x)) }));
  markChanged(f.path);
}

/** A change nobody looked at yet: highlighted until the tab is shown (the active tab in a focused window counts as seen). */
function markChanged(path: string) {
  const seen = state.activeFile === path && document.hasFocus();
  set((s) => ({ files: s.files.map((x) => (x.path === path ? { ...x, changedAt: Date.now(), unseen: !seen } : x)) }));
}

/** Showing a file clears its «changed, not seen» mark. */
listeners.add(() => {
  const f = state.activeFile && state.files.find((x) => x.path === state.activeFile && x.unseen);
  if (f && document.hasFocus()) set((s) => ({ files: s.files.map((x) => (x === f ? { ...x, unseen: false } : x)) }));
});
window.addEventListener('focus', () => {
  const f = state.activeFile && state.files.find((x) => x.path === state.activeFile && x.unseen);
  if (f) set((s) => ({ files: s.files.map((x) => (x === f ? { ...x, unseen: false } : x)) }));
});

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
  // Always re-read: the title or history may have changed while the tab was closed.
  const wasOpen = state.app!.openChats.includes(id);
  if (!wasOpen || !state.chats[id]) {
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
  return snap.sessionId;
}

/** The task Claude gets for wiring up an automatic deploy check (version marker on the site). */
function autoDeployPrompt(site: string) {
  const base = site.replace(/\/+$/, '');
  return [
    `Настрой автоматическую проверку деплоя этого проекта. Продакшен-сайт: ${base}`,
    '',
    'Цель: после каждого git push редактор должен сам понять, что на сайте уже работает новый коммит.',
    'Для этого сайт должен отдавать хэш коммита, из которого он собран (маркер версии).',
    '',
    '1. Разберись, на чём проект и как он деплоится (CI, Coolify, Docker, nginx, хостинг…).',
    `2. Сделай так, чтобы по адресу ${base}/version.json отдавался JSON {"commit":"<полный sha>","builtAt":"<ISO-время>"}.`,
    '   Хэш должен попадать на этапе сборки или деплоя (git rev-parse HEAD в CI, build-arg Docker, файл, который пишет скрипт деплоя),',
    '   а не вычисляться на сервере из папки, где может не быть .git. Если /version.json невозможен (например, роутинг SPA) — выбери',
    '   другой адрес или метатег на главной и объясни почему.',
    '3. Привяжи адрес: mcp__editor__set_deploy_target(url=<адрес маркера>, mode="sha").',
    `4. Добавь smoke-тест главной страницы: mcp__editor__add_smoke_test(name="Главная", url="${base}/", expectStatus=200).`,
    '5. Закоммить и запушь. Затем проверяй mcp__editor__check_deploy_target, пока адрес не отдаст новый хэш (деплой виден и во вкладке',
    '   «Деплои» редактора), и коротко сообщи результат.',
    '6. Если нужно моё действие (секреты, доступ к серверу, переменные в панели хостинга) — сообщи через mcp__editor__report_problem и опиши шаги.',
  ].join('\n');
}

/** Opens a new chat in the project and hands Claude the deploy-check setup task. */
export async function startAutoDeploySetup(project: string, site: string) {
  if (!state.app!.ui.visible.chat) togglePanel('chat', true);
  await saveApp({ chatProject: project });
  const id = await newChat(project);
  if (!id) return;
  await renameChat(id, 'Автонастройка проверки деплоя');
  await sendPrompt(id, autoDeployPrompt(site), {});
  toast('Claude настраивает проверку деплоя — смотрите новый чат');
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

/** Sends a prompt; false (with an error toast) when it could not be sent, so the composer can keep the text. */
export async function sendPrompt(id: string, text: string, opts: SendOptions) {
  try {
    await call('chat:send', id, text, opts);
    return true;
  } catch (e: any) {
    toast(e.message ?? String(e), 'error');
    return false;
  }
}

export function setAutoApprove(id: string, on: boolean) {
  set((s) => (s.chats[id] ? { chats: { ...s.chats, [id]: { ...s.chats[id], autoApprove: on } } } : {}));
  void guard(call('chat:autoApprove', id, on));
}

export async function setRemote(id: string, on: boolean) {
  const ok = (await guard(call('chat:remote', id, on))) !== undefined;
  if (ok && on) toast('/RC: подключаюсь к claude.ai — через несколько секунд чат появится на claude.ai/code и в приложении Claude');
}

// --- drafts -------------------------------------------------------------------------------

const EMPTY_DRAFT: Draft = { text: '', attachments: [] };

/** Draft saved by a previous run (kept in the editor's state file, so it survives restarts). */
export function loadDraft(id: string): Draft {
  return state.app?.drafts?.[id] ?? EMPTY_DRAFT;
}

let draftTimer: ReturnType<typeof setTimeout> | null = null;
export function updateDraft(id: string, fn: (d: Draft) => Draft) {
  const next = fn(state.drafts[id] ?? loadDraft(id));
  set((s) => ({ drafts: { ...s.drafts, [id]: next } }));
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const drafts = { ...state.app?.drafts, ...state.drafts };
    for (const [k, d] of Object.entries(drafts)) if (!d.text && !d.attachments.length) delete drafts[k];
    set((s) => ({ app: s.app && { ...s.app, drafts } }));
    void call('state:set', { drafts }).catch(() => {});
  }, 400);
}

// --- session restore ----------------------------------------------------------------------

let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** Open files and the active tab are saved (debounced) so they come back after a restart. */
function persistOpenFiles() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const patch = { openFiles: state.files.map((f) => f.path), activeFile: state.activeFile };
    set((s) => ({ app: s.app && { ...s.app, ...patch } }));
    void call('state:set', patch).catch(() => {});
  }, 500);
}

let lastFiles: string | undefined;
listeners.add(() => {
  const key = state.files.map((f) => f.path).join('|') + '#' + (state.activeFile ?? '');
  if (state.app && key !== lastFiles) {
    if (lastFiles !== undefined) persistOpenFiles();
    lastFiles = key;
  }
});

/** Expanded/collapsed folder in the project tree, remembered across restarts. */
export function setTreeOpen(path: string, open: boolean) {
  const key = path.toLowerCase();
  const list = state.app!.ui.treeOpen ?? [];
  if (open === list.includes(key)) return;
  setUi({ treeOpen: open ? [...list, key] : list.filter((p) => p !== key) });
}

// --- layout -------------------------------------------------------------------------------

export const LAYOUT_PRESETS: { id: string; label: string; layout: Layout }[] = [
  { id: 'code', label: 'Код в центре', layout: { left: 'tree', center: 'editor', right: 'chat' } },
  { id: 'chat', label: 'Чат в центре', layout: { left: 'tree', center: 'chat', right: 'editor' } },
  { id: 'chat-left', label: 'Чат слева', layout: { left: 'chat', center: 'editor', right: 'tree' } },
];

/** Puts `block` into `column`; whatever stood there takes the block's old place. */
export function moveBlock(block: MainBlock, column: ColumnId) {
  const layout = { ...state.app!.ui.layout };
  const from = (Object.keys(layout) as ColumnId[]).find((c) => layout[c] === block)!;
  if (from === column) return;
  [layout[from], layout[column]] = [layout[column], block];
  setUi({ layout });
}

// --- image viewer -------------------------------------------------------------------------

export function openLightbox(items: LightboxItem[], index = 0) {
  if (items.length) set({ lightbox: { items, index } });
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
    case 'usage':
      set({ usage: e.usage });
      return;
    case 'update':
      set({ update: e.exe });
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
  set({ problems, deploys, tests, keys, cache, ping: await call<PingResult[]>('ping:list'), usage: await call<UsageInfo | null>('usage:get') });
  for (const id of app.openChats) {
    const snap = await call<ChatSnapshot>('chat:open', id).catch(() => null);
    if (snap) set((s) => ({ chats: { ...s.chats, [id]: snap } }));
  }
  // Editor tabs from the last run (files that no longer exist are skipped silently).
  for (const p of app.openFiles ?? []) {
    if (await call<boolean>('fs:exists', p).catch(() => false)) await openFile(p);
  }
  if (app.activeFile && state.files.some((f) => f.path === app.activeFile)) set({ activeFile: app.activeFile });
  for (const p of app.projects) void loadSessions(p.path);
  call<AuthStatus>('auth:status').then((auth) => set({ auth }));
  refreshSetup();
  call<string | null>('app:pendingUpdate').then((u) => u && set({ update: u }));
  window.addEventListener('focus', () => {
    const id = state.app?.activeChat;
    if (id && chatIsVisible(id)) markSeen(id);
  });
}
