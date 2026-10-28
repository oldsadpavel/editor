import { BrowserWindow, dialog } from 'electron';
import fs from 'node:fs';
import type { AppState } from '../shared/types';
import { emit } from './bus';
import { withGitOrigins } from './git-info';
import { stateFile } from './store';

/** Format marker of an exported settings file. */
const KIND = 'claude-editor-settings';

/**
 * Settings that move between machines. Secrets (GitHub token) and per-machine data (window position, drafts,
 * unread marks, one-time repairs) stay local.
 */
export function exportable(): Partial<AppState> {
  const { githubToken: _t, window: _w, drafts: _d, chatMeta: _m, repairs: _r, cloud: _c, ...rest } = stateFile.data;
  return rest;
}

export async function exportSettings(win: BrowserWindow | null): Promise<string | null> {
  const r = await dialog.showSaveDialog(win!, {
    title: 'Экспорт настроек Claude Editor',
    defaultPath: `claude-editor-settings-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify({ kind: KIND, version: 1, exportedAt: new Date().toISOString(), settings: withGitOrigins(exportable()) }, null, 2));
  return r.filePath;
}

/** Applies exported settings (replacing the exportable part); local-only data is kept. */
export function applySettings(settings: Partial<AppState>) {
  const keep = { cloud: stateFile.data.cloud, githubToken: stateFile.data.githubToken, window: stateFile.data.window, drafts: stateFile.data.drafts, chatMeta: stateFile.data.chatMeta, repairs: stateFile.data.repairs };
  stateFile.data = { ...stateFile.data, ...settings, ...keep, ui: { ...stateFile.data.ui, ...(settings.ui ?? {}) } } as AppState;
  stateFile.save();
  emit({ type: 'appState', state: stateFile.data });
}

export async function importSettings(win: BrowserWindow | null): Promise<string | null> {
  const r = await dialog.showOpenDialog(win!, { title: 'Импорт настроек Claude Editor', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
  if (data?.kind !== KIND || typeof data.settings !== 'object') throw new Error('Это не файл настроек Claude Editor');
  applySettings(data.settings);
  return r.filePaths[0];
}
