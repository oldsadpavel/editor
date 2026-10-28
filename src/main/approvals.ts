import fs from 'node:fs';
import path from 'node:path';
import type { ApprovalEntry } from '../shared/types';
import { dataDir } from './store';

/**
 * Audit log of every permission decision (manual or auto-approved), one JSON line per decision in
 * approvals.jsonl, so it is always visible what the user allowed and when.
 */
const file = () => path.join(dataDir(), 'approvals.jsonl');
const MAX_PER_CHAT = 300;

export function summarize(toolName: string, input: Record<string, any>): string {
  const s = input.command ?? input.file_path ?? input.notebook_path ?? input.url ?? input.pattern ?? input.plan ?? JSON.stringify(input);
  return String(s).replace(/\s+/g, ' ').slice(0, 300);
}

export function record(e: ApprovalEntry) {
  fs.appendFileSync(file(), JSON.stringify(e) + '\n');
}

export function forChat(sessionId: string): ApprovalEntry[] {
  let text = '';
  try {
    text = fs.readFileSync(file(), 'utf8');
  } catch {
    return [];
  }
  const out: ApprovalEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes(sessionId)) continue;
    try {
      const e = JSON.parse(line) as ApprovalEntry;
      if (e.sessionId === sessionId) out.push(e);
    } catch {
      /* partial line */
    }
  }
  return out.slice(-MAX_PER_CHAT);
}
