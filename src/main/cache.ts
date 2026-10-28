import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CacheCategory, CacheFile, CacheReport } from '../shared/types';
import { emit } from './bus';
import { claudeExecutable, runningSessions } from './claude';
import * as problems from './problems';
import { stateFile } from './store';

const DAY = 86_400_000;
const FREE_WARN_RATIO = 0.1;
const CLEANABLE_WARN_BYTES = 1024 ** 3;

const home = os.homedir();
const claudeDir = path.join(home, '.claude');
const tempClaude = path.join(os.tmpdir(), 'claude');
const roamingClaude = process.env.APPDATA ? path.join(process.env.APPDATA, 'Claude') : path.join(home, 'Library', 'Application Support', 'Claude');
const versionsDir = path.join(home, '.local', 'share', 'claude', 'versions');

interface Rule {
  id: string;
  title: string;
  safety: CacheCategory['safety'];
  note: string;
  paths: string[];
  /** Which files belong to the category (default: every file under paths). */
  include?: (file: string, root: string) => boolean;
  chat?: boolean;
}

const isTranscript = (f: string, root: string) => path.dirname(f) !== root && path.dirname(path.dirname(f)) === root && f.endsWith('.jsonl');

function rules(): Rule[] {
  const projects = path.join(claudeDir, 'projects');
  return [
    {
      id: 'scratch',
      title: 'Временные файлы ИИ (scratchpad)',
      safety: 'safe',
      note: 'Скрипты, выгрузки и черновики, которые Claude складывает во временную папку во время работы. После сессии не нужны.',
      paths: [tempClaude],
    },
    {
      id: 'session-data',
      title: 'Служебные данные сессий',
      safety: 'safe',
      note: 'Транскрипты субагентов и сохранённые большие выводы инструментов внутри ~/.claude/projects/<проект>/<сессия>/.',
      paths: [projects],
      include: (f, root) => !isTranscript(f, root) && path.basename(f) !== 'MEMORY.md' && !f.includes(`${path.sep}memory${path.sep}`),
    },
    {
      id: 'transcripts',
      title: 'История чатов (транскрипты)',
      safety: 'caution',
      note: 'Сами чаты. Удаление старых = их нельзя будет открыть и продолжить. Открытые и работающие чаты не удаляются. Память проекта (memory) не затрагивается.',
      paths: [projects],
      include: isTranscript,
      chat: true,
    },
    {
      id: 'file-history',
      title: 'Резервные копии правок (file-history)',
      safety: 'safe',
      note: 'Копии файлов до правок ИИ — нужны только для отката (rewind) в старых сессиях.',
      paths: [path.join(claudeDir, 'file-history')],
    },
    {
      id: 'misc',
      title: 'Снимки shell, вставки, загрузки, логи',
      safety: 'safe',
      note: 'shell-snapshots, paste-cache, uploads, debug, backups, cache Claude Code.',
      paths: ['shell-snapshots', 'paste-cache', 'uploads', 'debug', 'backups', 'cache', 'image-cache', 'todos'].map((d) => path.join(claudeDir, d)),
    },
    {
      id: 'desktop',
      title: 'Кеш Claude Desktop',
      safety: 'safe',
      note: 'Кеш браузера и логи приложения Claude Desktop. Лучше чистить, когда Claude Desktop закрыт.',
      paths: ['Cache', 'Code Cache', 'GPUCache', 'logs'].map((d) => path.join(roamingClaude, d)),
    },
  ];
}

async function walk(dir: string, out: { file: string; size: number; mtime: number }[]) {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full, out);
      if (!e.isFile()) return;
      try {
        const st = await fs.promises.stat(full);
        out.push({ file: full, size: st.size, mtime: st.mtimeMs });
      } catch {
        /* vanished while scanning */
      }
    }),
  );
}

/** Session ids that must never be deleted: open in the editor, running, or touched in the last day. */
function protectedSessions(): Set<string> {
  return new Set([...stateFile.data.openChats, ...runningSessions()].map((x) => x.toLowerCase()));
}

const cutoffFor = (r: Rule) => Date.now() - (r.chat ? (stateFile.data.cacheChatDays ?? 60) : (stateFile.data.cacheDays ?? 7)) * DAY;

function cleanableFile(r: Rule, f: { file: string; mtime: number }, keep: Set<string>) {
  if (f.mtime > cutoffFor(r)) return false;
  if (Date.now() - f.mtime < DAY) return false;
  const id = f.file.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]?.toLowerCase();
  return !(id && keep.has(id));
}

function currentVersion(): Promise<string | null> {
  const cli = claudeExecutable();
  if (!cli) return Promise.resolve(null);
  return new Promise((resolve) =>
    execFile(cli, ['--version'], { timeout: 15_000, windowsHide: true }, (err, out) => resolve(err ? null : (out.match(/\d+\.\d+\.\d+/)?.[0] ?? null))),
  );
}

async function versionsCategory(biggest: CacheFile[]): Promise<CacheCategory> {
  const cat: CacheCategory = {
    id: 'versions',
    title: 'Старые версии Claude Code',
    safety: 'safe',
    note: 'Claude Code при обновлении оставляет предыдущие бинарники (~280 МБ каждый). Нужна только текущая версия.',
    paths: [versionsDir],
    files: 0,
    bytes: 0,
    cleanableFiles: 0,
    cleanableBytes: 0,
    days: 0,
  };
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(versionsDir);
  } catch {
    return cat;
  }
  const current = await currentVersion();
  const newest = [...names].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  for (const n of names) {
    const files: { file: string; size: number; mtime: number }[] = [];
    const p = path.join(versionsDir, n);
    const st = await fs.promises.stat(p).catch(() => null);
    if (st?.isFile()) files.push({ file: p, size: st.size, mtime: st.mtimeMs });
    else await walk(p, files);
    const size = files.reduce((s, f) => s + f.size, 0);
    const keep = n === current || n === newest;
    cat.files += files.length;
    cat.bytes += size;
    if (!keep) {
      cat.cleanableFiles += files.length;
      cat.cleanableBytes += size;
    }
    biggest.push({ path: p, bytes: size, mtime: st?.mtimeMs ?? 0, category: 'versions', cleanable: !keep });
  }
  return cat;
}

let last: CacheReport | null = null;

export async function scanCache(): Promise<CacheReport> {
  const keep = protectedSessions();
  const biggest: CacheFile[] = [];
  const categories: CacheCategory[] = [];
  for (const r of rules()) {
    const files: { file: string; size: number; mtime: number }[] = [];
    for (const root of r.paths) {
      const all: typeof files = [];
      await walk(root, all);
      files.push(...(r.include ? all.filter((f) => r.include!(f.file, root)) : all));
    }
    const cat: CacheCategory = {
      id: r.id,
      title: r.title,
      safety: r.safety,
      note: r.note,
      paths: r.paths,
      files: files.length,
      bytes: 0,
      cleanableFiles: 0,
      cleanableBytes: 0,
      days: r.chat ? (stateFile.data.cacheChatDays ?? 60) : (stateFile.data.cacheDays ?? 7),
    };
    for (const f of files) {
      cat.bytes += f.size;
      const c = cleanableFile(r, f, keep);
      if (c) {
        cat.cleanableFiles++;
        cat.cleanableBytes += f.size;
      }
      if (f.size > 5 * 1024 * 1024) biggest.push({ path: f.file, bytes: f.size, mtime: f.mtime, category: r.id, cleanable: c });
    }
    categories.push(cat);
  }
  categories.push(await versionsCategory(biggest));

  let disk: CacheReport['disk'];
  try {
    const st = await fs.promises.statfs(home);
    disk = { path: path.parse(home).root, free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch {
    /* statfs unsupported */
  }

  last = { scannedAt: Date.now(), disk, categories, biggest: biggest.sort((a, b) => b.bytes - a.bytes).slice(0, 15) };
  reportProblems(last);
  emit({ type: 'cache', report: last });
  return last;
}

const gb = (b: number) => (b / 1024 ** 3).toFixed(1) + ' ГБ';

function reportProblems(r: CacheReport) {
  const safe = r.categories.filter((c) => c.safety === 'safe').reduce((s, c) => s + c.cleanableBytes, 0);
  if (r.disk && r.disk.free / r.disk.total < FREE_WARN_RATIO) {
    problems.report({
      source: 'cache',
      severity: 'warning',
      title: `Мало места на диске ${r.disk.path}: свободно ${gb(r.disk.free)} из ${gb(r.disk.total)}`,
      detail: `Кеш ИИ можно безопасно почистить на ${gb(safe)} — блок «Кеш ИИ».`,
      key: 'cache|disk',
    });
  } else problems.resolve('cache|disk');
  if (safe > CLEANABLE_WARN_BYTES) {
    problems.report({
      source: 'cache',
      severity: 'warning',
      title: `ИИ накопил ${gb(safe)} мусора, который можно удалить`,
      detail: r.categories
        .filter((c) => c.safety === 'safe' && c.cleanableBytes > 0)
        .map((c) => `${c.title}: ${gb(c.cleanableBytes)}`)
        .join('\n'),
      key: 'cache|trash',
    });
  } else problems.resolve('cache|trash');
}

async function removeEmptyDirs(dir: string, root: string) {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory()) await removeEmptyDirs(path.join(dir, e.name), root);
  if (dir !== root && (await fs.promises.readdir(dir).catch(() => ['x'])).length === 0) await fs.promises.rmdir(dir).catch(() => {});
}

/** Deletes cleanable files of a category. Returns freed bytes and files that could not be deleted (locked). */
export async function cleanCategory(id: string): Promise<{ freed: number; deleted: number; failed: number }> {
  let freed = 0;
  let deleted = 0;
  let failed = 0;
  if (id === 'versions') {
    const r = last?.biggest.filter((b) => b.category === 'versions' && b.cleanable) ?? [];
    for (const v of r) {
      try {
        await fs.promises.rm(v.path, { recursive: true, force: true });
        freed += v.bytes;
        deleted++;
      } catch {
        failed++;
      }
    }
  } else {
    const rule = rules().find((r) => r.id === id);
    if (!rule) throw new Error('Неизвестная категория');
    const keep = protectedSessions();
    for (const root of rule.paths) {
      const all: { file: string; size: number; mtime: number }[] = [];
      await walk(root, all);
      for (const f of all) {
        if (rule.include && !rule.include(f.file, root)) continue;
        if (!cleanableFile(rule, f, keep)) continue;
        try {
          await fs.promises.unlink(f.file);
          freed += f.size;
          deleted++;
        } catch {
          failed++;
        }
      }
      await removeEmptyDirs(root, root);
    }
  }
  await scanCache();
  return { freed, deleted, failed };
}

/** Deletes one big item from the report (only items the scan marked cleanable). */
export async function deleteItem(p: string) {
  const item = last?.biggest.find((b) => b.path === p);
  if (!item?.cleanable) throw new Error('Этот файл сейчас удалять нельзя');
  await fs.promises.rm(p, { recursive: true, force: true });
  await scanCache();
}

export function lastCache() {
  return last;
}
