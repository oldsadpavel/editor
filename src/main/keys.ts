import { X509Certificate, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FoundKey, KeyScanResult, KeyStatus } from '../shared/types';
import { emit } from './bus';
import * as problems from './problems';
import { stateFile } from './store';

const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.idea', '.next', '.nuxt', 'release', '__pycache__', '.venv']);
const MAX_FILES_PER_ROOT = 30_000;
const MAX_FILE_SIZE = 512 * 1024;
const EXPIRING_DAYS = 14;

/** Converts a glob (`**`, `*`, `?`) matched against a root-relative path with `/` separators. */
function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

function walk(root: string, match: (rel: string) => boolean, out: string[]) {
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < MAX_FILES_PER_ROOT) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) || (e.name === '.claude')) stack.push(full);
        continue;
      }
      seen++;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (match(rel)) out.push(full);
    }
  }
}

const mask = (v: string) => (v.length <= 10 ? v.slice(0, 2) + '…' : `${v.slice(0, 4)}…${v.slice(-4)}`);

const PREFIXED: { kind: string; re: RegExp }[] = [
  { kind: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { kind: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { kind: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
];

const SECRET_NAME = /(key|token|secret|passw|pwd|auth|bearer|credential|api)/i;
const ASSIGN = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*[:=]\s*["']?([^"'\s#]{8,})/;

function parseDate(s: string): number | undefined {
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  return undefined;
}

/** A date written next to the key ("expires 2026-12-01", "действует до 01.12.2026"). */
function nearbyExpiry(lines: string[], i: number): number | undefined {
  for (const j of [i, i + 1, i - 1]) {
    const l = lines[j];
    if (l && /(expir|истека|истёк|действ\w* до|valid until|годен до|exp\b|до\s+\d)/i.test(l)) {
      const d = parseDate(l);
      if (d) return d;
    }
  }
  return undefined;
}

function jwtExpiry(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function statusFor(expiresAt?: number): KeyStatus {
  if (!expiresAt) return 'unknown';
  const now = Date.now();
  if (expiresAt < now) return 'expired';
  if (expiresAt < now + EXPIRING_DAYS * 86_400_000) return 'expiring';
  return 'valid';
}

function scanFile(file: string): FoundKey[] {
  let text: string;
  try {
    if (fs.statSync(file).size > MAX_FILE_SIZE) return [];
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const found: FoundKey[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  const add = (line: number, name: string, kind: string, value: string, expiresAt?: number, note?: string) => {
    const id = createHash('sha1').update(file + '|' + value).digest('hex').slice(0, 16);
    if (seen.has(id)) return;
    seen.add(id);
    found.push({ id, file, line: line + 1, name, kind, masked: mask(value), status: statusFor(expiresAt), expiresAt, note });
  };

  for (const block of text.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)) {
    const line = text.slice(0, block.index).split('\n').length - 1;
    try {
      const cert = new X509Certificate(block[0]);
      add(line, cert.subject.split('\n').find((s) => s.startsWith('CN=')) ?? 'certificate', 'Сертификат', cert.fingerprint256, Date.parse(cert.validTo));
    } catch {
      add(line, 'certificate', 'Сертификат', block[0].slice(30, 70), undefined, 'Не удалось разобрать');
    }
  }
  for (const block of text.matchAll(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g)) {
    const line = text.slice(0, block.index).split('\n').length - 1;
    add(line, path.basename(file), 'Приватный ключ', file + block.index, undefined, 'Срока действия нет');
  }

  lines.forEach((l, i) => {
    for (const { kind, re } of PREFIXED) {
      for (const m of l.matchAll(re)) {
        const name = l.match(ASSIGN)?.[1] ?? kind;
        const exp = kind === 'JWT' ? jwtExpiry(m[0]) : nearbyExpiry(lines, i);
        add(i, name, kind, m[0], exp);
      }
    }
    const a = l.match(ASSIGN);
    if (a && SECRET_NAME.test(a[1]) && !/^(true|false|null|none|\$\{)/i.test(a[2])) {
      const v = a[2];
      const kind = v.startsWith('eyJ') ? 'JWT' : 'Секрет';
      add(i, a[1], kind, v, kind === 'JWT' ? jwtExpiry(v) : nearbyExpiry(lines, i));
    }
  });
  return found;
}

/** GitHub reports token expiry in a response header; 401 means revoked or expired. */
async function checkGithubToken(file: string, k: FoundKey) {
  const text = fs.readFileSync(file, 'utf8');
  const token = text.split(/\r?\n/)[k.line - 1].match(/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/)?.[0];
  if (!token) return;
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'claude-editor' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) {
      k.status = 'invalid';
      k.note = 'GitHub: токен отозван или просрочен';
      return;
    }
    const exp = res.headers.get('github-authentication-token-expiration');
    if (exp) {
      k.expiresAt = Date.parse(exp.replace(' UTC', 'Z').replace(' ', 'T'));
      k.status = statusFor(k.expiresAt);
    } else if (res.ok) {
      k.status = 'valid';
      k.note = 'GitHub: без срока';
    }
  } catch {
    k.note = 'GitHub недоступен для проверки';
  }
}

let last: KeyScanResult | null = null;

export async function scanKeys(): Promise<KeyScanResult> {
  const patterns = stateFile.data.keyPatterns;
  const regexes = patterns.map(globToRegex);
  const roots = stateFile.data.projects.map((p) => p.path);
  const files: string[] = [];
  for (const root of roots) walk(root, (rel) => regexes.some((r) => r.test(rel)), files);
  const keys = files.flatMap(scanFile);
  await Promise.all(keys.filter((k) => k.kind === 'GitHub token').map((k) => checkGithubToken(k.file, k)));

  problems.resolve('keys|');
  for (const k of keys) {
    if (k.status === 'expired' || k.status === 'invalid' || k.status === 'expiring') {
      problems.report({
        source: 'keys',
        severity: k.status === 'expiring' ? 'warning' : 'error',
        title:
          k.status === 'expiring'
            ? `Ключ ${k.name} истекает ${new Date(k.expiresAt!).toLocaleDateString('ru-RU')}`
            : `Ключ ${k.name} ${k.status === 'invalid' ? 'недействителен' : 'просрочен'}`,
        detail: `${k.kind} · ${k.file}:${k.line}${k.note ? ' · ' + k.note : ''}`,
        path: k.file,
        key: `keys|${k.id}`,
      });
    }
  }
  last = { scannedAt: Date.now(), patterns, roots, filesScanned: files, keys };
  emit({ type: 'keys', result: last });
  return last;
}

export function lastScan() {
  return last;
}

export function setPatterns(patterns: string[]) {
  stateFile.data.keyPatterns = patterns.map((p) => p.trim()).filter(Boolean);
  stateFile.save();
}
