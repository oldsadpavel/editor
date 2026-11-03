import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentId, ChatStatus, FileEdit, SessionInfo, Turn, TurnItemText, TurnItemThinking, TurnItemTool } from '../shared/types';
import { AGENT_NAMES, spawnAgent } from './agents';
import { dataDir } from './store';
import type { TurnBuilder } from './transcript';

/**
 * Chats with agents other than Claude Code. Every question starts the agent headless (resuming its own session) and
 * its event stream is turned into the same turn items Claude's answers have: text, reasoning, tool calls with output,
 * edited files, tokens. The agents keep their own history; the editor keeps the turns it showed in
 * <data>/agent-chats/<id>.json, so the chat reopens the way it looked.
 */

export interface AgentChat {
  id: string;
  cwd: string;
  agent: AgentId;
  /** The agent's own session / thread id (to resume it). */
  agentSession?: string;
  model?: string;
  permissionMode?: string;
  autoApprove: boolean;
  title: string;
  builder: TurnBuilder;
  status: ChatStatus;
  agentProc: ChildProcess | null;
  interrupting: boolean;
  publish(now?: boolean): void;
  setStatus(s: ChatStatus): void;
}

interface SavedAgentChat {
  agent: AgentId;
  agentSession?: string;
  cwd: string;
  title: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  turns: Turn[];
}

const dir = () => {
  const d = path.join(dataDir(), 'agent-chats');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const fileOf = (id: string) => path.join(dir(), `${id}.json`);

export function loadAgentChat(id: string): SavedAgentChat | null {
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
  } catch {
    return null;
  }
}

export function saveAgentChat(c: AgentChat) {
  const prev = loadAgentChat(c.id);
  const turns = c.builder.turns.map((t) => ({ ...t, live: false }));
  const data: SavedAgentChat = { agent: c.agent, agentSession: c.agentSession, cwd: c.cwd, title: c.title, model: c.model, createdAt: prev?.createdAt ?? Date.now(), updatedAt: Date.now(), turns };
  fs.writeFileSync(fileOf(c.id), JSON.stringify(data));
}

/** Agent chats of a project, for «История». */
export function listAgentChats(cwd: string): (SessionInfo & { agent: AgentId })[] {
  const same = (a: string) => path.resolve(a).toLowerCase() === path.resolve(cwd).toLowerCase();
  const out: (SessionInfo & { agent: AgentId })[] = [];
  for (const f of fs.readdirSync(dir())) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(dir(), f), 'utf8');
      const head = JSON.parse(raw) as SavedAgentChat;
      if (!same(head.cwd)) continue;
      out.push({ sessionId: f.slice(0, -5), cwd: head.cwd, title: `${head.title}`, lastModified: head.updatedAt, createdAt: head.createdAt, agent: head.agent });
    } catch {
      /* broken file */
    }
  }
  return out;
}

export function renameAgentChat(id: string, title: string) {
  const d = loadAgentChat(id);
  if (!d) return;
  d.title = title;
  fs.writeFileSync(fileOf(id), JSON.stringify(d));
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const short = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function addEdit(turn: Turn, file: string, write: boolean) {
  if (!file) return;
  const at = Date.now();
  const ex = turn.edits.find((e) => e.path.toLowerCase() === file.toLowerCase());
  if (ex) {
    ex.count += write ? 0 : 1;
    ex.writes += write ? 1 : 0;
    ex.lastAt = at;
  } else turn.edits.push({ path: file, count: write ? 0 : 1, writes: write ? 1 : 0, firstAt: at, lastAt: at } as FileEdit);
}

/** Kills the agent with its children (codex runs a native binary under node). */
function kill(p: ChildProcess) {
  if (!p.pid || p.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/T', '/F', '/PID', String(p.pid)], { windowsHide: true, stdio: 'ignore' });
  else p.kill('SIGTERM');
}

export function stopAgent(c: AgentChat) {
  if (!c.agentProc) return;
  c.interrupting = true;
  kill(c.agentProc);
}

/** Runs one question through the chat's agent; `turn` is the turn already started for it. */
export function runAgentTurn(c: AgentChat, prompt: string, turn: Turn, images: string[], onEnd: (error?: string) => void) {
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(c.cwd, p));
  const tools = new Map<string, TurnItemTool>();
  const texts = new Map<string, TurnItemText | TurnItemThinking>();
  let failure: string | undefined;
  let errTail = '';
  const plan = c.permissionMode === 'plan';
  const label = c.model || AGENT_NAMES[c.agent];
  turn.models = [label];

  const tool = (id: string, name: string, summary: string): TurnItemTool => {
    let t = tools.get(id);
    if (!t) {
      t = { kind: 'tool', id, name, summary: short(summary) };
      tools.set(id, t);
      turn.items.push(t);
    }
    return t;
  };
  const textItem = (id: string, kind: 'text' | 'thinking' = 'text') => {
    let t = texts.get(id);
    if (!t) {
      t = { kind, text: '' } as TurnItemText | TurnItemThinking;
      texts.set(id, t);
      turn.items.push(t);
    }
    return t;
  };
  const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => {
    const t = (turn.tokens ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    t.input += input;
    t.output += output;
    t.cacheRead += cacheRead;
    t.cacheWrite += cacheWrite;
    (turn.tokenLog ??= []).push({ at: Date.now(), model: label, input, output, cacheRead, cacheWrite });
  };

  let args: string[] = [];
  let stdin: string | null = null;
  if (c.agent === 'codex') {
    const access = c.autoApprove ? ['--dangerously-bypass-approvals-and-sandbox'] : ['-c', `sandbox_mode="${plan ? 'read-only' : 'workspace-write'}"`];
    const common = ['--json', '--skip-git-repo-check', ...(c.model ? ['-m', c.model] : []), ...access, ...images.flatMap((f) => ['-i', f]), '-'];
    args = c.agentSession ? ['exec', 'resume', c.agentSession, ...common] : ['exec', ...common];
    stdin = prompt;
  } else if (c.agent === 'gemini') {
    if (!c.agentSession) c.agentSession = randomUUID();
    const first = !turn.id || c.builder.turns.length <= 1;
    args = ['-p', prompt, '-o', 'stream-json', '--skip-trust', '--approval-mode', c.autoApprove ? 'yolo' : plan ? 'plan' : 'auto_edit', ...(c.model ? ['-m', c.model] : []), ...(first ? ['--session-id', c.agentSession] : ['--resume', c.agentSession])];
  } else if (c.agent === 'opencode') {
    args = ['run', '--format', 'json', ...(c.model ? ['-m', c.model] : []), ...(c.agentSession ? ['-s', c.agentSession] : []), ...(c.autoApprove ? ['--auto'] : []), ...(plan ? ['--agent', 'plan'] : []), ...images.flatMap((f) => ['-f', f]), prompt];
  } else if (c.agent === 'aider') {
    c.agentSession ??= c.id;
    const hist = path.join(dir(), `${c.id}.aider.md`);
    args = ['--message', prompt, '--yes-always', '--no-pretty', '--no-stream', '--no-auto-commits', '--no-gitignore', '--no-check-update', '--no-analytics', '--no-show-model-warnings', '--no-fancy-input', '--chat-history-file', hist, '--input-history-file', path.join(dir(), `${c.id}.aider.input`), '--restore-chat-history', ...(plan ? ['--chat-mode', 'ask'] : []), ...(c.model ? ['--model', c.model] : [])];
  }

  let p: ChildProcess;
  try {
    p = spawnAgent(c.agent, args, c.cwd);
  } catch (e: any) {
    onEnd(e.message);
    return;
  }
  c.agentProc = p;
  if (stdin !== null) p.stdin!.end(stdin);
  else p.stdin!.end();

  const handle = (ev: any) => {
    const sid = ev.thread_id ?? ev.sessionID ?? ev.session_id;
    if (sid && (ev.type === 'thread.started' || ev.type === 'init' || !c.agentSession)) c.agentSession = sid;
    if (c.agent === 'codex') {
      const it = ev.item;
      if (it) {
        const done = ev.type === 'item.completed';
        if (it.type === 'agent_message') textItem(it.id).text = it.text ?? '';
        else if (it.type === 'reasoning') textItem(it.id, 'thinking').text = it.text ?? '';
        else if (it.type === 'command_execution') {
          const t = tool(it.id, 'Bash', it.command ?? '');
          t.detail = it.command;
          t.output = strip(it.aggregated_output ?? '').slice(-20_000);
          t.done = done || it.status !== 'in_progress';
          t.error = typeof it.exit_code === 'number' && it.exit_code !== 0;
          if (t.error) t.errorText = t.output.slice(-2000);
        } else if (it.type === 'file_change') {
          const files: string[] = (it.changes ?? []).map((x: any) => abs(x.path));
          const t = tool(it.id, 'Edit', files.map((f) => path.basename(f)).join(', '));
          t.path = files[0];
          t.detail = (it.changes ?? []).map((x: any) => `${x.kind ?? 'update'}: ${x.path}`).join('\n');
          t.done = done;
          t.error = it.status === 'failed';
          if (done && !t.error) for (const x of it.changes ?? []) addEdit(turn, abs(x.path), x.kind === 'add');
        } else if (it.type === 'mcp_tool_call') {
          const t = tool(it.id, `${it.server ?? 'mcp'}.${it.tool ?? ''}`, JSON.stringify(it.arguments ?? '').slice(0, 120));
          t.done = done;
          t.error = it.status === 'failed';
        } else if (it.type === 'web_search') {
          const t = tool(it.id, 'WebSearch', it.query ?? '');
          t.done = done;
        } else if (it.type === 'todo_list') {
          turn.todos = (it.items ?? []).map((x: any) => ({ content: x.text, status: x.completed ? 'completed' : 'pending' }));
        } else if (it.type === 'error' && !/Falling back/i.test(it.message ?? '')) failure = it.message;
      }
      if (ev.type === 'turn.completed' && ev.usage) tokens(ev.usage.input_tokens ?? 0, ev.usage.output_tokens ?? 0, ev.usage.cached_input_tokens ?? 0);
      if (ev.type === 'turn.failed') failure = ev.error?.message ?? 'Ответ не удался';
      if (ev.type === 'error' && !/^Reconnecting/i.test(ev.message ?? '')) failure = ev.message;
    } else if (c.agent === 'gemini') {
      if (ev.type === 'message' && ev.role === 'assistant') {
        const key = `m${tools.size}`;
        const t = textItem(key);
        t.text = ev.delta ? t.text + (ev.content ?? '') : (ev.content ?? t.text);
      } else if (ev.type === 'thought' || (ev.type === 'message' && ev.role === 'thought')) {
        const t = textItem(`th${tools.size}`, 'thinking');
        t.text += ev.content ?? ev.subject ?? '';
      } else if (ev.type === 'tool_use') {
        const prm = ev.parameters ?? {};
        const file = prm.file_path ?? prm.absolute_path ?? prm.path;
        const t = tool(ev.tool_id ?? randomUUID(), ev.tool_name ?? 'tool', file ?? prm.command ?? prm.pattern ?? JSON.stringify(prm).slice(0, 120));
        t.detail = JSON.stringify(prm, null, 1).slice(0, 4000);
        if (file) t.path = abs(file);
      } else if (ev.type === 'tool_result') {
        const t = tools.get(ev.tool_id);
        if (t) {
          t.done = true;
          t.output = strip(typeof ev.output === 'string' ? ev.output : JSON.stringify(ev.output ?? '')).slice(-20_000);
          t.error = ev.status === 'error';
          if (t.error) t.errorText = ev.error?.message ?? t.output;
          if (!t.error && t.path && /write|replace|edit/i.test(t.name)) addEdit(turn, t.path, /write/i.test(t.name));
        }
      } else if (ev.type === 'error') failure = ev.message ?? 'Ошибка Gemini';
      else if (ev.type === 'result') {
        const st = ev.stats ?? {};
        tokens(st.input_tokens ?? st.prompt_tokens ?? 0, st.output_tokens ?? st.candidates_tokens ?? 0, st.cached ?? st.cached_tokens ?? 0);
        if (ev.status === 'error') failure = ev.error?.message ?? failure ?? 'Ответ не удался';
      }
    } else if (c.agent === 'opencode') {
      const part = ev.part ?? {};
      if (ev.type === 'text') textItem(part.id ?? randomUUID()).text = part.text ?? '';
      else if (ev.type === 'reasoning') textItem(part.id ?? randomUUID(), 'thinking').text = part.text ?? '';
      else if (ev.type === 'tool_use') {
        const st = part.state ?? {};
        const inp = st.input ?? {};
        const name = String(part.tool ?? 'tool');
        const file = inp.filePath ?? inp.path;
        const t = tool(part.callID ?? part.id ?? randomUUID(), name[0].toUpperCase() + name.slice(1), file ? path.basename(file) : (inp.command ?? inp.pattern ?? st.title ?? ''));
        t.detail = JSON.stringify(inp, null, 1).slice(0, 4000);
        if (file) t.path = abs(file);
        t.done = st.status === 'completed' || st.status === 'error';
        t.error = st.status === 'error';
        t.output = strip(String(st.output ?? st.error ?? '')).slice(-20_000);
        if (t.error) t.errorText = String(st.error ?? t.output);
        if (st.status === 'completed' && file && /^(edit|write|patch|multiedit)$/i.test(name)) addEdit(turn, abs(file), /^write$/i.test(name));
      } else if (ev.type === 'step_finish' && part.tokens) {
        const tk = part.tokens;
        tokens(tk.input ?? 0, (tk.output ?? 0) + (tk.reasoning ?? 0), tk.cache?.read ?? 0, tk.cache?.write ?? 0);
      } else if (ev.type === 'error') failure = ev.error?.data?.message ?? ev.error?.message ?? ev.error?.name ?? 'Ошибка OpenCode';
    }
    turn.answeredAt = Date.now();
    c.publish();
  };

  // aider prints plain text: the whole output is the answer
  const plain = c.agent === 'aider' ? textItem('out') : null;
  let buf = '';
  p.stdout!.on('data', (d: Buffer) => {
    if (plain) {
      plain.text = strip(plain.text + d.toString());
      turn.answeredAt = Date.now();
      c.publish();
      return;
    }
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        /* not an event */
      }
    }
  });
  p.stderr!.on('data', (d: Buffer) => {
    errTail = (errTail + strip(d.toString())).slice(-3000);
  });
  p.on('error', (e) => onEnd(e.message));
  p.on('close', (code) => {
    c.agentProc = null;
    for (const t of tools.values()) t.done = true;
    if (c.interrupting) {
      c.interrupting = false;
      onEnd(undefined);
      return;
    }
    if (!failure && code !== 0) failure = errTail.trim().split(/\r?\n/).filter(Boolean).slice(-6).join('\n') || `${AGENT_NAMES[c.agent]} завершился с кодом ${code}`;
    if (!failure && !turn.items.length) failure = errTail.trim() ? errTail.trim().split(/\r?\n/).slice(-6).join('\n') : 'Агент ничего не ответил';
    onEnd(failure);
  });
}
