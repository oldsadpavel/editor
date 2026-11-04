import fs from 'node:fs';
import path from 'node:path';
import type { AppState, Task } from '../shared/types';
import { dataDir } from './store';

/**
 * Задачи in the settings cloud (Insider or your own server). They go along with the other settings; here are the two
 * things plain settings don't do: merging (a task made on one machine isn't lost when another uploads) and the
 * pictures of task descriptions, which are files on this machine.
 */

const IMG_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const MAX_ONE = 1.5 * 1024 * 1024;
const MAX_ALL = 5 * 1024 * 1024;
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

const cache = new Map<string, { key: string; url: string }>();

/** Pictures used in task descriptions, as data URLs (one ≤ 1.5 MB, all ≤ 5 MB), keyed by their path in the text. */
export function taskImages(tasks: Task[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  let total = 0;
  for (const t of tasks ?? []) {
    for (const m of t.body.matchAll(IMG_RE)) {
      const ref = m[1];
      if (out[ref]) continue;
      const file = ref.replace(/\//g, path.sep);
      const mime = MIME[path.extname(file).toLowerCase()];
      if (!mime) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.size > MAX_ONE || total + st.size > MAX_ALL) continue;
      const key = `${st.size}:${st.mtimeMs}`;
      let hit = cache.get(file);
      if (hit?.key !== key) {
        hit = { key, url: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` };
        cache.set(file, hit);
      }
      out[ref] = hit.url;
      total += st.size;
    }
  }
  return out;
}

const stamp = (t: Task) => t.updatedAt ?? t.createdAt;

/**
 * Tasks after a download: local and cloud ones together; a task edited on both sides — the newer edit wins; tasks
 * deleted on either side stay deleted. Pictures this machine doesn't have are written from the cloud copy.
 */
export function mergeTasks(local: Partial<AppState>, incoming: Partial<AppState> & { taskImages?: Record<string, string> }) {
  const deleted = [...new Set([...(local.tasksDeleted ?? []), ...(incoming.tasksDeleted ?? [])])].slice(-1000);
  const byId = new Map((local.tasks ?? []).map((t) => [t.id, t]));
  for (const t of incoming.tasks ?? []) {
    const mine = byId.get(t.id);
    if (!mine || stamp(t) > stamp(mine)) byId.set(t.id, t);
  }
  const images = incoming.taskImages ?? {};
  const dir = path.join(dataDir(), 'attachments', 'tasks');
  const tasks = [...byId.values()]
    .filter((t) => !deleted.includes(t.id))
    .map((t) => {
      let body = t.body;
      for (const m of t.body.matchAll(IMG_RE)) {
        const ref = m[1];
        if (fs.existsSync(ref.replace(/\//g, path.sep)) || !images[ref]) continue;
        const data = images[ref].replace(/^data:[^;]+;base64,/, '');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, path.basename(ref.replace(/\\/g, '/')));
        if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(data, 'base64'));
        body = body.split(ref).join(file.replace(/\\/g, '/'));
      }
      return body === t.body ? t : { ...t, body };
    });
  return { tasks, tasksDeleted: deleted };
}
