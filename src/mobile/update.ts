import { registerPlugin } from '@capacitor/core';
import { log } from './log';

const Updater = registerPlugin<{ install(o: { url: string }): Promise<{ needsPermission?: boolean; started?: boolean }> }>('Updater');

/**
 * Self-update: the newest MPI-Remote-<version>-b<build>.apk in the GitHub releases of the editor, compared with this
 * app's build number; «Обновить» downloads it and opens the system installer (native plugin Updater).
 */

const RELEASES = 'https://api.github.com/repos/oldsadpavel/editor/releases?per_page=30';

export interface Available {
  build: number;
  name: string;
  url: string;
  size: number;
}

export async function currentBuild(): Promise<{ build: number; version: string }> {
  const cap = (window as any).Capacitor;
  if (!cap?.isNativePlatform?.()) return { build: 0, version: 'web' };
  const { App } = await import('@capacitor/app');
  const info = await App.getInfo();
  return { build: Number(info.build) || 0, version: info.version };
}

/** The newest APK on GitHub (null when none). */
export async function latest(): Promise<Available | null> {
  const res = await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  let best: Available | null = null;
  for (const r of await res.json()) {
    for (const a of r.assets ?? []) {
      const m = /^MPI-Remote-.*-b(\d+)\.apk$/.exec(a.name);
      if (m && (!best || Number(m[1]) > best.build)) best = { build: Number(m[1]), name: a.name, url: a.browser_download_url, size: a.size };
    }
  }
  return best;
}

/** Newer than this app, or null. */
export async function check(): Promise<Available | null> {
  const [cur, last] = await Promise.all([currentBuild(), latest()]);
  return last && last.build > cur.build ? last : null;
}

/** Downloads and opens the installer. 'permission' — Android asked to allow installs from this app first. */
export async function install(a: Available): Promise<'started' | 'permission'> {
  const cap = (window as any).Capacitor;
  if (!cap?.isNativePlatform?.()) {
    window.open(a.url, '_blank');
    return 'started';
  }
  try {
    const r = await Updater.install({ url: a.url });
    return r?.needsPermission ? 'permission' : 'started';
  } catch (e: any) {
    log('error', 'Обновление: ' + (e?.message ?? e), { url: a.url });
    throw e;
  }
}
