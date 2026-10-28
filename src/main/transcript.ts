import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { FileEdit, Turn, TurnItemTool } from '../shared/types';

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
  /** Every `git push` command seen, so deploy tracking can attribute pushes to this chat. */
  pushCommands: { at: number; command: string }[] = [];

  startTurn(prompt: string, at: number, id: string, images = 0): Turn {
    const t: Turn = { id, prompt, images, startedAt: at, items: [], edits: [], reads: [] };
    this.turns.push(t);
    return t;
  }

  private current(at: number): Turn {
    return this.turns[this.turns.length - 1] ?? this.startTurn('(без вопроса)', at, 'start');
  }

  ingest(entry: any) {
    if (!entry || entry.isSidechain) return;
    const at = ts(entry.timestamp);
    if (entry.type === 'user') this.ingestUser(entry, at);
    else if (entry.type === 'assistant') this.ingestAssistant(entry, at);
  }

  private ingestUser(entry: any, at: number) {
    const content = entry.message?.content;
    if (entry.isMeta || entry.isCompactSummary) return;
    if (typeof content === 'string') {
      const text = cleanPrompt(content);
      if (!isNoisePrompt(text)) this.startTurn(text, at, entry.uuid ?? String(at));
      return;
    }
    if (!Array.isArray(content)) return;
    let text = '';
    let images = 0;
    for (const block of content) {
      if (block.type === 'tool_result') this.finishTool(block, at, entry.toolUseResult);
      else if (block.type === 'text') text += (text ? '\n' : '') + block.text;
      else if (block.type === 'image') images++;
    }
    text = cleanPrompt(text);
    if ((text && !isNoisePrompt(text)) || images) this.startTurn(text, at, entry.uuid ?? String(at), images);
  }

  private ingestAssistant(entry: any, at: number) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) return;
    const turn = this.current(at);
    for (const block of content) {
      if (block.type === 'text' && block.text?.trim()) {
        const last = turn.items[turn.items.length - 1];
        if (last?.kind === 'text') last.text += '\n\n' + block.text;
        else turn.items.push({ kind: 'text', text: block.text });
        turn.answeredAt = at;
      } else if (block.type === 'tool_use') {
        const { summary, path: p } = toolSummary(block.name, block.input);
        const tool: TurnItemTool = { kind: 'tool', id: block.id, name: block.name, summary, path: p };
        turn.items.push(tool);
        turn.answeredAt = at;
        this.pendingTools.set(block.id, { turn, tool, input: block.input, at });
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
    if (tool.error) return;
    const file = input?.file_path ?? input?.notebook_path;
    if (typeof file !== 'string') return;
    if (EDIT_TOOLS.has(tool.name)) {
      const isWrite = tool.name === 'Write';
      const count = tool.name === 'MultiEdit' ? (input.edits?.length ?? 1) : isWrite ? 0 : 1;
      addEdit(turn.edits, file, count, isWrite ? 1 : 0, pending.at);
    } else if (READ_TOOLS.has(tool.name) && !turn.reads.includes(file)) {
      turn.reads.push(file);
    }
  }

  markInterrupted() {
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

const cache = new Map<string, { mtime: number; size: number; builder: TurnBuilder; cwd?: string }>();

/** Parses a transcript file line by line (some transcripts are hundreds of MB). */
export async function loadTranscript(file: string): Promise<{ builder: TurnBuilder; cwd?: string }> {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit;
  const builder = new TurnBuilder();
  let cwd: string | undefined;
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && entry.cwd) cwd = entry.cwd;
    builder.ingest(entry);
  }
  builder.markInterrupted();
  const value = { mtime: st.mtimeMs, size: st.size, builder, cwd };
  cache.set(file, value);
  return value;
}
