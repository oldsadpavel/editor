import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DeployEvent, DeployTarget, SmokeTest, TestResult } from '../shared/types';
import { emit } from './bus';
import * as problems from './problems';
import { deploysFile, stateFile, testsFile } from './store';

const POLL_REFS_MS = 8_000;
const POLL_DEPLOY_MS = 15_000;
const STUCK_AFTER_MS = 30 * 60_000;
const MAX_DEPLOYS = 100;

const git = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile('git', args, { cwd, timeout: 15_000, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(out.trim()))),
  );

interface RepoState {
  root: string;
  refs: Map<string, string> | null;
  github?: { owner: string; repo: string } | null;
}

const repos = new Map<string, RepoState>();
let attribute: (repo: string, at: number) => string | undefined = () => undefined;

export function setPushAttribution(fn: typeof attribute) {
  attribute = fn;
}

/** Git root of a file or folder, or null when it is not inside a repository. */
export async function gitRoot(p: string): Promise<string | null> {
  let dir = p;
  try {
    if (!fs.statSync(p).isDirectory()) dir = path.dirname(p);
  } catch {
    dir = path.dirname(p);
  }
  try {
    return path.normalize(await git(dir, ['rev-parse', '--show-toplevel']));
  } catch {
    return null;
  }
}

/** Starts watching a repository for pushes (remote-tracking refs move when you push). */
export async function watchPath(p: string) {
  const root = await gitRoot(p);
  if (!root) return;
  const key = root.toLowerCase();
  if (repos.has(key)) return;
  const r: RepoState = { root, refs: null };
  repos.set(key, r);
  await pollRepo(r);
}

export function watchedRepos() {
  return [...repos.values()].map((r) => r.root);
}

async function readRefs(root: string) {
  const out = await git(root, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/remotes']);
  const m = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [ref, sha] = line.split(' ');
    if (ref && sha && !ref.endsWith('/HEAD')) m.set(ref, sha);
  }
  return m;
}

async function pollRepo(r: RepoState) {
  let refs: Map<string, string>;
  try {
    refs = await readRefs(r.root);
  } catch {
    return;
  }
  const prev = r.refs;
  r.refs = refs;
  if (!prev) return;
  for (const [ref, sha] of refs) {
    if (prev.get(ref) === sha) continue;
    // A fetch also moves remote refs; only count it as a push when the commit is ours locally (HEAD contains it).
    const local = await git(r.root, ['merge-base', '--is-ancestor', sha, 'HEAD']).then(() => true, () => false);
    if (!local) continue;
    const branch = ref.replace(/^[^/]+\//, '');
    registerPush(r, branch, sha);
  }
}

function registerPush(r: RepoState, branch: string, sha: string) {
  const now = Date.now();
  if (deploysFile.data.some((d) => d.sha === sha && d.repo === r.root)) return;
  const ev: DeployEvent = {
    id: randomUUID(),
    repo: r.root,
    branch,
    sha,
    pushedAt: now,
    sessionId: attribute(r.root, now),
    state: 'pushed',
    updatedAt: now,
  };
  deploysFile.data.unshift(ev);
  deploysFile.data = deploysFile.data.slice(0, MAX_DEPLOYS);
  publish();
  void trackDeploy(ev, r);
}

function publish() {
  deploysFile.save();
  emit({ type: 'deploys', deploys: deploysFile.data });
}

async function githubOf(r: RepoState) {
  if (r.github !== undefined) return r.github;
  try {
    const url = await git(r.root, ['remote', 'get-url', 'origin']);
    const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
    r.github = m ? { owner: m[1], repo: m[2] } : null;
  } catch {
    r.github = null;
  }
  return r.github;
}

async function gh(pathname: string) {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'claude-editor' };
  if (stateFile.data.githubToken) headers.Authorization = `Bearer ${stateFile.data.githubToken}`;
  const res = await fetch('https://api.github.com' + pathname, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return res.json();
}

async function checkCi(ev: DeployEvent, r: RepoState) {
  const g = await githubOf(r);
  if (!g) {
    ev.ci = { state: 'none', detail: 'Не GitHub-репозиторий' };
    return;
  }
  try {
    const runs = await gh(`/repos/${g.owner}/${g.repo}/commits/${ev.sha}/check-runs?per_page=100`);
    const list: any[] = runs.check_runs ?? [];
    ev.checks = list.map((c) => ({
      name: c.name,
      url: c.html_url,
      state: c.status !== 'completed' ? 'pending' : ['success', 'skipped', 'neutral'].includes(c.conclusion) ? 'success' : 'failure',
    }));
    if (!list.length) {
      const age = Date.now() - ev.pushedAt;
      ev.ci = { state: age > 3 * 60_000 ? 'none' : 'pending', detail: age > 3 * 60_000 ? 'CI не запускался' : 'Ждём CI' };
      return;
    }
    const failed = ev.checks.filter((c) => c.state === 'failure');
    const pending = ev.checks.filter((c) => c.state === 'pending');
    ev.ci = {
      state: failed.length ? 'failure' : pending.length ? 'pending' : 'success',
      url: `https://github.com/${g.owner}/${g.repo}/commit/${ev.sha}`,
      detail: failed.length ? 'Упало: ' + failed.map((c) => c.name).join(', ') : pending.length ? `Выполняется: ${pending.length}` : 'Все проверки пройдены',
    };
  } catch (e: any) {
    ev.ci = { state: 'pending', detail: `Нет доступа к GitHub API (${e.message}). Укажите токен в настройках деплоя.` };
  }
}

/** Fingerprint of a page that changes when a new build is deployed, but not on every request. */
function fingerprint(body: string, headers: Headers): string {
  const assets = [...body.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css|mjs)(?:\?[^"']*)?)["']/gi)].map((m) => m[1]);
  if (assets.length) return 'assets:' + createHash('sha1').update(assets.join('|')).digest('hex');
  const etag = headers.get('etag') || headers.get('last-modified');
  if (etag) return 'etag:' + etag;
  return 'body:' + createHash('sha1').update(body).digest('hex');
}

async function fetchSite(url: string) {
  const res = await fetch(url, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { 'Cache-Control': 'no-cache' } });
  const body = await res.text();
  return { status: res.status, body, fp: fingerprint(body, res.headers) };
}

async function trackDeploy(ev: DeployEvent, r: RepoState) {
  const target = stateFile.data.deployTargets[r.root.toLowerCase()];
  let baseline: string | null = null;
  if (target?.url) {
    try {
      baseline = (await fetchSite(target.url)).fp;
    } catch {
      /* site was down before the push; any successful answer counts as updated */
    }
    ev.site = { state: 'waiting', url: target.url };
  } else ev.site = { state: 'none', detail: 'Сайт для репозитория не настроен' };

  while (Date.now() - ev.pushedAt < STUCK_AFTER_MS) {
    await checkCi(ev, r);
    if (target?.url && ev.site?.state !== 'updated') {
      try {
        const s = await fetchSite(target.url);
        const short = ev.sha.slice(0, 7);
        const updated = target.mode === 'sha' ? s.body.includes(short) : baseline !== null && s.fp !== baseline;
        ev.site = { state: updated ? 'updated' : 'waiting', url: target.url, checkedAt: Date.now(), detail: `HTTP ${s.status}` };
        if (s.status >= 500) ev.site.detail = `Сайт отвечает ${s.status}`;
      } catch (e: any) {
        ev.site = { state: 'unreachable', url: target.url, checkedAt: Date.now(), detail: e.message };
      }
    }
    ev.state = deriveState(ev, !!target?.url);
    ev.updatedAt = Date.now();
    publish();
    if (ev.state === 'failed') {
      problems.report({
        source: 'deploy',
        severity: 'error',
        title: `Деплой ${path.basename(ev.repo)}@${ev.sha.slice(0, 7)} упал`,
        detail: ev.ci?.detail,
        sessionId: ev.sessionId,
        key: `deploy|${ev.id}`,
      });
      return;
    }
    if (ev.state === 'live') {
      problems.resolve(`deploy|${ev.id}`);
      if (target?.tests?.length) await runTests(r.root, ev.id);
      return;
    }
    await new Promise((res) => setTimeout(res, POLL_DEPLOY_MS));
  }
  ev.state = 'stuck';
  ev.updatedAt = Date.now();
  publish();
  problems.report({
    source: 'deploy',
    severity: 'error',
    title: `Деплой ${path.basename(ev.repo)}@${ev.sha.slice(0, 7)} завис`,
    detail: `Прошло 30 минут. CI: ${ev.ci?.detail ?? '—'}. Сайт: ${ev.site?.detail ?? ev.site?.state ?? '—'}`,
    sessionId: ev.sessionId,
    key: `deploy|${ev.id}`,
  });
}

function deriveState(ev: DeployEvent, hasSite: boolean): DeployEvent['state'] {
  if (ev.ci?.state === 'failure') return 'failed';
  if (hasSite) {
    if (ev.site?.state === 'updated') return 'live';
    return ev.ci?.state === 'pending' ? 'building' : 'deploying';
  }
  if (ev.ci?.state === 'success') return 'live';
  if (ev.ci?.state === 'none') return 'live';
  return 'building';
}

export async function runTests(repo: string, deployId?: string): Promise<TestResult[]> {
  const target = stateFile.data.deployTargets[repo.toLowerCase()];
  const tests = target?.tests ?? [];
  const results = await Promise.all(tests.map((t) => runOne(repo, t, deployId)));
  testsFile.data = [...results, ...testsFile.data.filter((x) => !results.some((r) => r.testId === x.testId))].slice(0, 500);
  testsFile.save();
  emit({ type: 'tests', results: testsFile.data });
  for (const r of results) {
    const key = `tests|${r.testId}`;
    if (r.ok) problems.resolve(key);
    else
      problems.report({
        source: 'tests',
        severity: 'error',
        title: `Тест «${r.name}» не прошёл (${path.basename(repo)})`,
        detail: `${r.url}\n${r.detail ?? ''}`,
        key,
      });
  }
  const dep = deployId && deploysFile.data.find((d) => d.id === deployId);
  if (dep) {
    dep.tests = { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, at: Date.now() };
    publish();
  }
  return results;
}

async function runOne(repo: string, t: SmokeTest, deployId?: string): Promise<TestResult> {
  const started = Date.now();
  const base = { testId: t.id, repo, name: t.name, url: t.url, at: started, deployId };
  try {
    const res = await fetch(t.url, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    const body = await res.text();
    const ms = Date.now() - started;
    const errors: string[] = [];
    if (res.status !== t.expectStatus) errors.push(`статус ${res.status}, ожидали ${t.expectStatus}`);
    if (t.contains && !body.includes(t.contains)) errors.push(`нет текста «${t.contains}»`);
    if (t.maxMs && ms > t.maxMs) errors.push(`ответ ${ms} мс > ${t.maxMs} мс`);
    return { ...base, ok: !errors.length, status: res.status, ms, detail: errors.join('; ') || undefined };
  } catch (e: any) {
    return { ...base, ok: false, ms: Date.now() - started, detail: e.message };
  }
}

export function setTarget(repo: string, target: DeployTarget | null) {
  const key = repo.toLowerCase();
  if (target) stateFile.data.deployTargets[key] = target;
  else delete stateFile.data.deployTargets[key];
  stateFile.save();
}

export function listTests() {
  return testsFile.data;
}

export function listDeploys() {
  return deploysFile.data;
}

let timer: NodeJS.Timeout | null = null;
export function startDeployWatcher() {
  // Deploys interrupted by an app restart continue to be tracked.
  for (const ev of deploysFile.data) {
    if (['pushed', 'building', 'deploying'].includes(ev.state) && Date.now() - ev.pushedAt < STUCK_AFTER_MS) {
      const r: RepoState = repos.get(ev.repo.toLowerCase()) ?? { root: ev.repo, refs: null };
      void trackDeploy(ev, r);
    }
  }
  timer = setInterval(() => {
    for (const r of repos.values()) void pollRepo(r);
  }, POLL_REFS_MS);
}

export function stopDeployWatcher() {
  if (timer) clearInterval(timer);
}
