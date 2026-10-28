import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AppState, ProjectRef } from '../shared/types';

/** Where a project's code comes from, so a restored setup can clone it on a new machine. */
export interface GitOrigin {
  remote: string;
  branch?: string;
  /** The repository root (the project folder may be inside it). */
  root: string;
}

const cache = new Map<string, { at: number; info: GitOrigin | null }>();

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** origin URL, current branch and repo root of a folder (cached for 10 minutes; null when it isn't a git repo). */
export function gitOrigin(dir: string): GitOrigin | null {
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.info;
  let info: GitOrigin | null = null;
  try {
    if (fs.existsSync(dir)) {
      const root = path.resolve(git(dir, ['rev-parse', '--show-toplevel']));
      const remote = git(dir, ['remote', 'get-url', 'origin']);
      let branch: string | undefined;
      try {
        branch = git(dir, ['branch', '--show-current']) || undefined;
      } catch {
        /* detached */
      }
      // credentials embedded in an https URL (user:token@) must not travel with the settings
      if (remote) info = { remote: remote.replace(/^(https?:\/\/)[^@/]+@/, '$1'), branch, root };
    }
  } catch {
    info = null;
  }
  cache.set(dir, { at: Date.now(), info });
  return info;
}

const annotate = (p: ProjectRef): ProjectRef => {
  const g = gitOrigin(p.path);
  // a folder that is gone keeps what was recorded before, so it can still be cloned
  return g ? { ...p, git: g } : p;
};

/** Settings with every project's git origin, for export and the cloud. */
export function withGitOrigins<T extends Partial<AppState>>(s: T): T {
  return {
    ...s,
    ...(s.projects ? { projects: s.projects.map(annotate) } : {}),
    ...(s.groups ? { groups: s.groups.map((g) => ({ ...g, projects: g.projects.map(annotate) })) } : {}),
  };
}

/** Projects of all groups that are missing on disk but can be cloned. */
export function missingProjects(st: AppState): ProjectRef[] {
  const all = [...st.projects, ...(st.groups ?? []).flatMap((g) => g.projects)];
  const seen = new Set<string>();
  return all.filter((p) => {
    const key = path.resolve(p.path).toLowerCase();
    if (seen.has(key) || fs.existsSync(p.path) || !p.git?.remote) return false;
    seen.add(key);
    return true;
  });
}

/** git clone into the project's repository root (parents are created). */
export function cloneProject(remote: string, root: string, branch?: string): Promise<string> {
  fs.mkdirSync(path.dirname(root), { recursive: true });
  if (fs.existsSync(root) && fs.readdirSync(root).length) return Promise.reject(new Error(`Папка ${root} уже есть и не пустая`));
  return new Promise((resolve, reject) => {
    execFile('git', ['clone', ...(branch ? ['--branch', branch] : []), remote, root], { windowsHide: true, timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`git clone не удался: ${(stderr || err.message).trim().slice(-600)}`)) : resolve(root),
    );
  });
}
