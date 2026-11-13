import { shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forkSession, query, listSessions, renameSession, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentId, BgTask, CompactState, ShellRun } from '../shared/types';
import type { ChildProcess } from 'node:child_process';
import { AGENT_NAMES } from './agents';
import { listAgentChats, loadAgentChat, renameAgentChat, runAgentTurn, saveAgentChat, stopAgent } from './agent-run';
import type { ApprovalEntry, AuthStatus, ChatSnapshot, ChatStatus, PermissionAnswer, PermissionRequest, SendOptions, SessionInfo, TurnAttachment } from '../shared/types';
import * as approvals from './approvals';
import { emit } from './bus';
import { IMAGE_EXT } from './files';
import * as problems from './problems';
import * as remote from './remote';
import { dataDir, stateFile } from './store';
import * as taskbar from './taskbar';
import { ATTACHMENTS_HEADER, TurnBuilder, compactInfo, findTranscript, loadTranscript, readTranscriptInto } from './transcript';
import * as usage from './usage';
import { EDITOR_INSTRUCTIONS, chatAccess, editorMcp } from './editor-mcp';
import { limitResetAt } from './limit-reset';

/** Prefers the user's installed Claude Code so login, settings and version match the terminal. */
/**
 * Model name as Claude Code should get it. With the bare alias `haiku` Claude Code reports Haiku in init but runs the
 * main loop on Sonnet (checked 28.10.2026, Claude Code via SDK and -p); the full id works. Other aliases are fine.
 */
export function modelArg(m: string | undefined): string | undefined {
  return m === 'haiku' ? 'claude-haiku-5-5' : m;
}

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
  if (!cli) return Promise.resolve({ loggedIn: false, notInstalled: true, error: 'Claude Code не установлен — без него чаты не работают.' });
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

/** The official installer command for this OS (shown to the user before it runs). */
export function installCommand(): { file: string; args: string[]; display: string } {
  if (process.platform === 'win32') {
    const display = 'irm https://claude.ai/install.ps1 | iex';
    return { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', display], display };
  }
  const display = 'curl -fsSL https://claude.ai/install.sh | bash';
  return { file: '/bin/bash', args: ['-lc', display], display };
}

/** Installs Claude Code with the official installer (native build into ~/.local/bin), then reports the new status. */
export function installClaude(): Promise<AuthStatus & { log?: string }> {
  const cmd = installCommand();
  return new Promise((resolve) => {
    execFile(cmd.file, cmd.args, { timeout: 10 * 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, async (err, stdout, stderr) => {
      const log = `${stdout}
${stderr}`.trim().slice(-2000);
      const st = await authStatus();
      resolve({ ...st, log, ...(st.notInstalled ? { error: `Установка не удалась: ${err?.message ?? ''}
${log.slice(-600)}` } : {}) });
    });
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
  partialThinking = '';
  title = 'Новый чат';
  permissionMode?: string;
  model?: string;
  effort?: string;
  autoApprove = false;
  /** Remote Control: the session can also be continued from claude.ai/code and the Claude app. */
  remote = false;
  chrome = true;
  /** Restart the Claude process after the current turn (a startup-only option changed while busy). */
  restartPending = false;
  /** After a result, waiting to see whether Claude answers queued questions separately (see settleTurn). */
  awaitingQueued: NodeJS.Timeout | null = null;
  /** Stop was pressed: the error result of the dropped answer is expected and not shown as an error. */
  interrupting = false;
  /** Transcript watcher while the hidden Remote Control process owns the session. */
  transcriptWatch: fs.FSWatcher | null = null;
  remoteProc: remote.RemoteProc | null = null;
  /** Questions typed into the /RC process that the transcript doesn't show yet (Claude writes a queued one only
   * when it takes it). They stay on screen — grey while queued — across transcript reloads. */
  remoteQueue: { text: string; at: number; id: string; attachments: TurnAttachment[] }[] = [];
  transcriptTick: NodeJS.Timeout | null = null;
  transcriptPoll: NodeJS.Timeout | null = null;
  /** Transcript watcher while queued questions wait to be taken by Claude. */
  queueWatch: fs.FSWatcher | null = null;
  /** The `system/init` message of the running process: model, version, MCP servers, commands. */
  init: any = null;
  approvals: ApprovalEntry[] = [];
  /** The coding agent: Claude Code (the SDK below) or another CLI agent run per question (agent-run.ts). */
  agent: AgentId = 'claude';
  /** The other agent's own session id, to resume it. */
  agentSession?: string;
  /** The other agent's process while it answers. */
  agentProc: ChildProcess | null = null;
  /** Cumulative cost reported by the current Claude process (reset when a new process starts). */
  costSoFar = 0;
  /** When Claude last sent anything (a stream chunk, a tool call, a status) — the stall watchdog looks at it. */
  lastActivity = Date.now();
  /** Automatic restarts of the current answer (stalled with nothing coming), so it doesn't loop forever. */
  stallRestarts = 0;
  /** An answer cut off by the usage limit: the turn and when to go on (see the limit watch). */
  limitResume: { key: string; at: number; done: boolean } | null = null;
  limitResumedAt: number | undefined;
  /** Connectors that need a sign-in (shown as a «Войти» card above the input). */
  mcpAuth: { name: string; status: string; waiting?: boolean; asked?: boolean }[] = [];
  limitRetries: number | undefined;
  q: Query | null = null;
  input: InputQueue | null = null;
  pending = new Map<string, PendingPermission>();
  existsOnDisk = false;
  /** Background tasks of the Claude process (task_started / task_progress / task_notification). */
  tasks: BgTask[] = [];
  /** Claude Code's predicted next question (prompt_suggestion), cleared when a question is sent. */
  suggestion: string | undefined;
  /** Bash-mode runs (`!cmd`) waiting to be passed to Claude with the next question. */
  shellContext: string[] = [];
  /** History compaction in progress, and the context size of the last request (for the time estimate). */
  compacting: CompactState | undefined;
  contextTokens: number | undefined;
  private emitTimer: NodeJS.Timeout | null = null;

  constructor(public id: string, public cwd: string) {}

  /** `tail`: only that many last turns (live updates; long chats have tens of MB of turns). */
  snapshot(tail?: number): ChatSnapshot {
    const all = this.builder.turns;
    const turns = tail && all.length > tail ? all.slice(-tail) : all;
    return {
      sessionId: this.id,
      ...(this.agent !== 'claude' ? { agent: this.agent } : {}),
      cwd: this.cwd,
      title: this.title,
      status: this.status,
      turns,
      ...(turns !== all ? { turnsFrom: all.length - turns.length, turnsTotal: all.length } : {}),
      partial: this.partial || undefined,
      partialThinking: this.partialThinking || undefined,
      permissionMode: this.permissionMode,
      model: this.model,
      effort: this.effort,
      autoApprove: this.autoApprove,
      remote: this.remote,
      chrome: this.chrome,
      limitResumeAt: this.limitResume && !this.limitResume.done ? this.limitResume.at : undefined,
      mcpAuth: this.mcpAuth.length ? this.mcpAuth : undefined,
      compacting: this.compacting,
      tasks: this.tasks.length ? this.tasks : undefined,
      suggestion: this.suggestion,
      contextTokens: this.contextTokens,
      shellPending: this.shellContext.length || undefined,
      approvals: this.approvals,
      pending: [...this.pending.values()].map((p) => p.req),
    };
  }

  publish(now = false) {
    if (now) {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = null;
      emit({ type: 'chat', snapshot: this.snapshot(LIVE_TAIL) });
      return;
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      emit({ type: 'chat', snapshot: this.snapshot(LIVE_TAIL) });
    }, 80);
  }

  setStatus(s: ChatStatus) {
    const was = this.status;
    this.status = s;
    this.lastActivity = Date.now();
    this.publish(true);
    // taskbar: progress while any chat works; a check when an answer ends (or needs you) while the window is away
    const finished = was === 'running' && s !== 'running';
    taskbar.chatsChanged(anyBusy(), finished);
  }
}

const sessions = new Map<string, ChatSession>();
/** Some chat works: Claude answers, or a background task (subagent, background command) still runs. */
const anyBusy = () => [...sessions.values()].some((x) => x.status === 'running' || x.tasks.some((t) => t.status === 'running'));
/** Turns sent with each live update; earlier ones don't change once answered. */
const LIVE_TAIL = 4;

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
  for (const a of listAgentChats(cwd)) if (!out.some((o) => o.sessionId === a.sessionId)) out.push(a);
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
  if (s) {
    // The title may have been changed elsewhere (/rename in the chat, terminal, IDE plugin).
    if (s.status !== 'running' && s.status !== 'waiting' && findTranscript(sessionId)) {
      const info = (await listSessions({ dir: s.cwd, includeWorktrees: false }).catch(() => [])).find((x) => x.sessionId === sessionId);
      const title = info?.customTitle || info?.summary || info?.firstPrompt;
      if (title) s.title = title;
    }
    return s.snapshot();
  }
  const file = findTranscript(sessionId);
  s = new ChatSession(sessionId, cwdHint ?? os.homedir());
  const saved0 = file ? null : loadAgentChat(sessionId);
  if (saved0) {
    s.agent = saved0.agent;
    s.agentSession = saved0.agentSession;
    s.cwd = saved0.cwd;
    s.title = saved0.title;
    s.model = saved0.model;
    s.builder.turns = saved0.turns;
    s.autoApprove = !!stateFile.data.chatModels?.[sessionId]?.autoApprove;
    s.approvals = approvals.forChat(sessionId);
    sessions.set(sessionId, s);
    return s.snapshot();
  }
  if (file) {
    const { builder, cwd } = await loadTranscript(file);
    s.builder = builder;
    if (cwd) s.cwd = cwd;
    s.existsOnDisk = true;
    if (builder.lastContext) s.contextTokens = builder.lastContext;
    // An answer still being written elsewhere (terminal, phone, IDE plugin): show it as working; the transcript
    // watcher ends it when that answer is done.
    if (builder.isTurnOpen()) {
      const last = builder.turns[builder.turns.length - 1];
      if (last) last.live = true;
      s.status = 'running';
    }
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
  s.chrome = saved?.chrome ?? stateFile.data.defaultChrome ?? true;
  s.remote = false;
  s.approvals = approvals.forChat(sessionId);
  sessions.set(sessionId, s);
  // /RC stays on across restarts: the hidden remote process is started again, otherwise the phone would keep
  // writing into a bridge nobody listens to.
  if (saved?.remote && file) {
    try {
      setRemote(sessionId, true);
    } catch (e) {
      console.error('remote restore failed', e);
    }
  }
  // Changes made elsewhere (phone, terminal, IDE plugin) show up here and mark the tab unread.
  if (!s.remote) watchTranscript(s);
  return s.snapshot();
}

/**
 * The session of a chat the UI shows, reopened if it was closed here meanwhile (group switch, closed tab). A chat that
 * never got a transcript has nothing to reopen from and stays an error.
 */
/** A chat that can be reopened: open now, or has its history on disk. */
export function chatExists(sessionId: string) {
  return sessions.has(sessionId) || !!findTranscript(sessionId) || !!loadAgentChat(sessionId);
}

export async function ensureSession(sessionId: string) {
  if (sessions.has(sessionId)) return;
  if (!findTranscript(sessionId) && !loadAgentChat(sessionId)) throw new Error('Чат не открыт: у него ещё нет истории на диске — создайте новый чат');
  await openChat(sessionId);
}

export function newChat(cwd: string, agent: AgentId = 'claude', model?: string): ChatSnapshot {
  const s = new ChatSession(randomUUID(), cwd);
  s.agent = agent;
  s.model = agent === 'claude' ? (model ?? stateFile.data.defaultModel) : model || undefined;
  if (agent !== 'claude') {
    s.autoApprove = !!stateFile.data.defaultAutoApprove;
    sessions.set(s.id, s);
    return s.snapshot();
  }
  s.effort = stateFile.data.defaultEffort;
  s.autoApprove = !!stateFile.data.defaultAutoApprove;
  s.chrome = stateFile.data.defaultChrome ?? true;
  sessions.set(s.id, s);
  return s.snapshot();
}

export async function rename(sessionId: string, title: string) {
  const s = sessions.get(sessionId);
  if (s) {
    s.title = title;
    s.publish(true);
  }
  if (s && s.agent !== 'claude') return renameAgentChat(sessionId, title);
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
  stateFile.data.chatModels = { ...stateFile.data.chatModels, [s.id]: { model: s.model, effort: s.effort, autoApprove: s.autoApprove, remote: s.remote, chrome: s.chrome } };
  stateFile.save();
}

export async function send(sessionId: string, text: string, opts: SendOptions) {
  const stalled = sessions.get(sessionId);
  if (stalled) stalled.stallRestarts = 0; // a new question: the watchdog may restart it again
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Чат не открыт');
  if (s.agent !== 'claude') return sendToAgent(s, text, opts);
  const attachments = opts.attachments ?? [];
  if (s.remote) {
    if (!s.remoteProc || s.remoteProc.exited !== undefined) throw new Error('Удалённый процесс Claude не запущен — выключите и снова включите /RC');
    // Interactive Claude has no image blocks over stdin: it gets the paths and opens them with Read (images too).
    const ctx = s.shellContext.splice(0);
    const plain = attachments.length ? [text, '', ATTACHMENTS_HEADER, ...attachments.map((p) => `- ${p}`)].join('\n') : text;
    const body = ctx.length ? `${ctx.join('\n')}\n\n${plain}` : plain;
    remote.send(s.remoteProc, body);
    const q = { text: text.trim(), at: Date.now(), id: randomUUID(), attachments: attachments.map((p) => ({ kind: IMAGE_EXT.has(path.extname(p).slice(1).toLowerCase()) ? ('image' as const) : ('file' as const), path: p })) };
    s.remoteQueue.push(q);
    addRemoteQueued(s, q);
    s.setStatus('running');
    return;
  }
  if (opts.permissionMode) s.permissionMode = opts.permissionMode;
  s.builder.loadedBytes = undefined; // our own process adds to the builder from here on
  const modelChanged = (opts.model || undefined) !== s.model;
  const effortChanged = (opts.effort || undefined) !== s.effort;
  s.model = opts.model || undefined;
  s.effort = opts.effort || undefined;
  if (modelChanged || effortChanged) rememberChatModel(s);

  // A question sent while Claude is still answering joins the current turn (Claude Code answers them together).
  // The message carries this uuid into the transcript, so the turn keeps its id after a reload (rewind, fork).
  const uid = randomUUID();
  s.suggestion = undefined;
  const context = s.shellContext.splice(0);
  const turn = s.builder.startTurn(
    text,
    Date.now(),
    uid,
    attachments.map((p) => ({ kind: IMAGE_EXT.has(path.extname(p).slice(1).toLowerCase()) ? 'image' : 'file', path: p })),
  );
  turn.live = true;
  if (context.length && turn.id === uid) turn.shellContext = context.map((x) => x.match(/<bash-input>([\s\S]*?)<\/bash-input>/)?.[1] ?? '');
  const queued = turn.more?.[turn.more.length - 1];
  if (queued && queued.at >= Date.now() - 1000 && queued.prompt === text) {
    // Queued behind the running answer: grey until Claude actually takes it (see watchQueue).
    queued.pending = true;
    watchQueue(s);
  }
  if (s.title === 'Новый чат') s.title = (text || path.basename(attachments[0] ?? '')).slice(0, 60);
  s.partial = '';
  s.setStatus('running');
  if (!s.q) start(s);
  else {
    // A running session switches model, effort and permission mode in place; history and context stay.
    if (opts.permissionMode) await s.q.setPermissionMode(opts.permissionMode as any).catch(() => {});
    if (modelChanged) await s.q.setModel(modelArg(s.model)).catch(() => {});
    if (effortChanged) await s.q.applyFlagSettings({ effortLevel: (s.effort as any) ?? null }).catch(() => {});
  }
  const content = buildContent(text, attachments);
  s.input!.push({
    type: 'user',
    uuid: uid,
    message: { role: 'user', content: context.length ? withContext(context, content) : content },
    parent_tool_use_id: null,
    session_id: s.id,
  } as SDKUserMessage);
}

/** A question to a chat with another agent: one headless run of that agent (agent-run.ts). */
function sendToAgent(s: ChatSession, text: string, opts: SendOptions) {
  if (s.agentProc) throw new Error(`${AGENT_NAMES[s.agent]} ещё отвечает — дождитесь ответа или нажмите «Стоп»`);
  if (opts.model !== undefined) s.model = opts.model || undefined;
  if (opts.permissionMode !== undefined) s.permissionMode = opts.permissionMode || undefined;
  const attachments = opts.attachments ?? [];
  const images = attachments.filter((p) => IMAGE_EXT.has(path.extname(p).slice(1).toLowerCase()));
  const ctx = s.shellContext.splice(0);
  let body = attachments.length ? [text, '', ATTACHMENTS_HEADER, ...attachments.map((p) => `- ${p}`)].join('\n') : text;
  if (ctx.length) body = `${ctx.join('\n')}\n\n${body}`;
  const turn = s.builder.startTurn(
    text,
    Date.now(),
    randomUUID(),
    attachments.map((p) => ({ kind: IMAGE_EXT.has(path.extname(p).slice(1).toLowerCase()) ? ('image' as const) : ('file' as const), path: p })),
  );
  turn.live = true;
  if (s.title === 'Новый чат') s.title = (text || path.basename(attachments[0] ?? '')).slice(0, 60);
  s.suggestion = undefined;
  s.setStatus('running');
  runAgentTurn(s, body, turn, s.agent === 'codex' || s.agent === 'opencode' ? images : [], (err) => {
    turn.live = false;
    s.builder.closeTurn();
    if (err) turn.error = err;
    s.setStatus(err ? 'error' : 'idle');
    saveAgentChat(s);
    markCompleted(s, err);
    s.publish(true);
  });
}

/** Bash-mode output goes in front of the question, the way Claude Code itself records it. */
function withContext(context: string[], content: string | any[]) {
  const head = context.join('\n');
  if (typeof content === 'string') return `${head}\n\n${content}`;
  return [{ type: 'text', text: head }, ...content];
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
      // backups of edited files, so a turn can be rewound (rewindFiles)
      enableFileCheckpointing: true,
      // summaries of the model's reasoning, shown folded under "💭 Размышления" (Claude Code hides them by default)
      thinking: { type: 'adaptive', display: 'summarized' },
      // subagents: their texts and calls come through (shown under the Agent call), plus a one-line progress summary
      forwardSubagentText: true,
      // the next question Claude Code predicts; the composer offers it on Tab
      promptSuggestions: true,
      agentProgressSummaries: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: EDITOR_INSTRUCTIONS },
      mcpServers: { editor: editorMcp(s.id, s.cwd) },
      allowedTools: ['mcp__editor'],
      ...(s.permissionMode ? { permissionMode: s.permissionMode as any } : {}),
      ...(s.model ? { model: modelArg(s.model) } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
      ...(s.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      // Claude in Chrome (the browser extension), like `claude --chrome`
      ...(s.chrome ? { extraArgs: { chrome: null } } : {}),
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
    for await (const m of q) {
      s.lastActivity = Date.now();
      s.builder.loadedBytes = undefined;
      if (process.env.CLAUDE_EDITOR_TRACE && m.type !== "stream_event") fs.appendFileSync(process.env.CLAUDE_EDITOR_TRACE, `${m.type} ${(m as any).subtype ?? ""} ${(m as any).suggestion ?? ""}
`);
      handleMessage(s, m);
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    // a process replaced by a restart: its end is expected, not an error of the new answer
    if (s.q === q) failTurn(s, msg);
  } finally {
    if (s.q === q) {
      s.q = null;
      s.input = null;
      // the process is gone: its background tasks with it
      for (const t of s.tasks) if (t.status === 'running') t.status = 'stopped';
      s.builder.markInterrupted();
      finishLiveTurns(s);
      if (s.status === 'running' || s.status === 'waiting') s.setStatus('idle');
      else s.publish(true);
    }
  }
}

/**
 * Claude Code writes a queued prompt into the transcript only when it actually takes it (a `dequeue` plus the
 * user entry). While a chat has queued questions, the transcript tail is checked on every change and each
 * question found there stops being "pending".
 */
function watchQueue(s: ChatSession) {
  if (s.queueWatch) return;
  const file = findTranscript(s.id);
  if (!file) return;
  let timer: NodeJS.Timeout | null = null;
  const check = () => {
    const pending = s.builder.turns.flatMap((t) => t.more ?? []).filter((m) => m.pending);
    if (!pending.length) {
      s.queueWatch?.close();
      s.queueWatch = null;
      return;
    }
    let tail = '';
    try {
      const fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      tail = buf.toString('utf8');
    } catch {
      return;
    }
    const taken = new Set<string>();
    for (const line of tail.split('\n')) {
      if (!line.includes('"type":"user"') && !line.includes('queued_command') && !line.includes('absorbed_mid_turn')) continue;
      try {
        const e = JSON.parse(line);
        // Taken mid-answer: an attachment `queued_command` (and a queue-operation `remove`, reason absorbed_mid_turn).
        if (e.type === 'attachment' && e.attachment?.type === 'queued_command' && typeof e.attachment.prompt === 'string') taken.add(e.attachment.prompt.trim());
        else if (e.type === 'queue-operation' && e.reason === 'absorbed_mid_turn' && typeof e.content === 'string') taken.add(e.content.trim());
        else if (e.type === 'user') {
          // Taken as its own turn: a regular user entry.
          const c = e.message?.content;
          const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : '';
          if (text) taken.add(text.trim());
        }
      } catch {
        /* partial line */
      }
    }
    let changed = false;
    for (const m of pending) {
      if ([...taken].some((t) => t === m.prompt.trim() || t.startsWith(m.prompt.trim()))) {
        m.pending = false;
        changed = true;
      }
    }
    if (changed) s.publish(true);
  };
  try {
    s.queueWatch = fs.watch(file, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(check, 250);
    });
  } catch {
    /* no transcript yet */
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
        s.partialThinking = '';
        s.publish();
      }
      // Claude started thinking: an open «thinking…» block right away (the summary itself often comes in one piece at the end)
      if (ev?.type === 'content_block_start' && ev.content_block?.type === 'thinking' && !(m as any).parent_tool_use_id) {
        s.partialThinking = '​';
        s.publish();
      }
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' && !(m as any).parent_tool_use_id) {
        s.partialThinking += ev.delta.thinking ?? '';
        s.publish();
      }
      return;
    }
    case 'assistant': {
      // Subagent messages: shown as activity lines under the Agent/Task call, not as the main answer.
      if ((m as any).parent_tool_use_id) {
        const lines: string[] = [];
        for (const b of (m.message as any)?.content ?? []) {
          if (b.type === 'text' && b.text?.trim()) lines.push('💬 ' + b.text.trim().split('\n')[0].slice(0, 200));
          if (b.type === 'tool_use') lines.push(`⚙ ${b.name} ${String(b.input?.description ?? b.input?.command ?? b.input?.file_path ?? b.input?.pattern ?? b.input?.url ?? '').slice(0, 160)}`);
        }
        s.builder.addSub((m as any).parent_tool_use_id, lines);
        s.publish();
        return;
      }
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
      s.partialThinking = '';
      const u: any = (m.message as any)?.usage;
      if (u) s.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
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
      if (s.interrupting && r.subtype !== 'success') {
        // The answer that Stop dropped. Its cost belongs to the stopped turn — the one before a turn started from the
        // queue (see interrupt) — and its error isn't shown: the user asked for it.
        s.interrupting = false;
        const turns = s.builder.turns;
        const stopped = turns[turns.length - (turns[turns.length - 1]?.live && s.status === 'running' ? 2 : 1)];
        if (stopped && typeof r.total_cost_usd === 'number') stopped.costUsd = Math.max(0, r.total_cost_usd - s.costSoFar);
        if (typeof r.total_cost_usd === 'number') s.costSoFar = r.total_cost_usd;
        return;
      }
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
      s.interrupting = false;
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
      if (sm.subtype === 'init') {
        s.init = sm;
        // connectors still connecting at start: look a bit later
        setTimeout(() => void refreshMcpAuth(s), 8000);
      }
      if (sm.subtype === 'task_started') {
        s.tasks = [...s.tasks.filter((t) => t.id !== sm.task_id), { id: sm.task_id, description: sm.description ?? '', status: 'running', startedAt: Date.now(), kind: sm.subagent_type ?? sm.task_type }];
        s.publish(true);
        taskbar.chatsChanged(anyBusy(), false);
      }
      if (sm.subtype === 'task_progress') {
        const t = s.tasks.find((x) => x.id === sm.task_id);
        if (t) {
          t.progress = `${sm.summary ? sm.summary + ' · ' : ''}${sm.usage?.tool_uses ?? 0} действий · ${Math.round((sm.usage?.total_tokens ?? 0) / 1000)}k токенов`;
          s.publish();
        }
      }
      if (sm.subtype === 'task_notification') {
        const t = s.tasks.find((x) => x.id === sm.task_id) ?? { id: sm.task_id, description: sm.summary ?? '', startedAt: Date.now(), status: 'running' as const };
        Object.assign(t, { status: sm.status, summary: sm.summary, outputFile: sm.output_file });
        s.tasks = [...s.tasks.filter((x) => x.id !== t.id), t].filter((x) => x.status === 'running' || Date.now() - x.startedAt < 30 * 60_000).slice(-20);
        s.publish(true);
        taskbar.chatsChanged(anyBusy(), false);
      }
      // History compaction: 'status: compacting' starts it, a compact_boundary (or the status clearing) ends it.
      if (sm.subtype === 'status') {
        if (sm.status === 'compacting' && !s.compacting) {
          s.compacting = { since: Date.now(), preTokens: s.contextTokens };
          s.publish(true);
        } else if (sm.status !== 'compacting' && s.compacting) {
          if (sm.compact_result === 'failed') s.builder.addCompact({ at: Date.now(), failed: sm.compact_error ?? 'не удалось' });
          s.compacting = undefined;
          s.publish(true);
        }
      }
      if (sm.subtype === 'model_refusal_fallback') {
        s.builder.addFallback(sm, Date.now());
        s.publish(true);
      }
      if (sm.subtype === 'compact_boundary') {
        const info = compactInfo(sm.compact_metadata);
        s.builder.addCompact({ at: Date.now(), ...info, durationMs: info.durationMs ?? (s.compacting ? Date.now() - s.compacting.since : undefined) });
        s.compacting = undefined;
        if (info.postTokens) s.contextTokens = info.postTokens;
        s.publish(true);
      }
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
    case 'prompt_suggestion' as any: {
      const sug = String((m as any).suggestion ?? '').trim();
      s.suggestion = sug || undefined;
      s.publish(true);
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
  if (s.agent !== 'claude') throw new Error(`/RC есть только у Claude Code, а этот чат — с ${AGENT_NAMES[s.agent]}`);
  if (on) {
    if (s.status === 'running' || s.status === 'waiting') throw new Error('Дождитесь конца ответа или нажмите «Стоп», затем включите удалённый режим');
    const cli = claudeExecutable();
    if (!cli) throw new Error('Claude Code не найден');
    stopProcess(s);
    const name = s.title.replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 40) || 'MPI';
    s.remoteProc = remote.start({
      cli,
      sessionId: s.id,
      cwd: s.cwd,
      name,
      permissionMode: s.autoApprove ? 'bypassPermissions' : s.permissionMode,
      model: modelArg(s.model),
      // pasted screenshots live in the editor's attachments folder, outside the project: readable without asking
      addDirs: [path.join(dataDir(), 'attachments')],
      chrome: s.chrome,
      transcript: findTranscript(s.id),
      onCompacting: () => {
        if (s.compacting) return;
        s.compacting = { since: Date.now(), preTokens: s.contextTokens };
        s.publish(true);
      },
    });
    s.remote = true;
    s.setStatus('idle');
    watchTranscript(s);
  } else {
    s.remote = false;
    if (s.remoteProc) remote.stop(s.remoteProc);
    s.remoteProc = null;
    const file = findTranscript(s.id);
    if (file)
      void loadTranscript(file).then(({ builder }) => {
        // Whatever was pending remotely is over: the next question starts its own turn in the SDK process.
        builder.markInterrupted();
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

/**
 * Re-reads the transcript whenever it changes outside the editor's own SDK process: the hidden /RC process, the phone,
 * a terminal or an IDE plugin working on the same session. New answers mark the chat unread.
 */
function watchTranscript(s: ChatSession) {
  unwatchTranscript(s);
  const file = findTranscript(s.id);
  if (!file) return;
  let timer: NodeJS.Timeout | null = null;
  const shape = (b: TurnBuilder) => {
    const t = b.turns[b.turns.length - 1];
    return `${b.turns.length}:${t?.items.length ?? 0}:${t?.more?.length ?? 0}`;
  };
  // one read at a time; changes meanwhile → one more read after it
  let reading = false;
  let again = false;
  const reload = async (): Promise<void> => {
    // Our own SDK process writes this file too; its messages already arrive live.
    if (!s.remote && s.q) return;
    if (reading) return void (again = true);
    reading = true;
    try {
      const before = shape(s.builder);
      // only what was appended (the file can be hundreds of MB); the whole file when it's new, shrank or replaced
      let builder = s.builder;
      const size = fs.statSync(file).size;
      if (builder.loadedBytes === undefined || size < builder.loadedBytes) builder = (await loadTranscript(file)).builder;
      else {
        builder.dropOverlay();
        await readTranscriptInto(file, builder, builder.loadedBytes);
      }
      for (const t of builder.turns.slice(-6)) t.live = false;
      const changed = shape(builder) !== before;
      s.builder = builder;
      // context size follows the transcript (compactions, the latest request) in /RC and other external runs
      if (builder.lastContext) s.contextTokens = builder.lastContext;
      if (s.compacting && builder.turns.some((t) => t.compacts?.some((m) => m.at >= s.compacting!.since - 5000))) s.compacting = undefined;
      // Questions typed here that Claude hasn't written yet stay on screen (grey while queued behind an answer).
      const recent = builder.turns.slice(-4).flatMap((t) => [t.prompt, ...(t.more?.map((m) => m.prompt) ?? [])]).map(sameText);
      // a /command typed here shows up as a <command-name> entry, not as a prompt
      const ranCommand = (q: { text: string; at: number }) => q.text.startsWith('/') && builder.commands.some((c) => c.name === q.text.split(/\s/)[0] && c.at >= q.at - 10_000);
      s.remoteQueue = s.remoteQueue.filter((q) => !recent.includes(sameText(q.text)) && !ranCommand(q) && Date.now() - q.at < 5 * 60_000);
      for (const q of s.remoteQueue) addRemoteQueued(s, q);
      if (s.remote) syncRemoteQuestion(s);
      const last = builder.turns[builder.turns.length - 1];
      // A question (from here or the phone) without a finished answer keeps the chat "working".
      const open = !!last && builder.isTurnOpen();
      if (open) {
        last.live = true;
        // a question waiting for you is «waiting», not «working»
        const want = s.pending.size ? 'waiting' : 'running';
        if (s.status !== want) s.setStatus(want);
      } else if (s.status === 'running' || s.status === 'waiting') {
        s.setStatus('idle');
        markCompleted(s);
      } else if (changed) {
        markCompleted(s);
      }
      s.publish(true);
    } catch {
      /* file being written */
    } finally {
      reading = false;
      if (again) {
        again = false;
        void reload();
      }
    }
  };
  // at most every 400 ms while Claude writes (a debounce that restarts on every write would wait for the end)
  let seen = '';
  const stamp = () => {
    try {
      const st = fs.statSync(file);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return '';
    }
  };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      seen = stamp();
      void reload();
    }, 400);
  };
  try {
    s.transcriptWatch = fs.watch(file, schedule);
  } catch {
    /* transcript vanished */
  }
  // fs.watch on Windows misses changes now and then: the file is also checked every 2 s
  const poll = setInterval(() => {
    if (stamp() !== seen) schedule();
  }, 2000);
  s.transcriptPoll = poll;
  // An answer someone else was writing (terminal, IDE) that went silent for long: that process is gone. Not for /RC,
  // whose process we see, nor for our own SDK process (a long command can run without writing anything).
  s.transcriptTick = setInterval(() => {
    if (s.status !== 'running' || s.remote || s.q) return;
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < 10 * 60_000) return;
    } catch {
      return;
    }
    s.builder.markInterrupted();
    finishLiveTurns(s);
    s.setStatus('idle');
    s.publish(true);
  }, 60_000);
}

function unwatchTranscript(s: ChatSession) {
  if (s.transcriptTick) clearInterval(s.transcriptTick);
  s.transcriptTick = null;
  if (s.transcriptPoll) clearInterval(s.transcriptPoll);
  s.transcriptPoll = null;
  s.transcriptWatch?.close();
  s.transcriptWatch = null;
}

/** Shows a question typed into /RC: its own running turn, or grey ("not taken yet") inside the running answer. */
/**
 * /RC: Claude's AskUserQuestion is a dialog inside the hidden interactive Claude (and on claude.ai) — invisible here,
 * so the chat looked stuck until restarted. It is shown as the usual «Claude спрашивает» card; an answer closes the
 * dialog (Esc) and is sent as the next message. Answered elsewhere (phone) → the card goes away.
 */
function syncRemoteQuestion(s: ChatSession) {
  const q = s.builder.pendingQuestion();
  const cardId = q ? `rc-${q.id}` : undefined;
  for (const [id] of s.pending) if (id.startsWith('rc-') && id !== cardId) s.pending.delete(id);
  if (!q || s.pending.has(cardId!)) return;
  const req: PermissionRequest = { id: cardId!, sessionId: s.id, toolName: 'AskUserQuestion', input: q.input, hasSuggestions: false };
  s.pending.set(cardId!, {
    req,
    resolve: (r: any) => {
      const proc = s.remoteProc;
      if (!proc || proc.exited !== undefined) return;
      remote.interrupt(proc);
      const answers: Record<string, string> = r?.behavior === 'allow' ? (r.updatedInput?.answers ?? {}) : {};
      const lines = Object.entries(answers).map(([question, a]) => `- «${question}»: ${a}`);
      if (!lines.length) return;
      // the dialog closes first, then the answer goes as a message
      setTimeout(() => void send(s.id, ['Ответ на твой вопрос (окно вопроса закрыто):', ...lines].join('\n'), {}).catch(() => {}), 1500);
    },
  });
  s.setStatus('waiting');
}

/** Text as the TUI writes it to the transcript (tabs become spaces, …): compared without whitespace differences. */
const sameText = (t: string) => t.replace(/\s+/g, ' ').trim();

function addRemoteQueued(s: ChatSession, q: ChatSession['remoteQueue'][number]) {
  // undone before the transcript is read further (the real question comes from there)
  s.builder.withOverlay(() => {
    const turn = s.builder.startTurn(q.text, q.at, q.id, q.attachments);
    turn.live = true;
    const more = turn.more?.find((m) => m.prompt === q.text && m.at === q.at);
    if (more) more.pending = true;
  });
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
  if (s && s.agent !== 'claude') return [];
  if (s?.q) {
    const list = await s.q.supportedCommands().catch(() => null);
    if (list) return list.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }));
  }
  return (s?.init?.slash_commands ?? []).map((n: string) => ({ name: n, description: '' }));
}

/**
 * Claude in Chrome on/off for a chat. The flag is given when Claude starts, so the process restarts: right away when
 * idle (history and context stay — it resumes the session), after the current answer otherwise.
 */
export function setChrome(sessionId: string, on: boolean) {
  const s = sessions.get(sessionId);
  if (!s || s.chrome === on) return;
  s.chrome = on;
  rememberChatModel(s);
  const busy = s.status === 'running' || s.status === 'waiting';
  if (s.remote) {
    if (!busy) {
      setRemote(sessionId, false);
      setRemote(sessionId, true);
    }
  } else if (s.q) {
    if (busy) s.restartPending = true;
    else stopProcess(s);
  }
  s.publish(true);
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
  if (s && s.agent !== 'claude') return stopAgent(s);
  if (s?.remote && s.remoteProc) {
    remote.interrupt(s.remoteProc);
    finishLiveTurns(s);
    s.builder.markInterrupted();
    const next = s.builder.splitPending(Date.now());
    if (next) {
      next.live = true;
      s.setStatus('running');
      return;
    }
    s.setStatus('idle');
    return;
  }
  if (!s?.q) return;
  for (const [id] of s.pending) answerPermission(sessionId, id, { behavior: 'deny', message: 'Остановлено пользователем' });
  s.interrupting = true;
  await s.q.interrupt().catch(() => {});
  finishLiveTurns(s);
  s.builder.markInterrupted();
  s.partial = '';
  // Questions still queued (grey): Claude Code runs them right after the stop — show them as the new running turn.
  const next = s.builder.splitPending(Date.now());
  if (next) {
    if (s.awaitingQueued) clearTimeout(s.awaitingQueued);
    s.awaitingQueued = null;
    next.live = true;
    s.setStatus('running');
    return;
  }
  s.setStatus('idle');
}

/**
 * A stuck answer: the chat's Claude process (or the hidden /RC one) is killed and started anew on the same session,
 * the hanging answer is closed, and what Claude never got to is sent again — the grey queued questions, and the
 * question itself if no answer came at all. Returns how many questions were resent.
 */
export async function restart(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Чат не открыт');
  if (s.agent !== 'claude') {
    stopAgent(s);
    return 0;
  }
  const last = s.builder.turns[s.builder.turns.length - 1];
  const resend: string[] = [];
  if (last?.live) {
    const nothingYet = !last.items.length;
    if (nothingYet && last.prompt.trim()) resend.push(last.prompt);
    for (const m of last.more ?? []) if ((m.pending || nothingYet) && m.prompt.trim()) resend.push(m.prompt);
  }
  for (const q of s.remoteQueue) if (!resend.includes(q.text)) resend.push(q.text);
  for (const [id] of s.pending) answerPermission(sessionId, id, { behavior: 'deny', message: 'Чат перезапущен' });
  if (s.awaitingQueued) clearTimeout(s.awaitingQueued);
  s.awaitingQueued = null;
  for (const m of last?.more ?? []) m.pending = false;
  s.remoteQueue = [];
  s.compacting = undefined;
  s.partial = '';
  s.partialThinking = '';
  const wasRemote = s.remote;
  if (wasRemote) {
    setRemote(sessionId, false);
  } else {
    const q = s.q;
    stopProcess(s);
    try {
      q?.close();
    } catch {
      /* already gone */
    }
  }
  finishLiveTurns(s);
  s.builder.markInterrupted();
  s.setStatus('idle');
  const text = resend.join('\n\n');
  if (wasRemote) {
    // a fresh hidden Claude needs a few seconds before it takes typing
    setRemote(sessionId, true);
    if (text) setTimeout(() => void send(sessionId, text, {}).catch(() => {}), 8000);
  } else if (text) {
    await send(sessionId, text, { model: s.model, effort: s.effort, permissionMode: s.permissionMode });
  }
  return resend.length;
}

/**
 * Stall watchdog: an answer that is «running» but gets nothing from Claude for 2 minutes (no tokens, no tool call) is
 * restarted — the same as ⟳. Not while a tool runs (a long build / test is fine), a permission waits, history is
 * compacted, or under /RC. If nothing had come yet the question is re-sent; otherwise Claude is asked to go on.
 * At most twice per answer.
 */
const STALL_MS = Number(process.env.CLAUDE_EDITOR_STALL_MS) || 120_000;
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.agent !== 'claude' || s.remote || !s.q || s.status !== 'running' || s.pending.size || s.compacting) continue;
    if (now - s.lastActivity < STALL_MS) continue;
    const last = s.builder.turns[s.builder.turns.length - 1];
    if (!last?.live) continue;
    if (last.items.some((i) => i.kind === 'tool' && !i.done)) continue;
    s.lastActivity = now;
    if (s.stallRestarts >= 2) continue;
    const started = last.items.length > 0;
    const id = s.id;
    const count = ++s.stallRestarts;
    emit({ type: 'toast', text: `«${s.title}»: 2 минуты без ответа — перезапускаю${started ? ' и прошу продолжить' : ' и отправляю вопрос заново'}` });
    void restart(id)
      .then(() => {
        const cur = sessions.get(id);
        if (started && cur) return send(id, 'Ответ прервался: 2 минуты не было никакой активности, чат перезапущен автоматически. Продолжи с того места, где остановился.', { model: cur.model, effort: cur.effort, permissionMode: cur.permissionMode });
      })
      .then(() => {
        const cur = sessions.get(id);
        if (cur) cur.stallRestarts = count; // the new answer still counts the earlier restarts
      })
      .catch((e) => emit({ type: 'toast', text: `Перезапуск «${s.title}» не удался: ${e?.message ?? e}`, kind: 'error' }));
  }
}, Math.min(15_000, STALL_MS / 2)).unref();

/** Ends the background Claude process of a chat that was closed in the UI (history stays on disk). */
export function closeChat(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.status === 'running' || s.status === 'waiting') return; // keep working in the background
  if (s.agent !== 'claude') return void sessions.delete(sessionId);
  if (!s.existsOnDisk && !findTranscript(sessionId)) return; // a new chat without history: nothing to reopen it from
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

/** What the given answers of a chat changed in a file (for the diff window). */
export function fileChanges(sessionId: string, turnIds: string[], file: string) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Чат не открыт');
  return s.builder.changesFor(turnIds, file);
}

/** A Claude process for control requests (rewind, MCP) even when no question is running. */
function ensureProcess(s: ChatSession) {
  if (s.agent !== 'claude') throw new Error(`Это есть только у Claude Code, а этот чат — с ${AGENT_NAMES[s.agent]}`);
  if (s.remote) throw new Error('В режиме /RC это недоступно — выключите /RC');
  if (!s.q) start(s);
  return s.q!;
}

/** The transcript entry right before a turn's question: where a rewound chat continues from. */
function entryBefore(sessionId: string, turnId: string): string | null {
  const file = findTranscript(sessionId);
  if (!file) return null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes(turnId)) continue;
    try {
      const e = JSON.parse(line);
      if (e.uuid === turnId) return e.parentUuid ?? null;
    } catch {
      /* partial line */
    }
  }
  return null;
}

/** What rewinding to before this question would do to files (dry run). */
export async function rewindPreview(sessionId: string, turnId: string) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Чат не открыт');
  const files = await ensureProcess(s)
    .rewindFiles(turnId, { dryRun: true })
    .catch((e: Error) => ({ canRewind: false, error: e.message }) as any);
  return { files, conversation: entryBefore(sessionId, turnId) !== null || s.builder.turns[0]?.id === turnId };
}

/**
 * Rewind to before a question: optionally restores files (checkpoints), and continues the conversation in a new
 * chat forked right before that question (the original chat stays in history). Returns the new chat's id.
 */
export async function rewind(sessionId: string, turnId: string, opts: { files: boolean }) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Чат не открыт');
  if (s.status === 'running' || s.status === 'waiting') throw new Error('Дождитесь конца ответа или нажмите «Стоп»');
  let files: any = null;
  if (opts.files) {
    files = await ensureProcess(s).rewindFiles(turnId);
    if (!files?.canRewind) throw new Error(`Файлы не откатить: ${files?.error ?? 'нет контрольной точки (правка была до включения откатов?)'}`);
  }
  const before = entryBefore(sessionId, turnId);
  const turn = s.builder.turns.find((t) => t.id === turnId);
  const title = `${s.title} (откат)`;
  let id: string;
  if (before) id = (await forkSession(sessionId, { dir: s.cwd, upToMessageId: before, title })).sessionId;
  else {
    // the very first question: an empty new chat
    id = newChat(s.cwd).sessionId;
    sessions.get(id)!.title = title;
  }
  const snap = await openChat(id, s.cwd);
  return { sessionId: id, prompt: turn?.prompt ?? '', files, snapshot: snap };
}

/** A copy of the chat to try another direction; the original stays as it is. */
export async function fork(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Чат не открыт');
  if (!findTranscript(sessionId)) throw new Error('В чате ещё нет истории');
  const { sessionId: id } = await forkSession(sessionId, { dir: s.cwd, title: `${s.title} (ветка)` });
  return openChat(id, s.cwd);
}

/** The chat as Markdown: questions, answers, tool calls in short. */
export function exportMarkdown(sessionId: string): string {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Чат не открыт');
  const out = [`# ${s.title}`, '', `Проект: ${s.cwd}  `, `Сессия: ${s.id}`, ''];
  for (const t of s.builder.turns) {
    out.push(`## ${new Date(t.startedAt).toLocaleString('ru-RU')}`, '', ...t.prompt.split('\n').map((l) => '> ' + l), '');
    for (const m of t.more ?? []) out.push(...m.prompt.split('\n').map((l) => '> ' + l), '');
    if (t.shell) out.push('```', `$ ${t.shell.command}`, t.shell.output, '```', '');
    for (const it of t.items) {
      if (it.kind === 'text') out.push(it.text, '');
      else if (it.kind === 'tool') out.push(`- ⚙ **${it.name}** ${it.path ?? it.summary}${it.error ? ' — ошибка' : ''}`);
    }
    out.push('');
  }
  return out.join('\n');
}

/** Bash mode: runs `!command` in the chat's folder; the output is shown and goes to Claude with the next question. */
export function runShell(sessionId: string, command: string) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Чат не открыт');
  const bash =
    process.platform === 'win32'
      ? [process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')].find(
          (p): p is string => !!p && fs.existsSync(p),
        )
      : '/bin/bash';
  const [file, args] = bash ? [bash, ['-lc', command]] : ['powershell.exe', ['-NoProfile', '-Command', command]];
  const turn = s.builder.startTurn(`!${command}`, Date.now(), randomUUID());
  s.builder.closeTurn();
  const run: ShellRun = { command, output: '', running: true };
  turn.shell = run;
  s.publish(true);
  const child = spawn(file, args as string[], { cwd: s.cwd, windowsHide: true, env: process.env });
  const add = (d: Buffer) => {
    run.output = (run.output + d.toString()).slice(-100_000);
    s.publish();
  };
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  const timer = setTimeout(() => child.kill(), 10 * 60_000);
  child.on('close', (code) => {
    clearTimeout(timer);
    run.running = false;
    run.code = code;
    turn.answeredAt = Date.now();
    const out = run.output.length > 30_000 ? run.output.slice(-30_000) : run.output;
    s.shellContext.push(`<bash-input>${command}</bash-input>\n<bash-stdout>${out}</bash-stdout>`);
    s.publish(true);
  });
  child.on('error', (e) => {
    run.output += `\n${e.message}`;
    run.running = false;
    run.code = -1;
    s.publish(true);
  });
}

export async function stopTask(sessionId: string, taskId: string) {
  const s = sessions.get(sessionId);
  if (!s?.q) throw new Error('Процесс Claude не запущен');
  await s.q.stopTask(taskId);
}

/** MCP servers of the chat's Claude process, with actions. */
export async function mcpAction(sessionId: string, name: string, action: 'reconnect' | 'enable' | 'disable') {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Чат не открыт');
  const q = ensureProcess(s);
  if (action === 'reconnect') await q.reconnectMcpServer(name);
  else await q.toggleMcpServer(name, action === 'enable');
  return q.mcpServerStatus();
}

export async function mcpList(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Чат не открыт');
  return ensureProcess(s).mcpServerStatus();
}

/** `claude plugin list` output for /plugin (installing goes through the same CLI). */
export function pluginList(): Promise<string> {
  const cli = claudeExecutable();
  if (!cli) return Promise.resolve('Claude Code не найден');
  return new Promise((resolve) => {
    execFile(cli, ['plugin', 'list'], { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => resolve((stdout || stderr || err?.message || '').trim()));
  });
}

/** Permission mode of a chat, switched in place (e.g. after accepting a plan: accept edits). */
export async function setMode(sessionId: string, mode: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.permissionMode = mode;
  await s.q?.setPermissionMode(mode as any).catch(() => {});
  s.publish(true);
}

/**
 * Model, quality and permission mode picked in the composer: saved for the chat right away (not only when a
 * question is sent) and applied to a running process in place.
 */
export async function setOptions(sessionId: string, o: { model?: string; effort?: string; permissionMode?: string }) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (o.model !== undefined && (o.model || undefined) !== s.model) {
    s.model = o.model || undefined;
    await s.q?.setModel(modelArg(s.model)).catch(() => {});
  }
  if (o.effort !== undefined && (o.effort || undefined) !== s.effort) {
    s.effort = o.effort || undefined;
    await s.q?.applyFlagSettings({ effortLevel: (s.effort as any) ?? null }).catch(() => {});
  }
  if (o.permissionMode !== undefined && o.permissionMode !== (s.permissionMode ?? '')) {
    s.permissionMode = o.permissionMode || undefined;
    if (o.permissionMode) await s.q?.setPermissionMode(o.permissionMode as any).catch(() => {});
  }
  rememberChatModel(s);
  s.publish(true);
}

// --- other chats, read-only, for the editor MCP tools (debugging one chat from another) ---------------------------

function chatInfo(s: ChatSession) {
  const last = s.builder.turns[s.builder.turns.length - 1];
  return {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    agent: s.agent,
    model: s.model ?? null,
    status: s.status,
    remoteControl: s.remote,
    processRunning: !!s.q || !!(s.remoteProc && s.remoteProc.exited === undefined),
    waitingFor: [...s.pending.values()].map((p) => p.req.toolName),
    lastActivity: new Date(s.lastActivity).toISOString(),
    stallRestarts: s.stallRestarts,
    turns: s.builder.turns.length,
    lastPrompt: last?.prompt.slice(0, 300),
    lastTurnLive: !!last?.live,
    queuedHere: s.remoteQueue.map((q) => q.text.slice(0, 200)),
    transcript: findTranscript(s.id),
  };
}

chatAccess.list = () => [...sessions.values()].map(chatInfo);
chatAccess.query = (id: string) => sessions.get(id)?.q ?? null;

chatAccess.read = async (query: string, n: number, full: boolean) => {
  const q = query.trim().toLowerCase();
  let s = [...sessions.values()].find((x) => x.id.startsWith(q)) ?? [...sessions.values()].find((x) => x.title.toLowerCase() === q) ?? [...sessions.values()].find((x) => x.title.toLowerCase().includes(q));
  let builder = s?.builder;
  let file = s ? findTranscript(s.id) : null;
  if (!s) {
    // a chat that isn't open: by its full id, from the history on disk
    file = /^[0-9a-f-]{36}$/.test(q) ? findTranscript(q) : null;
    if (!file) return { error: `Чат «${query}» не найден среди открытых (${[...sessions.values()].map((x) => x.title).join(', ')}); закрытый — укажите полный id` };
    builder = (await loadTranscript(file)).builder;
  }
  const cut = (t: string | undefined, len: number) => (t && t.length > len ? t.slice(0, len) + `… (+${t.length - len})` : t);
  const turns = builder!.turns.slice(-n).map((t: any) => ({
    startedAt: new Date(t.startedAt).toISOString(),
    prompt: cut(t.prompt, full ? 4000 : 600),
    more: t.more?.map((x: any) => ({ prompt: cut(x.prompt, 600), at: new Date(x.at).toISOString(), queuedNotTaken: !!x.pending })),
    live: !!t.live,
    error: t.error,
    items: t.items.map((i: any) =>
      i.kind === 'tool'
        ? { tool: i.name, summary: i.summary, done: !!i.done, error: i.error || undefined, errorText: cut(i.errorText, 1000), ...(full ? { detail: cut(i.detail, 2000), output: cut(i.output, 2000) } : {}) }
        : { [i.kind]: cut(i.text, full ? 6000 : 800) },
    ),
  }));
  return {
    ...(s ? chatInfo(s) : { id: q, open: false, transcript: file }),
    pendingRequests: s ? [...s.pending.values()].map((p) => ({ tool: p.req.toolName, input: p.req.input })) : [],
    turns,
  };
};

// --- usage limit: an answer cut off by «You've hit your … limit · resets 6:30pm» goes on after the reset -----------

const LIMIT_GRACE = 15_000;
setInterval(() => {
  const now = Date.now();
  const on = stateFile.data.limitResume !== false;
  for (const s of sessions.values()) {
    if (s.agent !== 'claude') continue;
    const last = s.builder.turns[s.builder.turns.length - 1];
    if (!last || s.status === 'running' || s.status === 'waiting') continue;
    const texts = last.items.filter((i) => i.kind === 'text').slice(-2).map((i: any) => i.text as string);
    const text = [last.error ?? '', ...texts].join('\n');
    const key = `${last.id}:${last.items.length}`;
    if (s.limitResume?.key === key) {
      if (!on && !s.limitResume.done) {
        s.limitResume = null;
        s.publish(true);
      } else if (on && !s.limitResume.done && now >= s.limitResume.at) {
        s.limitResume.done = true;
        s.limitResumedAt = now;
        s.publish(true);
        emit({ type: 'toast', text: `«${s.title}»: лимит сбросился — продолжаю` });
        void send(s.id, 'Лимит сбросился. Продолжай с того места, где остановился (ответ оборвался из-за лимита).', { model: s.model, effort: s.effort, permissionMode: s.permissionMode }).catch((e) =>
          emit({ type: 'toast', text: `«${s.title}»: продолжить после лимита не вышло — ${e?.message ?? e}`, kind: 'error' }),
        );
      }
      continue;
    }
    if (!on) continue;
    const reset = /limit/i.test(text) ? limitResetAt(text, last.startedAt) : undefined;
    if (!reset) {
      if (s.limitResume) {
        s.limitResume = null;
        s.publish(true);
      }
      continue;
    }
    // an old cut-off (the reset was long ago, the app was closed meanwhile) is not picked up again
    if (now > reset + 3 * 3600_000) continue;
    // the limit hit again right after going on (not reset yet): «resets 11:30pm» now reads as tomorrow — retry soon
    let at = reset + LIMIT_GRACE;
    if (s.limitResumedAt && now - s.limitResumedAt < 15 * 60_000 && at - now > 3600_000) {
      if ((s.limitRetries = (s.limitRetries ?? 0) + 1) > 3) continue;
      at = now + 2 * 60_000;
    } else s.limitRetries = 0;
    s.limitResume = { key, at, done: false };
    s.publish(true);
  }
}, 5_000).unref();

// --- connectors that need a sign-in: a «Войти» card in the chat; after the browser sign-in the chat reconnects ------

const CONNECTORS_URL = 'https://claude.ai/settings/connectors';

async function refreshMcpAuth(s: ChatSession) {
  const q = s.q;
  if (!q) return;
  const list: any[] | null = await q.mcpServerStatus().catch(() => null);
  if (!list) return;
  const bad = list
    .filter((x) => x.status === 'needs-auth' || (x.status === 'failed' && (x.scope === 'claudeai' || x.source === 'claudeai')))
    .map((x) => {
      const was = s.mcpAuth.find((a) => a.name === x.name);
      return { name: x.name as string, status: x.status as string, waiting: was?.waiting, asked: was?.asked };
    });
  if (JSON.stringify(bad) !== JSON.stringify(s.mcpAuth)) {
    s.mcpAuth = bad;
    s.publish(true);
  }
}

setInterval(() => {
  for (const s of sessions.values()) if (s.q && s.agent === 'claude') void refreshMcpAuth(s);
}, 120_000).unref();

/** «Войти»: the connectors page of claude.ai in the browser, then reconnect every 10 s (5 min) until it's connected. */
export async function mcpLogin(sessionId: string, name: string) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Чат не открыт');
  await shell.openExternal(CONNECTORS_URL);
  const mark = (waiting: boolean) => {
    const e = s.mcpAuth.find((a) => a.name === name);
    if (e) e.waiting = waiting;
    else s.mcpAuth.push({ name, status: 'needs-auth', waiting });
    s.publish(true);
  };
  mark(true);
  const until = Date.now() + 5 * 60_000;
  while (Date.now() < until && sessions.has(sessionId)) {
    await new Promise((r) => setTimeout(r, 10_000));
    const q = s.q;
    if (!q) continue;
    await q.reconnectMcpServer(name).catch(() => {});
    const st: any = ((await q.mcpServerStatus().catch(() => [])) as any[]).find((x) => x.name === name);
    if (st?.status === 'connected') {
      s.mcpAuth = s.mcpAuth.filter((a) => a.name !== name);
      s.publish(true);
      emit({ type: 'toast', text: `«${name}» подключён` });
      // the chat was waiting for it: go on without «готово»
      if (s.status === 'idle') await send(s.id, `Коннектор «${name}» подключён (вход выполнен). Продолжай с того места, где остановился.`, { model: s.model, effort: s.effort, permissionMode: s.permissionMode }).catch(() => {});
      return true;
    }
  }
  mark(false);
  emit({ type: 'toast', text: `«${name}» так и не подключился за 5 минут — нажмите «Войти» ещё раз`, kind: 'error' });
  return false;
}

/** Claude asked (open_connector_settings): the card shows up in that chat too. */
chatAccess.needsLogin = (sessionId: string, name: string) => {
  const s = sessions.get(sessionId);
  if (!s) return;
  // Claude names it loosely («Wiki OutLine»); the server is «claude.ai Wiki OutLine»
  const norm = (x: string) => x.toLowerCase().replace(/^claude\.ai\s+/, '').trim();
  const e = s.mcpAuth.find((a) => norm(a.name) === norm(name));
  if (e) e.asked = true;
  else s.mcpAuth.push({ name, status: 'needs-auth', asked: true });
  s.publish(true);
};
