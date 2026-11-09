import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Git for the tree's «Git ▸» menu (like PhpStorm): status colours, commit, diff, history, rollback, branches,
 * pull / push / fetch, stash. Plain `git` commands in the file's repository.
 */

export type GitCode = 'M' | 'A' | 'D' | 'R' | 'U' | 'C' | 'I';

function git(cwd: string, args: string[], okCodes = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], { cwd, windowsHide: true, maxBuffer: 64 << 20, encoding: 'utf8' }, (err, out, stderr) => {
      const code = err ? ((err as any).code ?? 1) : 0;
      if (err && !(typeof code === 'number' && okCodes.includes(code))) reject(new Error((stderr || err.message).trim()));
      else resolve(out);
    });
  });
}

const dirOf = (p: string) => (fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p));

/** The repository a file or folder is in, or null. */
export async function repoRoot(p: string): Promise<string | null> {
  try {
    return path.normalize((await git(dirOf(p), ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    return null;
  }
}

function codeOf(xy: string): GitCode {
  if (xy === '??') return 'U';
  if (xy === '!!') return 'I';
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'C';
  if (xy.includes('R')) return 'R';
  if (xy.includes('A')) return 'A';
  if (xy.includes('D')) return 'D';
  return 'M';
}

/** Changed files of a repository (absolute paths) → code; plus the current branch and how far it is from upstream. */
export async function status(root: string, under?: string) {
  const out = await git(root, ['status', '--porcelain=v1', '-z', '--branch', '-uall', ...(under ? ['--', under] : [])]);
  const files: { path: string; code: GitCode; staged: boolean }[] = [];
  let branch = '';
  let ahead = 0;
  let behind = 0;
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    if (e.startsWith('## ')) {
      const m = e.match(/^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.\S+)?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/);
      branch = m?.[1] ?? '';
      ahead = Number(m?.[2] ?? 0);
      behind = Number(m?.[3] ?? 0);
      continue;
    }
    const xy = e.slice(0, 2);
    const rel = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // the old name follows
    files.push({ path: path.join(root, rel), code: codeOf(xy), staged: xy[0] !== ' ' && xy[0] !== '?' });
  }
  return { root, branch, ahead, behind, files };
}

/** Stages the files and commits exactly them (others staged before stay staged); then pushes if asked. */
export async function commit(root: string, paths: string[], message: string, push: boolean) {
  if (!message.trim()) throw new Error('Пустое сообщение коммита');
  if (!paths.length) throw new Error('Не выбрано ни одного файла');
  const rel = paths.map((p) => path.relative(root, p) || '.');
  await git(root, ['add', '-A', '--', ...rel]);
  const out = await git(root, ['commit', '-m', message, '--', ...rel]);
  return push ? `${out}\n${await pushBranch(root)}` : out;
}

export const add = (root: string, paths: string[]) => git(root, ['add', '-A', '--', ...paths.map((p) => path.relative(root, p) || '.')]);

/** Working tree against HEAD (a new file: all of it as added). */
export async function diff(root: string, p: string): Promise<string> {
  const rel = path.relative(root, p) || '.';
  const st = await status(root, rel);
  const untracked = st.files.filter((f) => f.code === 'U');
  let out = (await git(root, ['diff', 'HEAD', '--', rel]).catch(() => git(root, ['diff', '--cached', '--', rel]))) || '';
  for (const f of untracked.slice(0, 50)) out += await git(root, ['diff', '--no-index', '--', '/dev/null', path.relative(root, f.path)], [0, 1]);
  return out;
}

export interface Commit {
  hash: string;
  author: string;
  at: number;
  subject: string;
}

export async function log(root: string, p: string, limit = 300): Promise<Commit[]> {
  const out = await git(root, ['log', `-n${limit}`, '--format=%H%x1f%an%x1f%at%x1f%s', '--', path.relative(root, p) || '.']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, author, at, subject] = l.split('\x1f');
      return { hash, author, at: Number(at) * 1000, subject };
    });
}

/** One commit: its message and the diff, limited to the path when given. */
export const show = (root: string, hash: string, p?: string) => git(root, ['show', '--format=%H%n%an <%ae>%n%ad%n%n%B', hash, ...(p ? ['--', path.relative(root, p) || '.'] : [])]);

/** Back to HEAD: tracked files restored, files only added (not in HEAD) unstaged; untracked ones are left alone. */
export async function rollback(root: string, paths: string[]) {
  const rel = paths.map((p) => path.relative(root, p) || '.');
  const st = await status(root);
  const inHead = async (r: string) => !!(await git(root, ['ls-tree', '-r', '--name-only', 'HEAD', '--', r]).catch(() => '')).trim();
  const restore: string[] = [];
  const unstage: string[] = [];
  for (const r of rel) {
    if (await inHead(r)) restore.push(r);
    else if (st.files.some((f) => f.staged && (path.relative(root, f.path) === r || path.relative(root, f.path).startsWith(r + path.sep)))) unstage.push(r);
  }
  if (restore.length) await git(root, ['restore', '--staged', '--worktree', '--source=HEAD', '--', ...restore]);
  if (unstage.length) await git(root, ['restore', '--staged', '--', ...unstage]);
  return { restored: restore.length, unstaged: unstage.length };
}

async function currentBranch(root: string) {
  // the full ref: a short name is «heads/main» when a tag is also called main
  const ref = (await git(root, ['symbolic-ref', '-q', 'HEAD'], [0, 1])).trim();
  return ref ? ref.replace(/^refs\/heads\//, '') : 'HEAD';
}

/** Push the current branch; a full ref name, so a tag with the same name doesn't make it ambiguous. */
async function pushBranch(root: string) {
  const b = await currentBranch(root);
  if (b === 'HEAD') throw new Error('HEAD не на ветке (detached) — сначала переключитесь на ветку');
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '');
  const remote = upstream.trim().split('/')[0] || 'origin';
  const target = upstream.trim() ? upstream.trim().slice(remote.length + 1) : b;
  const out = await git(root, ['push', ...(upstream.trim() ? [] : ['-u']), remote, `refs/heads/${b}:refs/heads/${target}`]);
  return out || `Отправлено: ${b} → ${remote}/${target}`;
}

export const push = (root: string) => pushBranch(root);
export const pull = (root: string) => git(root, ['pull', '--no-edit']);
export const fetch = (root: string) => git(root, ['fetch', '--all', '--prune']);

export async function branches(root: string) {
  const out = await git(root, ['for-each-ref', '--format=%(HEAD)%1f%(refname)%1f%(committerdate:unix)%1f%(upstream:short)', 'refs/heads', 'refs/remotes']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [head, ref, at, upstream] = l.split('\x1f');
      const remote = ref.startsWith('refs/remotes/');
      return { name: ref.replace(/^refs\/(heads|remotes)\//, ''), current: head === '*', remote, at: Number(at) * 1000, upstream };
    })
    .filter((b) => !(b.remote && b.name.endsWith('/HEAD')));
}

/** Switch to a branch; a remote one (origin/x) gets a local tracking branch. */
export async function checkout(root: string, name: string, remote: boolean) {
  if (!remote) return git(root, ['switch', name]);
  const local = name.replace(/^[^/]+\//, '');
  const exists = !!(await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${local}`], [0, 1])).trim();
  return exists ? git(root, ['switch', local]) : git(root, ['switch', '--track', name]);
}
export const newBranch = (root: string, name: string) => git(root, ['switch', '-c', name]);
export const stash = (root: string, message: string) => git(root, ['stash', 'push', '-u', ...(message ? ['-m', message] : [])]);
export const unstash = (root: string) => git(root, ['stash', 'pop']);
export const stashList = async (root: string) => (await git(root, ['stash', 'list'])).split('\n').filter(Boolean);
