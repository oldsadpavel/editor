import { bridge, call } from './api';

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
export const isImage = (p: string) => IMAGE_EXT.test(p);

/**
 * Files from a paste or drop, as paths on disk.
 * - Files copied in Explorer/Finder come with their real path.
 * - In-memory data (a screenshot) is saved by the main process: into `dir` when given (paste into a project
 *   folder), otherwise into the editor's attachment store.
 * - When the event carries no files (some sources only put data on the OS clipboard), the main process reads
 *   the clipboard directly; that fallback only runs for paste, and only if there is no plain text to paste.
 * Returns [] when the event is ordinary text, so the caller can let the default paste happen.
 */
export async function readPastedFiles(files: FileList | null | undefined, opts: { dir?: string; fallback?: boolean } = {}): Promise<string[]> {
  const out: string[] = [];
  for (const f of Array.from(files ?? [])) {
    const p = bridge.pathForFile(f);
    if (p) out.push(p);
    else out.push(await call<string>('attach:saveBlob', new Uint8Array(await f.arrayBuffer()), f.type || 'application/octet-stream', f.name, opts.dir));
  }
  if (!out.length && opts.fallback) out.push(...(await call<string[]>('clipboard:files', opts.dir)));
  return out;
}

/** True when a paste event has files (or nothing textual at all, so the OS clipboard is worth checking). */
export function pasteHasFiles(e: ClipboardEvent | React.ClipboardEvent) {
  const d = e.clipboardData;
  if (!d) return false;
  if (d.files.length) return true;
  return !d.getData('text/plain') && !d.getData('text/html');
}
