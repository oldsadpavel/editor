import { ClipboardItem, clipboard, nativeImage, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
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
