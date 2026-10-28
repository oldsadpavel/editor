import { execFile } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import type { PingResult, ProdTarget, ProjectRef } from '../shared/types';
import { emit } from './bus';
import * as problems from './problems';
import { stateFile } from './store';

const HISTORY = 30;
const TIMEOUT_MS = 10_000;
/** Consecutive failures before a target is reported, so a single dropped packet doesn't raise an alarm. */
const FAILS_TO_ALERT = 2;
const CERT_WARN_DAYS = 14;

const results = new Map<string, PingResult>();
const lastRun = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;

function kindOf(target: string): PingResult['kind'] {
  if (/^https?:\/\//i.test(target)) return 'http';
  if (/:\d+$/.test(target)) return 'tcp';
  return 'icmp';
}

async function checkHttp(url: string) {
  const started = Date.now();
  const res = await fetch(url, { redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  await res.arrayBuffer().catch(() => {});
  const ms = Date.now() - started;
  return { ok: res.status < 500, ms, status: res.status, detail: res.status >= 500 ? `HTTP ${res.status}` : undefined };
}

function certDays(url: string): Promise<number | undefined> {
  const u = new URL(url);
  if (u.protocol !== 'https:') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const sock = tls.connect({ host: u.hostname, port: Number(u.port) || 443, servername: u.hostname, rejectUnauthorized: false, timeout: TIMEOUT_MS }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      resolve(cert?.valid_to ? Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86_400_000) : undefined);
    });
    sock.on('error', () => resolve(undefined));
    sock.on('timeout', () => {
      sock.destroy();
      resolve(undefined);
    });
  });
}

function checkTcp(target: string) {
  const i = target.lastIndexOf(':');
  const host = target.slice(0, i);
  const port = Number(target.slice(i + 1));
  const started = Date.now();
  return new Promise<{ ok: boolean; ms?: number; detail?: string }>((resolve) => {
    const s = net.connect({ host, port, timeout: TIMEOUT_MS }, () => {
      s.end();
      resolve({ ok: true, ms: Date.now() - started });
    });
    s.on('error', (e) => resolve({ ok: false, detail: e.message }));
    s.on('timeout', () => {
      s.destroy();
      resolve({ ok: false, detail: 'таймаут' });
    });
  });
}

/** ICMP via the system ping (works without admin rights). */
function checkIcmp(host: string) {
  const win = process.platform === 'win32';
  const args = win ? ['-n', '1', '-w', String(TIMEOUT_MS / 2)] : ['-c', '1', '-W', String(TIMEOUT_MS / 2000)];
  return new Promise<{ ok: boolean; ms?: number; detail?: string }>((resolve) => {
    execFile('ping', [...args, host], { timeout: TIMEOUT_MS, windowsHide: true, encoding: 'latin1' }, (err, out) => {
      const m = out.match(/(?:time|время)[=<]\s*([\d.,]+)\s*m?s/i) ?? out.match(/=\s*(\d+)\s*\S*\s+TTL/i);
      if (!err && /TTL=/i.test(out)) resolve({ ok: true, ms: m ? Math.round(parseFloat(m[1].replace(',', '.'))) : undefined });
      else resolve({ ok: false, detail: 'нет ответа на ping' });
    });
  });
}

async function checkOne(project: ProjectRef, t: ProdTarget): Promise<PingResult> {
  const kind = kindOf(t.target);
  let r: { ok: boolean; ms?: number; status?: number; detail?: string };
  let days: number | undefined;
  try {
    if (kind === 'http') [r, days] = await Promise.all([checkHttp(t.target), certDays(t.target)]);
    else if (kind === 'tcp') r = await checkTcp(t.target);
    else r = await checkIcmp(t.target);
  } catch (e: any) {
    r = { ok: false, detail: e?.cause?.code ?? e?.message ?? String(e) };
  }
  const prev = results.get(t.id);
  const at = Date.now();
  const res: PingResult = {
    targetId: t.id,
    project: project.path,
    target: t.target,
    name: t.name,
    kind,
    ...r,
    at,
    certDays: days,
    history: [...(prev?.history ?? []), { ok: r.ok, at, ms: r.ms }].slice(-HISTORY),
    failStreak: r.ok ? 0 : (prev?.failStreak ?? 0) + 1,
  };
  results.set(t.id, res);
  report(project, res);
  return res;
}

function report(project: ProjectRef, r: PingResult) {
  const label = r.name || r.target;
  if (r.failStreak >= FAILS_TO_ALERT)
    problems.report({
      source: 'ping',
      severity: 'error',
      title: `${label} не отвечает (${project.name})`,
      detail: `${r.target}: ${r.detail ?? 'ошибка'} — ${r.failStreak} проверки подряд`,
      key: `ping|${r.targetId}`,
    });
  else if (r.ok) problems.resolve(`ping|${r.targetId}`);
  if (r.certDays !== undefined && r.certDays < CERT_WARN_DAYS)
    problems.report({
      source: 'ping',
      severity: r.certDays < 3 ? 'error' : 'warning',
      title: r.certDays < 0 ? `SSL-сертификат ${label} просрочен` : `SSL-сертификат ${label} истекает через ${r.certDays} дн.`,
      detail: r.target,
      key: `pingcert|${r.targetId}`,
    });
  else problems.resolve(`pingcert|${r.targetId}`);
}

function publish() {
  emit({ type: 'ping', results: list() });
}

export function list(): PingResult[] {
  const ids = new Set(stateFile.data.projects.flatMap((p) => (p.domains ?? []).map((d) => d.id)));
  for (const id of results.keys()) if (!ids.has(id)) results.delete(id);
  return [...results.values()];
}

/** Checks a project's targets now (or all projects). */
export async function pingNow(projectPath?: string) {
  const projects = stateFile.data.projects.filter((p) => !projectPath || p.path === projectPath);
  await Promise.all(
    projects.map(async (p) => {
      lastRun.set(p.path, Date.now());
      await Promise.all((p.domains ?? []).map((t) => checkOne(p, t)));
    }),
  );
  publish();
  return list();
}

export function startPing() {
  timer = setInterval(() => {
    for (const p of stateFile.data.projects) {
      if (!p.domains?.length) continue;
      const every = (p.pingMinutes ?? 5) * 60_000;
      if (Date.now() - (lastRun.get(p.path) ?? 0) >= every) void pingNow(p.path);
    }
  }, 15_000);
  setTimeout(() => void pingNow(), 5000);
}

export function stopPing() {
  if (timer) clearInterval(timer);
}
