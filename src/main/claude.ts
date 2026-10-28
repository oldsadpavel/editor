import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query, listSessions, renameSession, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AuthStatus, ChatSnapshot, ChatStatus, PermissionAnswer, PermissionRequest, SessionInfo } from '../shared/types';
import { emit } from './bus';
import * as problems from './problems';
import { stateFile } from './store';
import { TurnBuilder, findTranscript, loadTranscript } from './transcript';
import { EDITOR_INSTRUCTIONS, editorMcp } from './editor-mcp';

/** Prefers the user's installed Claude Code so login, settings and version match the terminal. */
export function claudeExecutable(): string | undefined {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', exe),
    ...(process.env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, exe)),
  ];
  return candidates.find((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  });
}

export function authStatus(): Promise<AuthStatus> {
  const cli = claudeExecutable();
  if (!cli) return Promise.resolve({ loggedIn: false, error: 'Claude Code не найден. Установите: https://claude.com/claude-code' });
  return new Promise((resolve) => {
    execFile(cli, ['auth', 'status'], { timeout: 20000, windowsHide: true }, (err, stdout) => {
      try {
        const j = JSON.parse(stdout);
        resolve({ loggedIn: !!j.loggedIn, email: j.email, method: j.authMethod, orgName: j.orgName, cliPath: cli });
      } catch {
        resolve({ loggedIn: false, cliPath: cli, error: err?.message ?? 'Не удалось прочитать статус входа' });
      }
    });
  });
}

/** Opens the browser OAuth login of Claude Code (claude.ai account, no API key needed). */
export function login(): Promise<AuthStatus> {
  const cli = claudeExecutable();
  if (!cli) return authStatus();
  return new Promise((resolve) => {
    execFile(cli, ['auth', 'login'], { timeout: 5 * 60_000 }, () => resolve(authStatus()));
  });
}

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter: ((v: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(m: SDKUserMessage) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: m, done: false });
    } else this.items.push(m);
  }

  close() {
    this.closed = true;
    this.waiter?.({ value: undefined as any, done: true });
    this.waiter = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise((r) => (this.waiter = r));
      },
    };
  }
}

interface PendingPermission {
  req: PermissionRequest;
  suggestions?: any[];
  resolve: (r: any) => void;
}

class ChatSession {
  builder = new TurnBuilder();
  status: ChatStatus = 'idle';
  partial = '';
  title = 'Новый чат';
  permissionMode?: string;
  q: Query | null = null;
  input: InputQueue | null = null;
  pending = new Map<string, PendingPermission>();
  existsOnDisk = false;
  private emitTimer: NodeJS.Timeout | null = null;

  constructor(public id: string, public cwd: string) {}

  snapshot(): ChatSnapshot {
    return {
      sessionId: this.id,
      cwd: this.cwd,
      title: this.title,
      status: this.status,
      turns: this.builder.turns,
      partial: this.partial || undefined,
      permissionMode: this.permissionMode,
      pending: [...this.pending.values()].map((p) => p.req),
    };
  }

  publish(now = false) {
    if (now) {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = null;
      emit({ type: 'chat', snapshot: this.snapshot() });
      return;
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      emit({ type: 'chat', snapshot: this.snapshot() });
    }, 80);
  }

  setStatus(s: ChatStatus) {
    this.status = s;
    this.publish(true);
  }
}

const sessions = new Map<string, ChatSession>();

export function getBuilder(sessionId: string) {
  return sessions.get(sessionId)?.builder;
}

export function runningSessions() {
  return [...sessions.values()].filter((s) => s.status === 'running' || s.status === 'waiting').map((s) => s.id);
}

export async function listProjectSessions(cwd: string): Promise<SessionInfo[]> {
  const list = await listSessions({ dir: cwd, includeWorktrees: false, includeProgrammatic: true });
  const out: SessionInfo[] = list.map((s) => ({
    sessionId: s.sessionId,
    cwd: s.cwd ?? cwd,
    title: s.customTitle || s.summary || s.firstPrompt || s.sessionId,
    lastModified: s.lastModified,
    createdAt: s.createdAt,
    gitBranch: s.gitBranch,
  }));
  // Chats created here but not yet written to disk still belong in the list.
  for (const s of sessions.values()) {
    if (!out.some((o) => o.sessionId === s.id) && samePath(s.cwd, cwd)) {
      out.push({ sessionId: s.id, cwd: s.cwd, title: s.title, lastModified: Date.now() });
    }
  }
  return out.sort((a, b) => b.lastModified - a.lastModified);
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export async function openChat(sessionId: string, cwdHint?: string): Promise<ChatSnapshot> {
  let s = sessions.get(sessionId);
  if (s) return s.snapshot();
  const file = findTranscript(sessionId);
  s = new ChatSession(sessionId, cwdHint ?? os.homedir());
  if (file) {
    const { builder, cwd } = await loadTranscript(file);
    s.builder = builder;
    if (cwd) s.cwd = cwd;
    s.existsOnDisk = true;
    try {
      const info = (await listSessions({ dir: s.cwd, includeWorktrees: false })).find((x) => x.sessionId === sessionId);
      if (info) s.title = info.customTitle || info.summary || info.firstPrompt || s.title;
    } catch {
      /* title stays default */
    }
  }
  sessions.set(sessionId, s);
  return s.snapshot();
}

export function newChat(cwd: string): ChatSnapshot {
  const s = new ChatSession(randomUUID(), cwd);
  sessions.set(s.id, s);
  return s.snapshot();
}

export async function rename(sessionId: string, title: string) {
  const s = sessions.get(sessionId);
  if (s) {
    s.title = title;
    s.publish(true);
  }
  // Written to Claude Code's own transcript, so the name also shows in `claude --resume` and the IDE plugins.
  if (findTranscript(sessionId)) await renameSession(sessionId, title, s ? { dir: s.cwd } : undefined);
}

function markCompleted(s: ChatSession, error?: string) {
  const meta = (stateFile.data.chatMeta[s.id] ??= {});
  meta.completedAt = Date.now();
  meta.lastError = error;
  stateFile.save();
  emit({ type: 'chatMeta', sessionId: s.id, meta });
  emit({ type: 'sessionsChanged', cwd: s.cwd });
}

export async function send(sessionId: string, text: string, permissionMode?: string) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Чат не открыт');
  if (permissionMode) s.permissionMode = permissionMode;
  const turn = s.builder.startTurn(text, Date.now(), randomUUID());
  turn.live = true;
  if (s.title === 'Новый чат') s.title = text.slice(0, 60);
  s.partial = '';
  s.setStatus('running');
  if (!s.q) start(s);
  else if (permissionMode) await s.q.setPermissionMode(permissionMode as any).catch(() => {});
  s.input!.push({
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: s.id,
  } as SDKUserMessage);
}

function start(s: ChatSession) {
  s.input = new InputQueue();
  const resume = s.existsOnDisk || !!findTranscript(s.id);
  s.q = query({
    prompt: s.input,
    options: {
      cwd: s.cwd,
      ...(resume ? { resume: s.id } : { sessionId: s.id }),
      pathToClaudeCodeExecutable: claudeExecutable(),
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: EDITOR_INSTRUCTIONS },
      mcpServers: { editor: editorMcp(s.id, s.cwd) },
      allowedTools: ['mcp__editor'],
      ...(s.permissionMode ? { permissionMode: s.permissionMode as any } : {}),
      ...(s.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: (toolName: string, input: Record<string, unknown>, opts: any) => askPermission(s, toolName, input, opts),
      stderr: (data: string) => {
        if (/error|fatal/i.test(data)) console.error('[claude]', data.trim());
      },
    } as any,
  });
  s.existsOnDisk = true;
  void pump(s);
}

async function pump(s: ChatSession) {
  const q = s.q!;
  try {
    for await (const m of q) handleMessage(s, m);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    failTurn(s, msg);
  } finally {
    if (s.q === q) {
      s.q = null;
      s.input = null;
      s.builder.markInterrupted();
      if (s.status === 'running' || s.status === 'waiting') s.setStatus('idle');
    }
  }
}

function failTurn(s: ChatSession, msg: string) {
  const turn = s.builder.turns[s.builder.turns.length - 1];
  if (turn) {
    turn.error = msg;
    turn.live = false;
  }
  s.partial = '';
  s.setStatus('error');
  markCompleted(s, msg);
  problems.report({ source: 'chat', severity: 'error', title: `Чат «${s.title}»: ошибка`, detail: msg, sessionId: s.id });
}

function handleMessage(s: ChatSession, m: SDKMessage) {
  const now = new Date().toISOString();
  switch (m.type) {
    case 'stream_event': {
      const ev: any = (m as any).event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && !(m as any).parent_tool_use_id) {
        s.partial += ev.delta.text;
        s.publish();
      }
      return;
    }
    case 'assistant': {
      if ((m as any).parent_tool_use_id) return; // subagent internals stay out of the main view
      s.partial = '';
      s.builder.ingest({ type: 'assistant', message: m.message, timestamp: now, uuid: m.uuid });
      s.publish();
      return;
    }
    case 'user': {
      if ((m as any).parent_tool_use_id) return;
      const content = (m as any).message?.content;
      if (Array.isArray(content) && content.some((b: any) => b.type === 'tool_result')) {
        s.builder.ingest({ type: 'user', message: { content: content.filter((b: any) => b.type === 'tool_result') }, timestamp: now });
        s.publish();
      }
      return;
    }
    case 'result': {
      const r: any = m;
      const turn = s.builder.turns[s.builder.turns.length - 1];
      if (turn) {
        turn.live = false;
        turn.costUsd = r.total_cost_usd;
        turn.answeredAt ??= Date.now();
      }
      s.partial = '';
      if (r.subtype !== 'success' || r.is_error) {
        const detail = r.errors?.join('\n') || r.result || r.subtype;
        failTurn(s, String(detail));
        return;
      }
      s.setStatus('idle');
      markCompleted(s);
      return;
    }
    case 'system': {
      const sm: any = m;
      if (sm.subtype === 'session_state_changed' && sm.state === 'requires_action') s.setStatus('waiting');
      if (sm.subtype === 'api_retry' && sm.attempt >= 3) {
        problems.report({
          source: 'chat',
          severity: 'warning',
          title: `Чат «${s.title}»: повторные попытки API`,
          detail: `Попытка ${sm.attempt}: ${sm.error ?? sm.error_status ?? ''}`,
          sessionId: s.id,
        });
      }
      return;
    }
    case 'auth_status' as any: {
      const a: any = m;
      if (a.error) problems.report({ source: 'auth', severity: 'error', title: 'Ошибка авторизации Claude', detail: String(a.error) });
      return;
    }
    case 'rate_limit_event' as any: {
      const r: any = m;
      const info = r.rate_limit_info ?? r;
      if (info?.status === 'rejected' || info?.status === 'allowed_warning') {
        problems.report({
          source: 'auth',
          severity: info.status === 'rejected' ? 'error' : 'warning',
          title: info.status === 'rejected' ? 'Лимит Claude исчерпан' : 'Скоро упрётесь в лимит Claude',
          detail: info.resetsAt ? `Сброс: ${new Date(info.resetsAt * 1000).toLocaleString('ru-RU')}` : undefined,
          key: 'auth|ratelimit',
        });
      }
      return;
    }
  }
}

function askPermission(s: ChatSession, toolName: string, input: Record<string, unknown>, opts: any): Promise<any> {
  const id = randomUUID();
  const req: PermissionRequest = {
    id,
    sessionId: s.id,
    toolName,
    input,
    title: opts?.title ?? opts?.decisionReason,
    hasSuggestions: !!opts?.suggestions?.length,
  };
  return new Promise((resolve) => {
    s.pending.set(id, { req, suggestions: opts?.suggestions, resolve });
    s.setStatus('waiting');
    opts?.signal?.addEventListener('abort', () => {
      if (s.pending.delete(id)) s.publish(true);
    });
  });
}

export function answerPermission(sessionId: string, requestId: string, a: PermissionAnswer) {
  const s = sessions.get(sessionId);
  const p = s?.pending.get(requestId);
  if (!s || !p) return;
  s.pending.delete(requestId);
  if (a.behavior === 'allow') {
    p.resolve({
      behavior: 'allow',
      updatedInput: a.updatedInput ?? p.req.input,
      ...(a.always && p.suggestions ? { updatedPermissions: p.suggestions } : {}),
    });
  } else {
    p.resolve({ behavior: 'deny', message: a.message || 'Пользователь отклонил действие' });
  }
  s.setStatus(s.pending.size ? 'waiting' : 'running');
}

export async function interrupt(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s?.q) return;
  for (const [id] of s.pending) answerPermission(sessionId, id, { behavior: 'deny', message: 'Остановлено пользователем' });
  await s.q.interrupt().catch(() => {});
  const turn = s.builder.turns[s.builder.turns.length - 1];
  if (turn) turn.live = false;
  s.builder.markInterrupted();
  s.partial = '';
  s.setStatus('idle');
}

/** Ends the background Claude process of a chat that was closed in the UI (history stays on disk). */
export function closeChat(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.status === 'running' || s.status === 'waiting') return; // keep working in the background
  s.input?.close();
  s.q = null;
  sessions.delete(sessionId);
}

export function shutdown() {
  for (const s of sessions.values()) s.input?.close();
}
