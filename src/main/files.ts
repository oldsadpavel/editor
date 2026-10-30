import { ClipboardItem, clipboard, nativeImage, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dataDir } from './store';
import { findTranscript } from './transcript';

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const MIME_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };

const pad = (n: number) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** `name.ext` → `name (2).ext` … until the path is free. */
function freePath(dir: string, name: string) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

/**
 * Saves pasted bytes (a screenshot has no file behind it). Without `dir` it goes to the editor's attachment store,
 * with `dir` (paste into the project tree) it lands in that folder under a readable name.
 */
export function saveBlob(bytes: Uint8Array, mime: string, name?: string, dir?: string): string {
  const ext = MIME_EXT[mime] ?? (path.extname(name ?? '').slice(1) || 'bin');
  const target = dir ?? path.join(dataDir(), 'attachments', new Date().toISOString().slice(0, 10));
  fs.mkdirSync(target, { recursive: true });
  const fileName = dir ? (name && name !== 'image.png' ? name : `Скриншот ${stamp()}.${ext}`) : `${randomUUID()}.${ext}`;
  const p = freePath(target, fileName);
  fs.writeFileSync(p, bytes);
  return p;
}

/**
 * Clipboard contents the renderer's paste event could not see: files copied in Explorer/Finder (text/uri-list,
 * one file:// URL per line) or a bitmap (PrintScreen). The bitmap is saved like a pasted screenshot.
 */
export async function clipboardFiles(dir?: string): Promise<string[]> {
  const out: string[] = [];
  const items = await clipboard.read();
  for (const item of items) {
    if (item.types.includes('text/uri-list')) {
      const list = await ((await item.getType('text/uri-list')) as Blob).text();
      for (const line of list.split(/\r?\n/)) {
        if (!line.startsWith('file:')) continue;
        const p = fileURLToPath(line.trim());
        if (fs.existsSync(p)) out.push(p);
      }
    }
  }
  if (!out.length) {
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = (await item.getType(type)) as Blob;
      out.push(saveBlob(new Uint8Array(await blob.arrayBuffer()), type, undefined, dir));
      break;
    }
  }
  return out;
}

/**
 * Ctrl+V in the project tree: files copied in Explorer are copied into `dir`, a screenshot is saved there as
 * «Скриншот <дата>.png». Returns the created paths.
 */
export async function pasteInto(dir: string): Promise<string[]> {
  const items = await clipboard.read();
  const sources: string[] = [];
  for (const item of items) {
    if (!item.types.includes('text/uri-list')) continue;
    const list = await ((await item.getType('text/uri-list')) as Blob).text();
    for (const line of list.split(/\r?\n/)) if (line.startsWith('file:')) sources.push(fileURLToPath(line.trim()));
  }
  if (sources.length) return copyInto(dir, sources.filter((p) => fs.existsSync(p)));
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (type) return [saveBlob(new Uint8Array(await ((await item.getType(type)) as Blob).arrayBuffer()), type, undefined, dir)];
  }
  return [];
}

/** Copies files/folders into `dir`, never overwriting: name clashes get a « (2)» suffix. */
export async function copyInto(dir: string, paths: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const src of paths) {
    const dst = freePath(dir, path.basename(src));
    await fs.promises.cp(src, dst, { recursive: true, errorOnExist: true });
    result.push(dst);
  }
  return result;
}

/** Opens an image in the system editor: Paint on Windows, Preview on macOS. */
export function editImage(p: string) {
  if (process.platform === 'win32') spawn('mspaint.exe', [p], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') execFile('open', ['-a', 'Preview', p]);
  else void shell.openPath(p);
}

export async function copyImage(p: string) {
  const img = nativeImage.createFromPath(p);
  if (img.isEmpty()) throw new Error('Не удалось прочитать картинку');
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' }) })]);
}

export async function openPath(p: string) {
  const err = await shell.openPath(p);
  if (err) throw new Error(err);
}

const imageCache = new Map<string, string>();
const IMAGE_CACHE_MAX = 40;

/**
 * An image that exists only inside a transcript (pasted in the terminal or the IDE plugin):
 * finds the entry by uuid and returns the image block as a data URL.
 */
export async function transcriptImage(sessionId: string, uuid: string, index: number): Promise<string | null> {
  const key = `${sessionId}|${uuid}|${index}`;
  const hit = imageCache.get(key);
  if (hit) return hit;
  const file = findTranscript(sessionId);
  if (!file) return null;
  const needle = `"uuid":"${uuid}"`;
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let url: string | null = null;
  for await (const line of rl) {
    if (!line.includes(needle)) continue;
    try {
      const block = JSON.parse(line).message?.content?.[index];
      if (block?.type === 'image' && block.source?.type === 'base64') url = `data:${block.source.media_type};base64,${block.source.data}`;
    } catch {
      /* malformed line */
    }
    rl.close();
    break;
  }
  if (url) {
    imageCache.set(key, url);
    if (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value!);
  }
  return url;
}

/** Saves a data URL (an image known only from a transcript) so it can be edited or opened. */
export function saveDataUrl(url: string): string {
  const m = url.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) throw new Error('Не картинка');
  return saveBlob(Buffer.from(m[2], 'base64'), m[1]);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'release', '.next', '.nuxt', '.cache', 'coverage', '.idea', '.vscode', '__pycache__', 'storage']);
const fileLists = new Map<string, { at: number; files: string[] }>();

/** Project files (relative paths), cached for a minute; big trees are capped. */
function projectFiles(cwd: string): string[] {
  const hit = fileLists.get(cwd);
  if (hit && Date.now() - hit.at < 60_000) return hit.files;
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    if (out.length > 30_000) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  walk(cwd, '');
  fileLists.set(cwd, { at: Date.now(), files: out });
  return out;
}

/** @-mention search: file name matches first, then path matches; up to 30. */
export function searchFiles(cwd: string, q: string): string[] {
  const needle = q.toLowerCase().replace(/\\/g, '/');
  const all = projectFiles(cwd);
  if (!needle) return all.slice(0, 30);
  const byName = all.filter((f) => f.slice(f.lastIndexOf('/') + 1).toLowerCase().includes(needle));
  const byPath = all.filter((f) => !byName.includes(f) && f.toLowerCase().includes(needle));
  return [...byName.sort((a, b) => a.length - b.length), ...byPath].slice(0, 30);
}

/** Latin/Cyrillic look-alikes folded together: the model often writes `1c` for a folder named `1с` or the other way round. */
const LOOKALIKE: Record<string, string> = { а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x' };
const fold = (s: string) => Array.from(s.normalize('NFC').toLowerCase(), (ch) => LOOKALIKE[ch] ?? ch).join('');

/** Walks `rel` from `base` segment by segment; a segment that isn't there exactly matches a sibling with the same folded name. */
function walkFolded(base: string, rel: string): string | null {
  let cur = base;
  for (const seg of rel.split(/[\/]+/).filter(Boolean)) {
    const exact = path.join(cur, seg);
    if (fs.existsSync(exact)) {
      cur = exact;
      continue;
    }
    let names: string[];
    try {
      names = fs.readdirSync(cur);
    } catch {
      return null;
    }
    const hit = names.find((n) => fold(n) === fold(seg));
    if (!hit) return null;
    cur = path.join(cur, hit);
  }
  return cur;
}

/**
 * A path from a chat answer → an existing file. Relative paths are tried against the chat's project first, then the
 * other projects (a chat often works across several), each time tolerating Unicode normalization and c/с-style look-alikes.
 */
export function resolvePath(base: string, rel: string, roots: string[]): string | null {
  rel = rel.trim().replace(/^["'`]|["'`]$/g, '');
  if (rel.startsWith('~/')) rel = path.join(os.homedir(), rel.slice(2));
  if (path.isAbsolute(rel)) {
    if (fs.existsSync(rel)) return rel;
    const root = path.parse(rel).root;
    return walkFolded(root, rel.slice(root.length));
  }
  const bases = [base, ...roots.filter((r) => r.toLowerCase() !== base.toLowerCase())];
  for (const b of bases) if (fs.existsSync(path.join(b, rel))) return path.join(b, rel);
  for (const b of bases) {
    const hit = walkFolded(b, rel);
    if (hit) return hit;
  }
  // a bare file name (`МОДУЛЬ_X.txt`): look it up in the projects' files and memory folders, chat's project first
  if (!/[\\/]/.test(rel)) {
    const name = fold(rel);
    for (const b of bases) {
      const mem = walkFolded(path.join(b, '.claude', 'memory'), rel);
      if (mem) return mem;
      const found = projectFiles(b)
        .filter((f) => fold(f.slice(f.lastIndexOf('/') + 1)) === name)
        .sort((x, y) => x.length - y.length)[0];
      if (found) return path.join(b, found);
    }
  }
  return null;
}
