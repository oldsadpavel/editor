import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { CompactMark, FileChange, FileEdit, Turn, TurnAttachment, TurnItemTool } from '../shared/types';

/** compact_boundary metadata (SDK message or transcript entry) → mark fields. */
export function compactInfo(m: any): Omit<CompactMark, 'at'> {
  return { trigger: m?.trigger, preTokens: m?.pre_tokens ?? m?.preTokens, postTokens: m?.post_tokens ?? m?.postTokens, durationMs: m?.duration_ms ?? m?.durationMs };
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read']);

export const projectsDir = () => path.join(os.homedir(), '.claude', 'projects');

/** Locates `<sessionId>.jsonl` across all Claude Code project folders. */
export function findTranscript(sessionId: string): string | null {
  const root = projectsDir();
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = path.join(root, d, sessionId + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function ts(v: unknown): number {
  const n = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : Date.now();
}

/** Strips harness wrappers that are not what the user actually typed. */
function cleanPrompt(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, '$1')
    .trim();
}

function isNoisePrompt(text: string): boolean {
  return (
    !text ||
    text.startsWith('<command-name>') ||
    text.startsWith('<local-command') ||
    text.startsWith('<command-message>') ||
    text.startsWith('Caveat: The messages below') ||
    text.startsWith('[Request interrupted')
  );
}

/** Marks the list of attached file paths that the editor appends to a prompt (see claude.ts buildContent). */
export const ATTACHMENTS_HEADER = 'Вложения:';
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

/**
 * Separates the editor's attachment list from the prompt text and pairs it with the inline image blocks.
 * Images attached in this editor are shown from their file (if it still exists), images pasted elsewhere
 * (terminal, IDE plugin) only exist in the transcript and are loaded by reference.
 */
function splitAttachments(text: string, refs: TurnAttachment[]): { prompt: string; attachments: TurnAttachment[] } {
  // attachments without text: cleanPrompt trimmed the blank lines, the prompt starts right with the header
  const only = text.startsWith(`${ATTACHMENTS_HEADER}\n`);
  const at = only ? 0 : text.lastIndexOf(`\n\n${ATTACHMENTS_HEADER}\n`);
  if (at < 0) return { prompt: text, attachments: refs };
  const listed = text
    .slice(at + ATTACHMENTS_HEADER.length + (only ? 1 : 3))
    .split('\n')
    .map((l) => l.replace(/^- /, '').trim())
    .filter(Boolean);
  const attachments: TurnAttachment[] = [];
  let imageNo = 0;
  for (const p of listed) {
    if (!IMAGE_FILE.test(p)) {
      attachments.push({ kind: 'file', path: p });
      continue;
    }
    const ref = refs[imageNo++];
    attachments.push(fs.existsSync(p) || !ref ? { kind: 'image', path: p } : ref);
  }
  return { prompt: only ? '' : text.slice(0, at).trim(), attachments };
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… (ещё ${s.length - n} символов)` : s);

/** Everything about a call worth showing when it's expanded. Edits have the diff window instead. */
function toolDetail(name: string, input: any): string | undefined {
  if (!input || ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read', 'TodoWrite'].includes(name)) return undefined;
  if (name === 'Bash' || name === 'PowerShell') return String(input.command ?? '');
  if (name === 'Agent' || name === 'Task') return String(input.prompt ?? input.description ?? '');
  return cut(JSON.stringify(input, null, 2), 4000);
}

/** Tool result content → text (images become a marker). */
function resultText(c: any): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b: any) => (b.type === 'text' ? b.text : b.type === 'image' ? '[изображение]' : '')).join('\n');
}

/** Bash mode in an interactive Claude: `<bash-input>cmd</bash-input>` and `<bash-stdout>…</bash-stdout>` entries. */
function bashBlocks(text: string): { input?: string; stdout?: string; stderr?: string; rest: string } {
  const pick = (tag: string) => text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];
  const input = pick('bash-input');
  const stdout = pick('bash-stdout');
  const stderr = pick('bash-stderr');
  const rest = text.replace(/<bash-(input|stdout|stderr)>[\s\S]*?<\/bash-\1>/g, '').trim();
  return { input, stdout, stderr, rest };
}

function toolSummary(name: string, input: any): { summary: string; path?: string } {
  const p = input?.file_path ?? input?.notebook_path ?? input?.path;
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return { summary: String(input?.description || input?.command || '').slice(0, 300) };
    case 'Grep':
      return { summary: `«${input?.pattern ?? ''}»${input?.path ? ' в ' + input.path : ''}` };
    case 'Glob':
      return { summary: String(input?.pattern ?? '') };
    case 'WebFetch':
      return { summary: String(input?.url ?? '') };
    case 'WebSearch':
      return { summary: String(input?.query ?? '') };
    case 'Agent':
    case 'Task':
      return { summary: String(input?.description ?? '') };
    case 'TodoWrite':
      return { summary: `${(input?.todos ?? []).length} задач` };
    default:
      if (typeof p === 'string') return { summary: p, path: p };
      return { summary: JSON.stringify(input ?? {}).slice(0, 200) };
  }
}

/**
 * Builds chat turns (question + everything the assistant did in response) from transcript entries.
 * The same builder ingests history lines from JSONL and live SDK messages, so both views match.
 */
export class TurnBuilder {
  turns: Turn[] = [];
  private pendingTools = new Map<string, { turn: Turn; tool: TurnItemTool; input: any; at: number }>();
  /** Every tool call by id (subagent activity can arrive after the call returned). */
  private toolsById = new Map<string, TurnItemTool>();
  /** What each answer changed in each file (for the diff window); kept here, not sent with every snapshot. */
  private changes = new Map<Turn, { path: string; change: FileChange }[]>();

  /** Changes to a file made in the given turns, oldest first. */
  changesFor(turnIds: string[], file: string): { turn: Turn; change: FileChange }[] {
    const key = normalize(file);
    const out: { turn: Turn; change: FileChange }[] = [];
    for (const turn of this.turns) {
      if (!turnIds.includes(turn.id)) continue;
      for (const c of this.changes.get(turn) ?? []) if (normalize(c.path) === key) out.push({ turn, change: c.change });
    }
    return out.sort((a, b) => a.change.at - b.change.at);
  }
  /** Every `git push` command seen, so deploy tracking can attribute pushes to this chat. */
  pushCommands: { at: number; command: string }[] = [];

  /**
   * True from a question until Claude finishes its answer (an assistant message with a final stop_reason).
   * A question that arrives while a turn is open is answered by Claude Code together with it, so it joins that turn.
   */
  private turnOpen = false;

  startTurn(prompt: string, at: number, id: string, attachments?: TurnAttachment[]): Turn {
    const last = this.turns[this.turns.length - 1];
    if (last && this.turnOpen && !last.error) {
      (last.more ??= []).push({ prompt, at, ...(attachments?.length ? { attachments } : {}) });
      last.images += attachments?.filter((a) => a.kind === 'image').length ?? 0;
      return last;
    }
    const images = attachments?.filter((a) => a.kind === 'image').length ?? 0;
    const t: Turn = { id, prompt, images, startedAt: at, items: [], edits: [], reads: [], ...(attachments?.length ? { attachments } : {}) };
    this.turns.push(t);
    this.turnOpen = true;
    return t;
  }

  isTurnOpen() {
    return this.turnOpen;
  }

  /** The current answer is over (result, interruption, error): the next question starts a new turn. */
  closeTurn() {
    this.turnOpen = false;
  }

  /**
   * Questions queued into a turn that Claude finished without them: Claude now answers them on their own,
   * so they move out into a new turn (the transcript records them that way too).
   */
  /**
   * Stop pressed while questions were still queued (not yet taken): Claude Code drops the current answer and runs
   * them next, so they move out into a new turn right away. Questions Claude already took stay where they are.
   */
  splitPending(at: number): Turn | null {
    const last = this.turns[this.turns.length - 1];
    const pending = last?.more?.filter((m) => m.pending) ?? [];
    if (!last || !pending.length) return null;
    last.more = last.more!.filter((m) => !m.pending);
    if (!last.more.length) delete last.more;
    last.images -= pending.reduce((n, m) => n + (m.attachments?.filter((a) => a.kind === 'image').length ?? 0), 0);
    this.closeTurn();
    const [first, ...rest] = pending;
    const turn = this.startTurn(first.prompt, at, `${last.id}-q${this.turns.length}`, first.attachments);
    if (rest.length) {
      turn.more = rest.map((m) => ({ ...m, pending: false }));
      turn.images += rest.reduce((n, m) => n + (m.attachments?.filter((a) => a.kind === 'image').length ?? 0), 0);
    }
    return turn;
  }

  splitQueued(): Turn | null {
    const last = this.turns[this.turns.length - 1];
    if (!last?.more?.length || this.turnOpen) return null;
    const [first, ...rest] = last.more;
    delete last.more;
    first.pending = false;
    last.images -= [first, ...rest].reduce((n, m) => n + (m.attachments?.filter((a) => a.kind === 'image').length ?? 0), 0);
    const turn = this.startTurn(first.prompt, first.at, `${last.id}-q`, first.attachments);
    if (rest.length) {
      turn.more = rest;
      turn.images += rest.reduce((n, m) => n + (m.attachments?.filter((a) => a.kind === 'image').length ?? 0), 0);
    }
    return turn;
  }

  /** API message ids already counted: one API response is written as several entries sharing its usage. */
  private countedMessages = new Set<string>();

  private countTokens(turn: Turn, message: any) {
    const u = message?.usage;
    if (!u || (message.id && this.countedMessages.has(message.id))) return;
    if (message.id) this.countedMessages.add(message.id);
    this.lastContext = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const t = (turn.tokens ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    t.input += u.input_tokens ?? 0;
    t.output += u.output_tokens ?? 0;
    t.cacheRead += u.cache_read_input_tokens ?? 0;
    t.cacheWrite += u.cache_creation_input_tokens ?? 0;
  }

  private current(at: number): Turn {
    return this.turns[this.turns.length - 1] ?? this.startTurn('(без вопроса)', at, 'start');
  }

  ingest(entry: any) {
    if (!entry || entry.isSidechain) return;
    const at = ts(entry.timestamp);
    if (entry.type === 'user') this.ingestUser(entry, at);
    else if (entry.type === 'assistant') this.ingestAssistant(entry, at);
    else if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') this.ingestQueued(entry.attachment, at);
    else if (entry.type === 'system' && entry.subtype === 'model_refusal_fallback') this.addFallback(entry, at);
    else if (entry.type === 'system' && entry.subtype === 'compact_boundary') this.addCompact({ at, ...compactInfo(entry.compactMetadata ?? entry.compact_metadata) });
  }

  /** Safeguards stopped the answer and Claude Code went on with another model. */
  addFallback(e: any, at: number) {
    const turn = this.turns[this.turns.length - 1];
    if (!turn) return;
    const category = e.apiRefusalCategory ?? String(e.content ?? '').match(/\[(\w+)\]/)?.[1];
    (turn.fallbacks ??= []).push({ from: e.originalModel, to: e.fallbackModel, category, at });
  }

  /** Context size of the latest request (fresh input + cache reads + cache writes). */
  lastContext = 0;

  /** A history compaction: marked in the answer during which it happened (or the last one). */
  addCompact(mark: CompactMark) {
    const turn = this.turns[this.turns.length - 1];
    if (turn) (turn.compacts ??= []).push(mark);
  }

  private ingestUser(entry: any, at: number) {
    const content = entry.message?.content;
    if (entry.isMeta || entry.isCompactSummary) return;
    if (typeof content === 'string' && this.ingestBash(content, at, entry.uuid)) return;
    if (typeof content === 'string') {
      // A plain string too can carry the attachment list (prompts typed into an interactive Claude, e.g. /RC).
      const { prompt: text, attachments } = splitAttachments(cleanPrompt(content), []);
      if (text.startsWith('[Request interrupted')) this.closeTurn();
      if (!isNoisePrompt(text) || attachments.length) this.startTurn(text, at, entry.uuid ?? String(at), attachments);
      return;
    }
    if (!Array.isArray(content)) return;
    let text = '';
    const refs: TurnAttachment[] = [];
    content.forEach((block: any, index: number) => {
      if (block.type === 'tool_result') this.finishTool(block, at, entry.toolUseResult);
      else if (block.type === 'text') text += (text ? '\n' : '') + block.text;
      else if (block.type === 'image' && entry.uuid) refs.push({ kind: 'image', ref: { uuid: entry.uuid, index }, mediaType: block.source?.media_type });
    });
    const { prompt, attachments } = splitAttachments(cleanPrompt(text), refs);
    if (prompt.startsWith('[Request interrupted')) this.closeTurn();
    if ((prompt && !isNoisePrompt(prompt)) || attachments.length) this.startTurn(prompt, at, entry.uuid ?? String(at), attachments);
  }

  /**
   * Bash mode: a command typed with `!` (its own turn, output attached), or the editor's way — commands run here and
   * passed to Claude in front of the next question (listed on that question). Returns true when the entry was bash-only.
   */
  private ingestBash(raw: string, at: number, uuid?: string): boolean {
    if (!raw.includes('<bash-')) return false;
    const b = bashBlocks(raw);
    if (b.input !== undefined && !b.rest) {
      const turn = this.startTurn(`!${b.input}`, at, uuid ?? String(at));
      turn.shell = { command: b.input, output: '' };
      return true;
    }
    if (b.input === undefined && (b.stdout !== undefined || b.stderr !== undefined) && !b.rest) {
      const last = this.turns[this.turns.length - 1];
      if (last?.shell) {
        last.shell.output = [b.stdout, b.stderr].filter(Boolean).join('\n');
        this.closeTurn();
      }
      return true;
    }
    if (b.input !== undefined && b.rest) {
      // the editor's context block in front of a question
      const commands = [...raw.matchAll(/<bash-input>([\s\S]*?)<\/bash-input>/g)].map((m) => m[1]);
      const { prompt, attachments } = splitAttachments(cleanPrompt(b.rest), []);
      const turn = this.startTurn(prompt, at, uuid ?? String(at), attachments);
      turn.shellContext = commands;
      return true;
    }
    return false;
  }

  /** Activity of a subagent, shown under its Agent/Task call while it runs. */
  addSub(toolUseId: string, lines: string[]) {
    // a background agent returns at once ("launched"), so look among finished calls too
    const tool = this.pendingTools.get(toolUseId)?.tool ?? this.toolsById.get(toolUseId);
    if (!tool || !lines.length) return;
    const sub = (tool.sub ??= []);
    sub.push(...lines);
    if (sub.length > 60) sub.splice(0, sub.length - 60);
  }

  /** A question sent while Claude was working and taken into the running answer (not a separate user entry). */
  private ingestQueued(a: any, at: number) {
    const prompt = cleanPrompt(String(a.prompt ?? ''));
    const last = this.turns[this.turns.length - 1];
    if (!prompt || isNoisePrompt(prompt) || !last) return;
    if (last.prompt === prompt || last.more?.some((m) => m.prompt === prompt)) return;
    (last.more ??= []).push({ prompt, at: a.timestamp ? ts(a.timestamp) : at });
  }

  private ingestAssistant(entry: any, at: number) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) return;
    const turn = this.current(at);
    this.countTokens(turn, entry.message);
    const model = entry.message?.model;
    if (typeof model === 'string' && model !== '<synthetic>' && !turn.models?.includes(model)) (turn.models ??= []).push(model);
    // tool_use means Claude keeps working; any other stop reason ends its answer.
    const stop = entry.message?.stop_reason;
    if (stop && stop !== 'tool_use' && stop !== 'pause_turn') this.closeTurn();
    for (const block of content) {
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        const last = turn.items[turn.items.length - 1];
        if (last?.kind === 'thinking') last.text += '\n\n' + block.thinking;
        else turn.items.push({ kind: 'thinking', text: block.thinking });
      } else if (block.type === 'text' && block.text?.trim()) {
        const last = turn.items[turn.items.length - 1];
        if (last?.kind === 'text') last.text += '\n\n' + block.text;
        else turn.items.push({ kind: 'text', text: block.text });
        turn.answeredAt = at;
      } else if (block.type === 'tool_use') {
        const { summary, path: p } = toolSummary(block.name, block.input);
        const tool: TurnItemTool = { kind: 'tool', id: block.id, name: block.name, summary, path: p, detail: toolDetail(block.name, block.input) };
        if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) turn.todos = block.input.todos;
        turn.items.push(tool);
        turn.answeredAt = at;
        this.pendingTools.set(block.id, { turn, tool, input: block.input, at });
        this.toolsById.set(block.id, tool);
        const cmd = String(block.input?.command ?? '');
        if (/\bgit\b[^\n]*\bpush\b/.test(cmd)) this.pushCommands.push({ at, command: cmd });
      }
    }
  }

  private finishTool(block: any, at: number, _result: any) {
    const pending = this.pendingTools.get(block.tool_use_id);
    if (!pending) return;
    this.pendingTools.delete(block.tool_use_id);
    const { turn, tool, input } = pending;
    tool.done = true;
    tool.error = !!block.is_error;
    turn.answeredAt = Math.max(turn.answeredAt ?? 0, at);
    if (!['Read', 'TodoWrite'].includes(tool.name)) {
      const out = resultText(block.content).trim();
      if (out) tool.output = cut(out, 12000);
    }
    if (tool.error) {
      const c = block.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => b.text ?? '').join('\n') : '';
      tool.errorText = text.replace(/<\/?tool_use_error>/g, '').trim().slice(0, 2000) || 'Инструмент вернул ошибку';
      return;
    }
    const file = input?.file_path ?? input?.notebook_path;
    if (typeof file !== 'string') return;
    if (EDIT_TOOLS.has(tool.name)) {
      const isWrite = tool.name === 'Write';
      const count = tool.name === 'MultiEdit' ? (input.edits?.length ?? 1) : isWrite ? 0 : 1;
      addEdit(turn.edits, file, count, isWrite ? 1 : 0, pending.at);
      const change: FileChange =
        tool.name === 'Write'
          ? { tool: tool.name, at: pending.at, content: String(input.content ?? '') }
          : tool.name === 'MultiEdit'
            ? { tool: tool.name, at: pending.at, edits: (input.edits ?? []).map((e: any) => ({ old: String(e.old_string ?? ''), new: String(e.new_string ?? ''), all: !!e.replace_all })) }
            : tool.name === 'Edit'
              ? { tool: tool.name, at: pending.at, edits: [{ old: String(input.old_string ?? ''), new: String(input.new_string ?? ''), all: !!input.replace_all }] }
              : { tool: tool.name, at: pending.at, content: String(input.new_source ?? '') };
      (this.changes.get(turn) ?? this.changes.set(turn, []).get(turn)!).push({ path: file, change });
    } else if (READ_TOOLS.has(tool.name) && !turn.reads.includes(file)) {
      turn.reads.push(file);
    }
  }

  markInterrupted() {
    this.closeTurn();
    for (const { tool } of this.pendingTools.values()) {
      tool.done = true;
      tool.error = true;
    }
    this.pendingTools.clear();
  }
}

function addEdit(list: FileEdit[], file: string, count: number, writes: number, at: number) {
  const key = normalize(file);
  let e = list.find((x) => normalize(x.path) === key);
  if (!e) {
    e = { path: file, count: 0, writes: 0, firstAt: at, lastAt: at };
    list.push(e);
  }
  e.count += count;
  e.writes += writes;
  e.firstAt = Math.min(e.firstAt, at);
  e.lastAt = Math.max(e.lastAt, at);
}

export const normalize = (p: string) => path.normalize(p).toLowerCase();

/** All files edited in a chat, latest change first. */
export function aggregateEdits(turns: Turn[]): FileEdit[] {
  const all: FileEdit[] = [];
  for (const t of turns) for (const e of t.edits) {
    const key = normalize(e.path);
    const ex = all.find((x) => normalize(x.path) === key);
    if (!ex) all.push({ ...e });
    else {
      ex.count += e.count;
      ex.writes += e.writes;
      ex.firstAt = Math.min(ex.firstAt, e.firstAt);
      ex.lastAt = Math.max(ex.lastAt, e.lastAt);
    }
  }
  return all.sort((a, b) => b.lastAt - a.lastAt);
}


/** Parses a transcript file line by line (some transcripts are hundreds of MB). */
/** A transcript untouched this long with an unfinished answer at the end: nobody is working on it any more. */
const STALE_MS = 3 * 60_000;

/**
 * Reads a transcript into turns. An unfinished answer at the end stays open (`builder.isTurnOpen()`) while the file
 * is fresh — a terminal, the phone (/RC) or an IDE plugin is still working on it; an old one counts as interrupted.
 * Always a fresh builder: callers keep and mutate it.
 */
export async function loadTranscript(file: string): Promise<{ builder: TurnBuilder; cwd?: string }> {
  const st = fs.statSync(file);
  const builder = new TurnBuilder();
  let cwd: string | undefined;
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"queued_command"') && !line.includes('"compact_boundary"') && !line.includes('"model_refusal_fallback"')) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && entry.cwd) cwd = entry.cwd;
    builder.ingest(entry);
  }
  if (Date.now() - st.mtimeMs > STALE_MS) builder.markInterrupted();
  return { builder, cwd };
}
