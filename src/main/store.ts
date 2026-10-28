import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppState, DeployEvent, Problem, TestResult } from '../shared/types';

export const DEFAULT_KEY_PATTERNS = [
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  'auth*.txt',
  '**/*credentials*.json',
  '**/*secret*',
  '**/*token*.txt',
  '**/*.pem',
  '**/*.crt',
  '.claude/memory/*.md',
  'server-setup/**/*.txt',
];

const DEFAULT_STATE: AppState = {
  projects: [],
  favorites: [],
  openChats: [],
  chatMeta: {},
  deployTargets: {},
  keyPatterns: DEFAULT_KEY_PATTERNS,
  ui: {
    layout: { left: 'tree', center: 'editor', right: 'chat' },
    leftWidth: 300,
    rightWidth: 520,
    bottomHeight: 220,
    leftTab: 'projects',
    visible: { setup: true, tree: true, chat: true, problems: false, keys: false, deploys: false, tests: false, cache: false, ping: false },
  },
};

/** Directory for app data. A portable build keeps data next to the executable. */
export function dataDir(): string {
  const portable = process.env.PORTABLE_EXECUTABLE_DIR;
  const dir = process.env.CLAUDE_EDITOR_DATA || (portable ? path.join(portable, 'claude-editor-data') : app.getPath('userData'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

class JsonFile<T> {
  private timer: NodeJS.Timeout | null = null;
  constructor(private file: string, public data: T) {}

  static load<T>(name: string, fallback: T, merge: (loaded: any) => T): JsonFile<T> {
    const file = path.join(dataDir(), name);
    let data = fallback;
    try {
      data = merge(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      /* first start or broken file: keep defaults */
    }
    return new JsonFile(file, data);
  }

  save() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

export const stateFile = JsonFile.load<AppState>('state.json', structuredClone(DEFAULT_STATE), (loaded) => ({
  ...structuredClone(DEFAULT_STATE),
  ...loaded,
  ui: {
    ...DEFAULT_STATE.ui,
    ...(loaded.ui ?? {}),
    visible: { ...DEFAULT_STATE.ui.visible, ...(loaded.ui?.visible ?? {}) },
    layout: validLayout(loaded.ui?.layout) ? loaded.ui.layout : DEFAULT_STATE.ui.layout,
  },
}));

function validLayout(l: any): boolean {
  return !!l && ['tree', 'chat', 'editor'].every((b) => [l.left, l.center, l.right].includes(b));
}

// First run with groups: everything open so far becomes the group «Основная».
if (!stateFile.data.groups?.length) {
  const d = stateFile.data;
  const id = randomUUID();
  d.groups = [{ id, name: 'Основная', projects: d.projects, favorites: d.favorites, openChats: d.openChats, activeChat: d.activeChat, chatProject: d.chatProject, openFiles: d.openFiles, activeFile: d.activeFile, treeOpen: d.ui.treeOpen }];
  d.activeGroup = id;
  stateFile.save();
}

/**
 * One-time repair: the project settings dialog used to drop a domain typed into the "add" field when Save was
 * pressed without Enter. The deploy site was saved though, so it is restored as the project's ping target.
 */
if (!stateFile.data.repairs?.includes('empty-domains')) {
  for (const p of stateFile.data.projects) {
    const site = stateFile.data.deployTargets[p.path.toLowerCase()]?.url;
    if (site && Array.isArray(p.domains) && p.domains.length === 0) p.domains = [{ id: randomUUID(), target: site }];
  }
  stateFile.data.repairs = [...(stateFile.data.repairs ?? []), 'empty-domains'];
  stateFile.save();
}

export const deploysFile = JsonFile.load<DeployEvent[]>('deploys.json', [], (l) => (Array.isArray(l) ? l : []));
export const problemsFile = JsonFile.load<Problem[]>('problems.json', [], (l) => (Array.isArray(l) ? l : []));

export const testsFile = JsonFile.load<TestResult[]>('tests.json', [], (l) => (Array.isArray(l) ? l : []));

export function flushAll() {
  testsFile.flush();
  stateFile.flush();
  deploysFile.flush();
  problemsFile.flush();
}
