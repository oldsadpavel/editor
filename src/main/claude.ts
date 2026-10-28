import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query, listSessions, renameSession, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalEntry, AuthStatus, ChatSnapshot, ChatStatus, PermissionAnswer, PermissionRequest, SendOptions, SessionInfo } from '../shared/types';
import * as approvals from './approvals';
import { emit } from './bus';
import { IMAGE_EXT } from './files';
import * as problems from './problems';
import * as remote from './remote';
import { stateFile } from './store';
import { ATTACHMENTS_HEADER, TurnBuilder, findTranscript, loadTranscript } from './transcript';
import * as usage from './usage';
import { EDITOR_INSTRUCTIONS, editorMcp } from './editor-mcp';

/** Prefers the user's installed Claude Code so login, settings and version match the terminal. */
export function claudeExecutable(): string | undefined {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  // Apps started from Finder/Dock don't get the shell PATH, so the usual install locations are checked explicitly.
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', exe),
    path.join(os.homedir(), '.claude', 'local', exe),
    ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin/claude', '/usr/local/bin/claude']),
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
/**
 * Browser login of Claude Code. `method`: claude.ai subscription (default), Anthropic Console (API billing) or SSO.
 * The credentials are Claude Code's own, so the terminal and IDE plugins switch accounts too.
 */
export function login(method: 'claudeai' | 'console' | 'sso' = 'claudeai', email?: string): Promise<AuthStatus> {
  const cli = claudeExecutable();
  if (!cli) return authStatus();
  const args = ['auth', 'login', `--${method}`, ...(email ? ['--email', email] : [])];
  return new Promise((resolve) => {
    execFile(cli, args, { timeout: 5 * 60_000, windowsHide: true }, () => resolve(authStatus()));
  });
}

export function logout(): Promise<AuthStatus> {
  const cli = claudeExecutable();
  if (!cli) return authStatus();
  return new Promise((resolve) => {
    execFile(cli, ['auth', 'logout'], { timeout: 30_000, windowsHide: true }, () => resolve(authStatus()));
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
  model?: string;
  effort?: string;
  autoApprove = false;
  /** Remote Control: the session can also be continued from claude.ai/code and the Claude app. */
  remote = false;
  /** Restart the Claude process after the current turn (a startup-only option changed while busy). */
  restartPending = false;
  /** After a result, waiting to see whether Claude answers queued questions separately (see settleTurn). */
  awaitingQueued: NodeJS.Timeout | null = null;
  /** Transcript watcher while the hidden Remote Control process owns the session. */
  transcriptWatch: fs.FSWatcher | null = null;
  remoteProc: remote.RemoteProc | null = null;
  /** The `system/init` message of the running process: model, version, MCP servers, commands. */
  init: any = null;
  approvals: ApprovalEntry[] = [];
  /** Cumulative cost reported by the current Claude process (reset when a new process starts). */
  costSoFar = 0;
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
      model: this.model,
      effort: this.effort,
      autoApprove: this.autoApprove,
      remote: this.remote,
      approvals: this.approvals,
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
  const saved = stateFile.data.chatModels?.[sessionId];
  s.model = saved?.model;
  s.effort = saved?.effort;
  s.autoApprove = !!saved?.autoApprove;
  // The hidden remote process does not survive a restart; the switch starts fresh.
  s.remote = false;
  s.approvals = approvals.forChat(sessionId);
  sessions.set(sessionId, s);
  return s.snapshot();
}

export function newChat(cwd: string): ChatSnapshot {
  const s = new ChatSession(randomUUID(), cwd);
  s.model = stateFile.data.defaultModel;
  s.effort = stateFile.data.defaultEffort;
  s.autoApprove = !!stateFile.data.defaultAutoApprove;
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

const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_INLINE_IMAGE = 5 * 1024 * 1024;

/**
 * Message content for a prompt with attachments: images go inline (Claude sees them), and every attachment path is
 * listed under ATTACHMENTS_HEADER so Claude can open any file with Read and the transcript keeps the paths.
 */
function buildContent(text: string, attachments: string[]) {
  if (!attachments.length) return text;
  const blocks: any[] = [];
  for (const p of attachments) {
    const mime = IMAGE_MIME[path.extname(p).toLowerCase()];
    if (!mime) continue;
    try {
      if (fs.statSync(p).size > MAX_INLINE_IMAGE) continue;
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: fs.readFileSync(p).toString('base64') } });
    } catch {
      /* unreadable: still listed by path below */
    }
  }
  blocks.push({ type: 'text', text: `${text}\n\n${ATTACHMENTS_HEADER}\n${attachments.map((p) => `- ${p}`).join('\n')}` });
  return blocks;
}

function rememberChatModel(s: ChatSession) {
  stateFile.data.chatModels = { ...stateFile.data.chatModels, [s.id]: { model: s.model, effort: s.effort, autoApprove: s.autoApprove, remote: s.remote } };
  stateFile.save();
}

export async function send(sessionId: string, text: string, opts: SendOptions) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Чат не открыт');
  const attachments = opts.attachments ?? [];
  if (s.remote) {
    if (!s.remoteProc || s.remoteProc.exited !== undefined) throw new Error('Удалённый процесс Claude не запущен — выключите и снова включите /RC');
    if (attachments.some((p) => IMAGE_EXT.has(path.extname(p).slice(1).toLowerCase()))) throw new Error('В удалённом режиме картинки не прикрепить (только пути к файлам)');
    const body = attachments.length ? [text, '', ATTACHMENTS_HEADER, ...attachments.map((p) => `- ${p}`)].join('\n') : text;
    remote.send(s.remoteProc, body);
    const turn = s.builder.startTurn(text, Date.now(), randomUUID(), attachments.map((p) => ({ kind: 'file' as const, path: p })));
    turn.live = true;
    s.setStatus('running');
    return;
  }
  if (opts.permissionMode) s.permissionMode = opts.permissionMode;
  const modelChanged = (opts.model || undefined) !== s.model;
  const effortChanged = (opts.effort || undefined) !== s.effort;
  s.model = opts.model || undefined;
  s.effort = opts.effort || undefined;
  if (modelChanged || effortChanged) rememberChatModel(s);

  // A question sent while Claude is still answering joins the current turn (Claude Code answers them together).
  const turn = s.builder.startTurn(
    text,
    Date.now(),
    randomUUID(),
    attachments.map((p) => ({ kind: IMAGE_EXT.has(path.extname(p).slice(1).toLowerCase()) ? 'image' : 'file', path: p })),
  );
  turn.live = true;
  if (s.title === 'Новый чат') s.title = (text || path.basename(attachments[0] ?? '')).slice(0, 60);
  s.partial = '';
  s.setStatus('running');
  if (!s.q) start(s);
  else {
    // A running session switches model, effort and permission mode in place; history and context stay.
    if (opts.permissionMode) await s.q.setPermissionMode(opts.permissionMode as any).catch(() => {});
    if (modelChanged) await s.q.setModel(s.model).catch(() => {});
    if (effortChanged) await s.q.applyFlagSettings({ effortLevel: (s.effort as any) ?? null }).catch(() => {});
  }
  s.input!.push({
    type: 'user',
    message: { role: 'user', content: buildContent(text, attachments) },
    parent_tool_use_id: null,
    session_id: s.id,
  } as SDKUserMessage);
}

function start(s: ChatSession) {
  s.input = new InputQueue();
  s.costSoFar = 0;
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
      ...(s.model ? { model: s.model } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
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
      finishLiveTurns(s);
      if (s.status === 'running' || s.status === 'waiting') s.setStatus('idle');
      else s.publish(true);
    }
  }
}

/** The answer is complete: stop spinners, mark the chat done (unread), apply a pending restart. */
function settleTurn(s: ChatSession) {
  if (s.awaitingQueued) clearTimeout(s.awaitingQueued);
  s.awaitingQueued = null;
  finishLiveTurns(s);
  s.partial = '';
  if (s.status !== 'running' && s.status !== 'waiting') return;
  s.setStatus('idle');
  markCompleted(s);
  if (s.restartPending) {
    s.restartPending = false;
    stopProcess(s);
    if (s.remote) start(s);
  }
}

function finishLiveTurns(s: ChatSession) {
  s.builder.closeTurn();
  for (const t of s.builder.turns) {
    if (!t.live) continue;
    t.live = false;
    t.answeredAt ??= Date.now();
  }
}

function failTurn(s: ChatSession, msg: string) {
  const turn = s.builder.turns[s.builder.turns.length - 1];
  if (turn) turn.error = msg;
  finishLiveTurns(s);
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
      // Output after a result means Claude picked up a queued prompt on its own: that prompt gets its own turn,
      // and the chat is working again.
      const resumed = s.status === 'idle' || !!s.awaitingQueued;
      if (resumed) {
        if (s.awaitingQueued) clearTimeout(s.awaitingQueued);
        s.awaitingQueued = null;
        const prev = s.builder.turns[s.builder.turns.length - 1];
        const split = s.builder.splitQueued();
        if (split && prev) prev.live = false;
        const turn = split ?? prev;
        if (turn) turn.live = true;
      }
      s.builder.ingest({ type: 'assistant', message: m.message, timestamp: now, uuid: m.uuid });
      if (resumed && s.status !== 'running') s.setStatus('running');
      else s.publish();
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
        // total_cost_usd accumulates over the Claude process, so a turn costs the difference.
        if (typeof r.total_cost_usd === 'number') {
          turn.costUsd = Math.max(0, r.total_cost_usd - s.costSoFar);
          s.costSoFar = r.total_cost_usd;
        }
        turn.answeredAt ??= Date.now();
      }
      s.partial = '';
      if (r.subtype !== 'success' || r.is_error) {
        finishLiveTurns(s);
        const detail = r.errors?.join('\n') || r.result || r.subtype;
        failTurn(s, String(detail));
        return;
      }
      // A question queued into this turn may still get its own answer (Claude Code runs it next) or may already be
      // answered together with this one. Decide on the next assistant output or the SDK's 'idle'; a short timer
      // covers the case when neither arrives.
      if (turn?.more?.length) {
        s.builder.closeTurn();
        s.awaitingQueued = setTimeout(() => settleTurn(s), 3000);
        return;
      }
      settleTurn(s);
      return;
    }
    case 'system': {
      const sm: any = m;
      if (sm.subtype === 'init') s.init = sm;
      if (sm.subtype === 'session_state_changed') {
        if (sm.state === 'requires_action') s.setStatus('waiting');
        // 'idle' is the SDK's authoritative "turn is over" signal.
        if (sm.state === 'idle' && (s.status === 'running' || s.status === 'waiting') && !s.pending.size) settleTurn(s);
      }
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
      usage.onRateLimitEvent(info);
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

/** Questions to the user need an actual answer, so auto-approve never answers them. */
const NEEDS_USER = new Set(['AskUserQuestion']);

function logDecision(s: ChatSession, toolName: string, input: Record<string, unknown>, decision: ApprovalEntry['decision']) {
  const turnId = s.builder.turns[s.builder.turns.length - 1]?.id;
  const e: ApprovalEntry = { at: Date.now(), sessionId: s.id, turnId, tool: toolName, summary: approvals.summarize(toolName, input), decision };
  approvals.record(e);
  s.approvals.push(e);
}

function askPermission(s: ChatSession, toolName: string, input: Record<string, unknown>, opts: any): Promise<any> {
  if (s.autoApprove && !NEEDS_USER.has(toolName)) {
    logDecision(s, toolName, input, 'auto');
    s.publish();
    return Promise.resolve({ behavior: 'allow', updatedInput: input });
  }
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
  logDecision(s, p.req.toolName, p.req.input, a.behavior === 'deny' ? 'deny' : a.always ? 'always' : 'allow');
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

/** Turns auto-approve on/off for a chat; turning it on also approves what is already waiting. */
/** Stops the chat's Claude process; the next prompt (or restartIdle) resumes the same session in a new one. */
function stopProcess(s: ChatSession) {
  const input = s.input;
  s.q = null;
  s.input = null;
  s.init = null;
  input?.close();
}

/**
 * Remote Control: only an interactive `claude` opens the bridge to claude.ai, so the chat is handed to a hidden
 * interactive `claude --resume <id> --remote-control` (see remote.ts). The editor types into it and follows the
 * transcript, the phone talks to it through Claude's own bridge — both sides see and drive the same session.
 */
export function setRemote(sessionId: string, on: boolean) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (on) {
    if (s.status === 'running' || s.status === 'waiting') throw new Error('Дождитесь конца ответа или нажмите «Стоп», затем включите удалённый режим');
    const cli = claudeExecutable();
    if (!cli) throw new Error('Claude Code не найден');
    stopProcess(s);
    const name = s.title.replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 40) || 'Claude Editor';
    s.remoteProc = remote.start({
      cli,
      sessionId: s.id,
      cwd: s.cwd,
      name,
      permissionMode: s.autoApprove ? 'bypassPermissions' : s.permissionMode,
      model: s.model,
      transcript: findTranscript(s.id),
    });
    s.remote = true;
    s.setStatus('idle');
    watchTranscript(s);
  } else {
    s.remote = false;
    if (s.remoteProc) remote.stop(s.remoteProc);
    s.remoteProc = null;
    unwatchTranscript(s);
    const file = findTranscript(s.id);
    if (file)
      void loadTranscript(file).then(({ builder }) => {
        // Whatever was pending remotely is over: the next question starts its own turn in the SDK process.
        builder.closeTurn();
        s.builder = builder;
        finishLiveTurns(s);
        if (s.status === 'running') s.setStatus('idle');
        s.publish(true);
      });
  }
  rememberChatModel(s);
  s.publish(true);
}

export function remoteStatus(sessionId: string) {
  const s = sessions.get(sessionId);
  return s?.remote ? remote.status(s.remoteProc) : { state: 'off' as const };
}

/** While a terminal owns the session, the editor re-reads the transcript whenever it changes. */
function watchTranscript(s: ChatSession) {
  unwatchTranscript(s);
  const file = findTranscript(s.id);
  if (!file) return;
  let timer: NodeJS.Timeout | null = null;
  const reload = async () => {
    try {
      const { builder } = await loadTranscript(file);
      s.builder = builder;
      const last = builder.turns[builder.turns.length - 1];
      // A question (from here or the phone) without a finished answer keeps the chat "working".
      const open = !!last && builder.isTurnOpen();
      if (open) {
        last.live = true;
        if (s.status !== 'running') s.setStatus('running');
      } else if (s.status === 'running') {
        s.setStatus('idle');
        markCompleted(s);
      }
      s.publish(true);
    } catch {
      /* file being written */
    }
  };
  try {
    s.transcriptWatch = fs.watch(file, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(), 400);
    });
  } catch {
    /* transcript vanished */
  }
}

function unwatchTranscript(s: ChatSession) {
  s.transcriptWatch?.close();
  s.transcriptWatch = null;
}

/** Everything `/status` shows; live details only when the chat has a running process. */
export async function chatStatus(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Чат не открыт');
  const q = s.q;
  const [mcp, context, account] = await Promise.all([
    q ? q.mcpServerStatus().catch(() => null) : null,
    q ? q.getContextUsage().catch(() => null) : null,
    authStatus(),
  ]);
  return {
    sessionId: s.id,
    title: s.title,
    cwd: s.cwd,
    status: s.status,
    processRunning: !!q,
    model: s.init?.model ?? s.model ?? null,
    modelChoice: s.model ?? null,
    effort: s.effort ?? null,
    permissionMode: s.init?.permissionMode ?? s.permissionMode ?? null,
    autoApprove: s.autoApprove,
    remote: s.remote,
    remoteStatus: s.remote ? remote.status(s.remoteProc) : undefined,
    version: s.init?.claude_code_version ?? null,
    outputStyle: s.init?.output_style ?? null,
    tools: s.init?.tools?.length ?? null,
    mcp: ((mcp as any[]) ?? s.init?.mcp_servers ?? []).map((x: any) => ({ name: x.name, status: x.status })),
    context: context ? { used: (context as any).totalTokens, max: (context as any).maxTokens, percent: (context as any).percentage, categories: ((context as any).categories ?? []).filter((c: any) => c.tokens > 0).map((c: any) => ({ name: c.name, tokens: c.tokens })) } : null,
    account,
    turns: s.builder.turns.length,
    usage: usage.lastUsage(),
  };
}

/** Slash commands of the chat's session (from the running process), for the `/` menu. */
export async function chatCommands(sessionId: string): Promise<{ name: string; description: string; argumentHint?: string }[]> {
  const s = sessions.get(sessionId);
  if (s?.q) {
    const list = await s.q.supportedCommands().catch(() => null);
    if (list) return list.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }));
  }
  return (s?.init?.slash_commands ?? []).map((n: string) => ({ name: n, description: '' }));
}

export function setAutoApprove(sessionId: string, on: boolean) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.autoApprove = on;
  rememberChatModel(s);
  if (on) {
    for (const [id, p] of s.pending) {
      if (NEEDS_USER.has(p.req.toolName)) continue;
      s.pending.delete(id);
      logDecision(s, p.req.toolName, p.req.input, 'auto');
      p.resolve({ behavior: 'allow', updatedInput: p.req.input });
    }
    if (s.status === 'waiting' && !s.pending.size) s.status = 'running';
  }
  s.publish(true);
}

export async function interrupt(sessionId: string) {
  const s = sessions.get(sessionId);
  if (s?.remote && s.remoteProc) {
    remote.interrupt(s.remoteProc);
    finishLiveTurns(s);
    s.setStatus('idle');
    return;
  }
  if (!s?.q) return;
  for (const [id] of s.pending) answerPermission(sessionId, id, { behavior: 'deny', message: 'Остановлено пользователем' });
  await s.q.interrupt().catch(() => {});
  finishLiveTurns(s);
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
  unwatchTranscript(s);
  sessions.delete(sessionId);
}

export function shutdown() {
  for (const s of sessions.values()) {
    s.input?.close();
    if (s.remoteProc) remote.stop(s.remoteProc);
  }
}
