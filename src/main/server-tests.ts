import type { ServerTestReport } from '../shared/types';
import { emit } from './bus';
import { authorizedFetch } from './cloud';
import * as problems from './problems';
import { JsonStore, stateFile } from './store';

/**
 * Test results reported by the server after a deploy (the project's own test suite, run by its deploy script).
 * Protocol — GET <testsReport url> returns JSON:
 *   { commit, status: 'running'|'passed'|'failed'|'error', startedAt, finishedAt, durationMs,
 *     tests, failures, errors, skipped, summary?, failed: [{ name, message? }], detailsUrl? }
 * Insider's backend serves it at https://parts.mrkt.ru/api/editor/config/tests/latest (cloud sign-in, super-admin);
 * other projects can publish a JSON file or endpoint of the same shape (Claude sets it up, see autoTestsPrompt).
 */
const reports = JsonStore<Record<string, ServerTestReport>>('server-tests.json', {});

export const listReports = () => reports.data;

const publish = () => emit({ type: 'serverTests', reports: reports.data });

async function load(url: string): Promise<any> {
  // Same origin as the signed-in cloud storage (Insider): the request carries that sign-in.
  const res = (await authorizedFetch(url)) ?? (await fetch(url, { headers: { Accept: 'application/json' } }));
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Отчёт не JSON (HTTP ${res.status}): ${text.slice(0, 120)}`);
  }
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

const sameCommit = (a?: string | null, b?: string | null) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/** Fetches the report of one repo and records it (problem on failure, resolved on pass). */
export async function refresh(repo: string, forSha?: string): Promise<ServerTestReport | null> {
  const key = repo.toLowerCase();
  const url = stateFile.data.deployTargets[key]?.testsReport;
  if (!url) return null;
  const prev = reports.data[key];
  let r: ServerTestReport;
  try {
    const b = await load(url);
    r = {
      repo: key,
      url,
      commit: b.commit ?? undefined,
      status: ['running', 'passed', 'failed', 'error'].includes(b.status) ? b.status : 'error',
      startedAt: b.startedAt ? Date.parse(b.startedAt) : undefined,
      finishedAt: b.finishedAt ? Date.parse(b.finishedAt) : undefined,
      durationMs: b.durationMs,
      tests: b.tests ?? 0,
      failures: b.failures ?? 0,
      errors: b.errors ?? 0,
      skipped: b.skipped ?? 0,
      summary: b.summary ?? undefined,
      failed: Array.isArray(b.failed) ? b.failed.slice(0, 50) : [],
      detailsUrl: b.detailsUrl ?? undefined,
      fetchedAt: Date.now(),
      forSha: forSha ?? prev?.forSha,
    };
  } catch (e) {
    r = { ...(prev ?? { repo: key, url, status: 'error', tests: 0, failures: 0, errors: 0, skipped: 0, failed: [] }), url, fetchedAt: Date.now(), fetchError: (e as Error).message };
  }
  reports.data[key] = r;
  reports.save();
  publish();
  const name = repo.split(/[\\/]/).pop();
  if (!r.fetchError && (r.status === 'failed' || r.status === 'error')) {
    problems.report({
      source: 'tests',
      severity: 'error',
      title: `Тесты на сервере ${name}: ${r.status === 'error' ? 'прогон не удался' : `упало ${r.failures + r.errors} из ${r.tests}`}`,
      detail: [r.commit ? `коммит ${r.commit}` : '', ...r.failed.slice(0, 5).map((f) => `• ${f.name}${f.message ? ` — ${f.message.slice(0, 160)}` : ''}`)].filter(Boolean).join('\n'),
      key: `server-tests|${key}`,
    });
  } else if (!r.fetchError && r.status === 'passed') problems.resolve(`server-tests|${key}`);
  return r;
}

/**
 * After a deploy is live: the server runs its tests on the new commit. Poll until the report shows a finished run
 * of this commit (or 20 minutes pass).
 */
export async function awaitRunFor(repo: string, sha: string) {
  const until = Date.now() + 20 * 60_000;
  while (Date.now() < until) {
    const r = await refresh(repo, sha);
    if (!r) return;
    if (!r.fetchError && sameCommit(r.commit, sha) && r.status !== 'running') return;
    await new Promise((res) => setTimeout(res, 20_000));
  }
}

/** Every 10 minutes: the latest state of every connected report (also catches runs started by hand). */
export function startServerTests() {
  const tick = () => {
    for (const [repo, t] of Object.entries(stateFile.data.deployTargets)) if (t.testsReport) void refresh(repo);
  };
  setTimeout(tick, 15_000);
  setInterval(tick, 10 * 60_000);
}
