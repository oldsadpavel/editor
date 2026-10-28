import { BrowserWindow, Menu, app, dialog, ipcMain, net, protocol, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AppState, DeployTarget, DirEntry, MainEvent, PermissionAnswer, SendOptions } from '../shared/types';
import { setSink } from './bus';
import * as cache from './cache';
import * as claude from './claude';
import * as cloud from './cloud';
import * as deploy from './deploy';
import * as files from './files';
import * as keys from './keys';
import * as ping from './ping';
import * as problems from './problems';
import { setupStatus } from './setup';
import * as settingsIo from './settings-io';
import * as updates from './updates';
import * as usage from './usage';
import { flushAll, stateFile } from './store';
import { findTranscript, normalize } from './transcript';

const here = path.dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null;

// `efile:///<encoded absolute path>` serves local files (image previews) without base64 round-trips through IPC.
protocol.registerSchemesAsPrivileged([{ scheme: 'efile', privileges: { standard: false, secure: true, supportFetchAPI: true, stream: true } }]);

const watchedRoots = new Set<string>();
function watchRepoOf(p: string) {
  const key = normalize(path.dirname(p));
  if (watchedRoots.has(key)) return;
  watchedRoots.add(key);
  void deploy.watchPath(p);
}

setSink((event: MainEvent) => {
  if (event.type === 'chat') for (const t of event.snapshot.turns) for (const e of t.edits) watchRepoOf(e.path);
  win?.webContents.send('event', event);
});

deploy.setPushAttribution((repo, at) => {
  // The chat that ran `git push` in the last few minutes owns the push.
  let best: { id: string; at: number } | undefined;
  for (const id of claude.runningSessions().concat(stateFile.data.openChats)) {
    const b = claude.getBuilder(id);
    for (const p of b?.pushCommands ?? []) {
      if (at - p.at < 5 * 60_000 && (!best || p.at > best.at)) best = { id, at: p.at };
    }
  }
  void repo;
  return best?.id;
});

// --- file system ---------------------------------------------------------------------------

const HIDDEN = new Set(['.git', '.DS_Store', 'Thumbs.db']);

/** Folder listing with size and mtime so the tree can sort by them; ordering is done by the renderer. */
function listDir(dir: string): DirEntry[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !HIDDEN.has(e.name))
    .map((e) => {
      const p = path.join(dir, e.name);
      let st: fs.Stats | null = null;
      try {
        st = fs.statSync(p);
      } catch {
        /* broken link */
      }
      return { name: e.name, path: p, dir: e.isDirectory(), size: st?.size, mtime: st?.mtimeMs };
    });
}

const fileWatchers = new Map<string, fs.FSWatcher>();
function watchFile(p: string) {
  const key = normalize(p);
  if (fileWatchers.has(key)) return;
  try {
    let t: NodeJS.Timeout | null = null;
    const w = fs.watch(p, () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => win?.webContents.send('event', { type: 'fileChanged', path: p } satisfies MainEvent), 150);
    });
    w.on('error', () => fileWatchers.delete(key));
    fileWatchers.set(key, w);
  } catch {
    /* file may not exist yet */
  }
}
function unwatchFile(p: string) {
  const key = normalize(p);
  fileWatchers.get(key)?.close();
  fileWatchers.delete(key);
}

// --- IPC ----------------------------------------------------------------------------------

function handle(channel: string, fn: (...args: any[]) => any) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
}

handle('state:get', () => stateFile.data);
handle('state:set', (patch: Partial<AppState>) => {
  const before = stateFile.data.projects.map((p) => p.path);
  Object.assign(stateFile.data, patch);
  stateFile.save();
  for (const p of stateFile.data.projects) if (!before.includes(p.path)) void deploy.watchPath(p.path);
  return stateFile.data;
});

handle('fs:list', (dir: string) => listDir(dir));
handle('fs:read', (p: string) => {
  const st = fs.statSync(p);
  if (st.size > 20 * 1024 * 1024) throw new Error('Файл больше 20 МБ');
  const buf = fs.readFileSync(p);
  const binary = buf.subarray(0, 8000).includes(0);
  return { text: binary ? '' : buf.toString('utf8'), binary, mtime: st.mtimeMs, size: st.size };
});
handle('fs:write', (p: string, text: string) => {
  fs.writeFileSync(p, text, 'utf8');
  return fs.statSync(p).mtimeMs;
});
handle('fs:exists', (p: string) => fs.existsSync(p));
handle('fs:watch', (p: string) => watchFile(p));
handle('fs:unwatch', (p: string) => unwatchFile(p));
handle('fs:resolve', (base: string, rel: string) => {
  const candidates = path.isAbsolute(rel) ? [rel] : [path.join(base, rel)];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
});
handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
handle('shell:reveal', (p: string) => shell.showItemInFolder(p));
handle('shell:open', (url: string) => shell.openExternal(url));
handle('shell:openPath', (p: string) => files.openPath(p));

handle('attach:saveBlob', (bytes: Uint8Array, mime: string, name?: string, dir?: string) => files.saveBlob(bytes, mime, name, dir));
handle('attach:saveDataUrl', (url: string) => files.saveDataUrl(url));
handle('clipboard:files', (dir?: string) => files.clipboardFiles(dir));
handle('clipboard:pasteInto', (dir: string) => files.pasteInto(dir));
handle('fs:copyInto', (dir: string, paths: string[]) => files.copyInto(dir, paths));
handle('fs:stat', (p: string) => {
  const st = fs.statSync(p);
  return { size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() };
});
handle('image:edit', (p: string) => files.editImage(p));
handle('image:copy', (p: string) => files.copyImage(p));
handle('chat:image', (id: string, uuid: string, index: number) => files.transcriptImage(id, uuid, index));

handle('auth:status', () => claude.authStatus());
handle('auth:login', (method?: 'claudeai' | 'console' | 'sso', email?: string) => claude.login(method, email));
handle('auth:logout', () => claude.logout());

handle('chat:list', (cwd: string) => claude.listProjectSessions(cwd));
handle('chat:open', (id: string, cwd?: string) => claude.openChat(id, cwd));
handle('chat:new', (cwd: string) => claude.newChat(cwd));
handle('chat:send', (id: string, text: string, opts?: SendOptions) => claude.send(id, text, opts ?? {}));
handle('chat:interrupt', (id: string) => claude.interrupt(id));
handle('chat:autoApprove', (id: string, on: boolean) => claude.setAutoApprove(id, on));
handle('chat:remote', (id: string, on: boolean) => claude.setRemote(id, on));
handle('chat:status', (id: string) => claude.chatStatus(id));
handle('chat:commands', (id: string) => claude.chatCommands(id));
handle('chat:rename', (id: string, title: string) => claude.rename(id, title));
handle('chat:close', (id: string) => claude.closeChat(id));
handle('chat:permission', (id: string, reqId: string, a: PermissionAnswer) => claude.answerPermission(id, reqId, a));
handle('chat:seen', (id: string) => {
  const meta = (stateFile.data.chatMeta[id] ??= {});
  meta.seenAt = Date.now();
  stateFile.save();
  return meta;
});
handle('chat:exists', (id: string) => !!findTranscript(id));

handle('problems:list', () => problems.list());
handle('problems:ack', (id?: string) => problems.acknowledge(id));
handle('problems:remove', (id?: string) => problems.remove(id));

handle('deploys:list', () => deploy.listDeploys());
handle('deploys:repos', () => deploy.watchedRepos());
handle('deploys:setTarget', async (repo: string, t: DeployTarget | null) => {
  // A project folder may be a subfolder of the repository; targets are keyed by the git root.
  const root = (await deploy.gitRoot(repo)) ?? repo;
  deploy.setTarget(root, t);
  await deploy.watchPath(root);
  return root;
});
handle('settings:export', () => settingsIo.exportSettings(win));
handle('cloud:status', () => cloud.status());
handle('cloud:login', (server: string) => cloud.login(server));
handle('cloud:logout', () => cloud.logout());
handle('cloud:options', (o: { server?: string; auto?: boolean }) => cloud.setOptions(o));
handle('cloud:upload', () => cloud.upload());
handle('cloud:versions', () => cloud.versions());
handle('cloud:delete', (id: number | string) => cloud.deleteVersion(id));
handle('cloud:download', async (id?: number | string) => {
  const r = await cloud.download(id);
  // Projects, groups and layout change at once: simplest is a fresh UI on the new state.
  setTimeout(() => win?.webContents.reload(), 300);
  return r;
});
handle('settings:import', async () => {
  const file = await settingsIo.importSettings(win);
  // Projects, groups and layout change at once: simplest is a fresh UI on the new state.
  if (file) setTimeout(() => win?.webContents.reload(), 300);
  return file;
});
handle('deploys:probe', (repo: string) => deploy.probeTarget(repo));
handle('tests:run', (repo: string) => deploy.runTests(repo));
handle('tests:list', () => deploy.listTests());

handle('ping:list', () => ping.list());
handle('ping:now', (project?: string) => ping.pingNow(project));
handle('app:pendingUpdate', () => updates.pendingUpdate());
handle('app:restartToUpdate', () => updates.restartToUpdate());
handle('chat:busyCount', () => claude.runningSessions().length);
handle('usage:get', () => usage.lastUsage());
handle('usage:refresh', () => usage.refreshUsage());
handle('setup:status', () => setupStatus());
handle('cache:scan', () => cache.scanCache());
handle('cache:last', () => cache.lastCache());
handle('cache:clean', (id: string) => cache.cleanCategory(id));
handle('cache:delete', (p: string) => cache.deleteItem(p));

handle('keys:scan', () => keys.scanKeys());
handle('keys:last', () => keys.lastScan());
handle('keys:setPatterns', (p: string[]) => keys.setPatterns(p));

// --- window -------------------------------------------------------------------------------

function createWindow() {
  const saved = stateFile.data.window;
  win = new BrowserWindow({
    width: saved?.width ?? 1600,
    height: saved?.height ?? 1000,
    ...(saved?.x !== undefined && saved?.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1f22',
    title: 'Claude Editor',
    webPreferences: {
      preload: path.join(here, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(here, '../renderer/index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win?.webContents.toggleDevTools();
  });
  if (saved?.maximized) win.maximize();
  // Window size and position survive restarts.
  win.on('close', () => {
    if (!win) return;
    const b = win.getNormalBounds();
    stateFile.data.window = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
    stateFile.save();
  });
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  protocol.handle('efile', (req) => {
    const p = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''));
    return net.fetch(pathToFileURL(p).toString());
  });
  createWindow();
  for (const p of stateFile.data.projects) void deploy.watchPath(p.path);
  deploy.startDeployWatcher();
  ping.startPing();
  usage.startUsage();
  cloud.startAutoSync();
  updates.startUpdateWatch();
  setTimeout(() => void keys.scanKeys(), 3000);
  setInterval(() => void keys.scanKeys(), 60 * 60_000);
  setTimeout(() => void cache.scanCache(), 8000);
  setInterval(() => void cache.scanCache(), 6 * 60 * 60_000);
});

app.on('window-all-closed', () => {
  claude.shutdown();
  deploy.stopDeployWatcher();
  ping.stopPing();
  usage.stopUsage();
  flushAll();
  app.quit();
});
