import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentId, AgentInfo, AgentModel } from '../shared/types';

/**
 * Coding agents other than Claude Code: found on this machine, their login state and models, and how to start them.
 * Each one runs headless per question (codex exec --json, gemini -p -o stream-json, opencode run --format json,
 * aider --message) — see agent-run.ts.
 */

export const AGENT_NAMES: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex (OpenAI)',
  gemini: 'Gemini CLI (Google)',
  opencode: 'OpenCode',
  aider: 'Aider',
};

const NPM_PACKAGES: Partial<Record<AgentId, string>> = { codex: '@openai/codex', gemini: '@google/gemini-cli', opencode: 'opencode-ai' };

let npmRoot: string | null | undefined;
/** Where `npm install -g` puts packages (the agents installed from npm live there). */
function globalNodeModules(): string | null {
  if (npmRoot !== undefined) return npmRoot;
  const guesses = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),
  ].filter((p): p is string => !!p && fs.existsSync(p));
  npmRoot = guesses[0] ?? null;
  return npmRoot;
}

/** The program and leading args that start an agent (npm scripts run with Electron's own Node), or null. */
export function agentCommand(id: AgentId): { file: string; args: string[]; env?: NodeJS.ProcessEnv } | null {
  const pkg = NPM_PACKAGES[id];
  const root = globalNodeModules();
  if (pkg && root) {
    const dir = path.join(root, pkg);
    try {
      const bin = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).bin;
      const rel = typeof bin === 'string' ? bin : Object.values(bin ?? {})[0];
      if (typeof rel === 'string') {
        const file = path.join(dir, rel);
        if (fs.existsSync(file)) {
          if (/\.(c|m)?js$/.test(file)) return { file: process.execPath, args: [file], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
          return { file, args: [] };
        }
      }
    } catch {
      /* not installed */
    }
  }
  if (id === 'aider') {
    const exe = process.platform === 'win32' ? 'aider.exe' : 'aider';
    for (const dir of [path.join(os.homedir(), '.local', 'bin'), ...(process.env.PATH ?? '').split(path.delimiter)]) {
      const f = path.join(dir, exe);
      if (dir && fs.existsSync(f)) return { file: f, args: [] };
    }
  }
  return null;
}

/** Starts an agent with the given arguments in a project folder. */
export function spawnAgent(id: AgentId, args: string[], cwd: string): ChildProcess {
  const cmd = agentCommand(id);
  if (!cmd) throw new Error(`${AGENT_NAMES[id]} не установлен`);
  return spawn(cmd.file, [...cmd.args, ...args], { cwd, env: cmd.env ?? process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Runs an agent to completion and returns what it printed (short commands: --version, login status, model lists). */
function runQuick(id: AgentId, args: string[], timeout = 20_000): Promise<string> {
  const cmd = agentCommand(id);
  if (!cmd) return Promise.resolve('');
  return new Promise((resolve) => {
    execFile(cmd.file, [...cmd.args, ...args], { env: cmd.env ?? process.env, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (_e, stdout, stderr) =>
      resolve(`${stdout ?? ''}${stderr ?? ''}`),
    );
  });
}

const GEMINI_MODELS: AgentModel[] = [
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
];
const AIDER_MODELS: AgentModel[] = [
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat' },
  { id: 'deepseek/deepseek-reasoner', name: 'DeepSeek Reasoner' },
];

async function models(id: AgentId): Promise<AgentModel[]> {
  if (id === 'codex') {
    try {
      const j = JSON.parse(await runQuick('codex', ['debug', 'models']));
      return (j.models ?? []).filter((m: any) => m.visibility === 'list').map((m: any) => ({ id: m.slug, name: m.display_name || m.slug }));
    } catch {
      return [];
    }
  }
  if (id === 'opencode') {
    const out = await runQuick('opencode', ['models'], 60_000);
    return out
      .split(/\r?\n/)
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
      .filter((l) => /^[\w.-]+\/[\w.:\-/]+$/.test(l))
      .map((l) => ({ id: l, name: l.replace(/^opencode\//, '').replace(/-free$/, ' (бесплатно)') }));
  }
  if (id === 'gemini') return GEMINI_MODELS;
  if (id === 'aider') return AIDER_MODELS;
  return [];
}

/** Logged in / has a key: what the agent needs before it can answer. */
async function readiness(id: AgentId): Promise<{ ready: boolean; status: string }> {
  if (id === 'codex') {
    const out = await runQuick('codex', ['login', 'status']);
    return /logged in/i.test(out) && !/not logged in/i.test(out) ? { ready: true, status: 'вход выполнен' } : { ready: false, status: 'нужен вход' };
  }
  if (id === 'gemini') {
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_USE_VERTEXAI || process.env.GOOGLE_GENAI_USE_GCA) return { ready: true, status: 'ключ в окружении' };
    try {
      const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.gemini', 'settings.json'), 'utf8'));
      if (s?.security?.auth?.selectedType || s?.selectedAuthType) return { ready: true, status: 'вход выполнен' };
    } catch {
      /* no settings yet */
    }
    return { ready: false, status: 'нужен вход' };
  }
  if (id === 'opencode') return { ready: true, status: 'бесплатные модели доступны без входа' };
  if (id === 'aider') {
    const keys = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'].some((k) => process.env[k]);
    const conf = fs.existsSync(aiderConfFile()) && /api-key|api_key/i.test(fs.readFileSync(aiderConfFile(), 'utf8'));
    return keys || conf ? { ready: true, status: 'ключ задан' } : { ready: false, status: 'нужен ключ (DeepSeek и др.)' };
  }
  return { ready: true, status: '' };
}

export const aiderConfFile = () => path.join(os.homedir(), '.aider.conf.yml');

const INSTALL: Partial<Record<AgentId, string>> = {
  codex: 'npm install -g @openai/codex',
  gemini: 'npm install -g @google/gemini-cli',
  opencode: 'npm install -g opencode-ai',
  aider: 'python -m pip install aider-install && aider-install',
};
const LOGIN: Partial<Record<AgentId, string>> = { codex: 'codex login', gemini: 'gemini', opencode: 'opencode auth login' };

let cache: { at: number; list: AgentInfo[] } | null = null;

/** All agents (Claude Code first): installed or not, ready or not, their models. Cached for 5 minutes. */
export async function listAgents(refresh = false): Promise<AgentInfo[]> {
  if (!refresh && cache && Date.now() - cache.at < 5 * 60_000) return cache.list;
  const ids: AgentId[] = ['codex', 'gemini', 'opencode', 'aider'];
  const list = await Promise.all(
    ids.map(async (id): Promise<AgentInfo> => {
      const installed = !!agentCommand(id);
      if (!installed) return { id, name: AGENT_NAMES[id], installed, ready: false, status: 'не установлен', models: [], install: INSTALL[id], login: LOGIN[id] };
      const [version, ready, ms] = await Promise.all([runQuick(id, ['--version']), readiness(id), models(id)]);
      return {
        id,
        name: AGENT_NAMES[id],
        installed,
        version: version.replace(/\x1b\[[0-9;]*m/g, '').trim().split(/\r?\n/)[0]?.replace(/^[^\d]*/, '') || undefined,
        ...ready,
        models: ms,
        install: INSTALL[id],
        login: LOGIN[id],
        ...(id === 'aider' ? { keysFile: aiderConfFile() } : {}),
      };
    }),
  );
  cache = { at: Date.now(), list };
  return list;
}

/** Installs an agent (npm / pip); returns the log. */
export function installAgent(id: AgentId): Promise<string> {
  const cmd = INSTALL[id];
  if (!cmd) return Promise.reject(new Error('Нечего устанавливать'));
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, windowsHide: true });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    child.on('close', (code) => {
      npmRoot = undefined;
      cache = null;
      if (code === 0) resolve(log.slice(-4000));
      else reject(new Error(`Установка не удалась (код ${code}):\n${log.slice(-2000)}`));
    });
  });
}

/** Login needs the agent's own interactive screen: it opens in a terminal window. */
export function openLogin(id: AgentId) {
  const cmd = LOGIN[id];
  if (!cmd) throw new Error('У этого агента нет входа — задайте ключ');
  cache = null;
  if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', 'MPI — вход', 'cmd', '/k', cmd], { detached: true, windowsHide: false });
  else if (process.platform === 'darwin') spawn('osascript', ['-e', `tell application "Terminal" to do script "${cmd}"`], { detached: true });
  else spawn('x-terminal-emulator', ['-e', cmd], { detached: true });
}
