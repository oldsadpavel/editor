import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Remote Control for a chat: an interactive `claude --resume <id> --remote-control` kept alive in a hidden
 * pseudo-terminal (winpty from Git for Windows). Only an interactive Claude opens the bridge to claude.ai, so this
 * is what makes the chat appear on the phone; the editor types into the same process through its stdin and shows
 * the transcript, so both sides see and drive the same session.
 */
export interface RemoteProc {
  child: ChildProcess;
  startedAt: number;
  /** Last TUI output (ANSI stripped) for diagnostics in /status. */
  tail: string;
  connected: boolean;
  exited?: number | null;
}

const TAIL_MAX = 8000;
const BRIDGE_TIMEOUT_MS = 40_000;

export function findWinpty(): string | null {
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'usr', 'bin', 'winpty.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'usr', 'bin', 'winpty.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'usr', 'bin', 'winpty.exe'),
    ...(process.env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, 'winpty.exe')),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

/** Environment for the child: inherited markers of a parent Claude session would switch transcript saving off. */
function childEnv() {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('CLAUDE_CODE') && k !== 'CLAUDECODE') env[k] = v;
  return { ...env, TERM: 'xterm-256color', COLUMNS: '120', LINES: '40' };
}

export function start(opts: { cli: string; sessionId: string; cwd: string; name: string; permissionMode?: string; model?: string; transcript: string | null }): RemoteProc {
  if (process.platform !== 'win32') throw new Error('Удалённый режим пока только для Windows');
  const winpty = findWinpty();
  if (!winpty) throw new Error('Нужен Git for Windows (winpty.exe из его состава): установите Git с https://git-scm.com');
  const args = ['-Xallow-non-tty', '-Xplain', '--', opts.cli, '--resume', opts.sessionId, '--remote-control', opts.name];
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.model) args.push('--model', opts.model);
  const child = spawn(winpty, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: childEnv() });
  const proc: RemoteProc = { child, startedAt: Date.now(), tail: '', connected: false };
  let bypassAnswered = false;
  const onData = (d: Buffer) => {
    proc.tail = (proc.tail + stripAnsi(d.toString())).slice(-TAIL_MAX);
    if (!proc.connected && /remote-control is active|claude\.ai\/code\/session_/.test(proc.tail)) proc.connected = true;
    // bypassPermissions asks for a one-time confirmation in the TUI ("No, exit / Yes, I accept"): choose Yes.
    if (!bypassAnswered && /Bypass Permissions mode[\s\S]*Yes, I accept/.test(proc.tail)) {
      bypassAnswered = true;
      child.stdin?.write('\x1b[B');
      setTimeout(() => child.stdin?.write('\r'), 200);
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('exit', (code) => (proc.exited = code));
  // The transcript's bridge-session record is the authoritative "connected" signal.
  if (opts.transcript) {
    const file = opts.transcript;
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (proc.connected || proc.exited !== undefined || Date.now() - t0 > BRIDGE_TIMEOUT_MS) return clearInterval(timer);
      try {
        if (fs.readFileSync(file, 'utf8').includes('"bridge-session"')) proc.connected = true;
      } catch {
        /* not yet */
      }
    }, 1500);
  }
  return proc;
}

/** Types a prompt into the TUI; multi-line text goes as a bracketed paste so newlines don't submit early. */
export function send(proc: RemoteProc, text: string) {
  const stdin = proc.child.stdin;
  if (!stdin || proc.exited !== undefined) throw new Error('Удалённый процесс Claude не запущен');
  const body = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
  stdin.write(body);
  setTimeout(() => stdin.write('\r'), 250);
}

export function interrupt(proc: RemoteProc) {
  proc.child.stdin?.write('\x1b');
}

export function stop(proc: RemoteProc) {
  try {
    proc.child.stdin?.write('\x03');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    if (proc.exited === undefined && proc.child.pid) spawn('taskkill', ['/T', '/F', '/PID', String(proc.child.pid)], { stdio: 'ignore', windowsHide: true });
  }, 700);
}

export function status(proc: RemoteProc | null | undefined): { state: 'off' | 'connecting' | 'connected' | 'exited'; detail?: string } {
  if (!proc) return { state: 'off' };
  if (proc.exited !== undefined) return { state: 'exited', detail: `процесс завершился (код ${proc.exited}). Хвост вывода: ${proc.tail.slice(-300).replace(/\s+/g, ' ')}` };
  if (proc.connected) return { state: 'connected', detail: proc.tail.match(/https:\/\/claude\.ai\/code\/session_\w+/)?.[0] };
  if (Date.now() - proc.startedAt > BRIDGE_TIMEOUT_MS) return { state: 'connecting', detail: 'мост не подтвердился за 40 с: ' + proc.tail.slice(-300).replace(/\s+/g, ' ') };
  return { state: 'connecting' };
}
