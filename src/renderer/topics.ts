import type { Turn } from '../shared/types';

/**
 * Topics in a chat: questions about the same task, while several go on at once. A question sent with ↩ (a quote of an
 * earlier answer) joins that answer's topic by itself; any question can be put into a topic by hand (named ones with
 * the same name are one topic). Turns of a topic get the same colour stripe and label, and the chat can be filtered
 * to one topic.
 */

/** «Это про твой ответ на мой вопрос «…» (time):» + quoted lines + the question (↩ Reply): the parts. */
const REPLY_HEAD = /^Это про (фрагмент твоего ответа|твой ответ) на мой вопрос «(.*?)» \(([^)]*)\):\n/;
export function splitReply(prompt: string): { question: string; quote: string; part: boolean; when: string; rest: string } | null {
  const m = REPLY_HEAD.exec(prompt);
  if (!m) return null;
  const lines = prompt.slice(m[0].length).split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('> ')) i++;
  return { part: m[1].startsWith('фрагмент'), question: m[2], when: m[3], quote: lines.slice(0, i).map((l) => l.slice(2)).join('\n'), rest: lines.slice(i).join('\n').trim() };
}

/** The question as the user wrote it (without a reply quote). */
export const ownQuestion = (prompt: string) => splitReply(prompt)?.rest ?? prompt;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export interface Topic {
  key: string;
  name: string;
  color: string;
  size: number;
  /** Why the questions are together: ↩ replies, a shared memory file, a file edited in both, a task number, a page. */
  reasons: string[];
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
/** Memory notes of a task (Claude's project memory), not the index. */
const isMemory = (p: string) => /[\\/]memory[\\/][^\\/]+\.md$/i.test(p) && !/[\\/]MEMORY\.md$/i.test(p);

/** What ties a turn to others besides ↩: memory files it read or wrote, files it edited, task numbers, page URLs. */
function signals(t: Turn): { key: string; label: string; kind: 'memory' | 'file' | 'task' | 'url' }[] {
  const out: { key: string; label: string; kind: 'memory' | 'file' | 'task' | 'url' }[] = [];
  const files = new Set<string>([...(t.edits ?? []).map((e) => e.path), ...(t.reads ?? [])]);
  for (const i of t.items) if (i.kind === 'tool' && i.path) files.add(i.path);
  for (const f of files) {
    const k = f.replace(/\\/g, '/').toLowerCase();
    if (isMemory(f)) out.push({ key: 'm:' + k, label: 'память ' + base(f), kind: 'memory' });
  }
  for (const e of t.edits ?? []) out.push({ key: 'f:' + e.path.replace(/\\/g, '/').toLowerCase(), label: 'файл ' + base(e.path), kind: 'file' });
  const text = ownQuestion(t.prompt) + ' ' + (t.more ?? []).map((m) => m.prompt).join(' ');
  for (const m of text.matchAll(/(?:#|задач[аиуе]?\s*№?\s*|task\s*#?)(\d{3,7})\b/gi)) out.push({ key: 't:' + m[1], label: 'задача ' + m[1], kind: 'task' });
  for (const m of text.matchAll(/https?:\/\/[^\s)>»"']+/g)) {
    const u = m[0].replace(/[.,;]+$/, '').replace(/[?#].*$/, '').replace(/\/$/, '');
    if (u.split('/').length > 3) out.push({ key: 'u:' + u.toLowerCase(), label: 'страница ' + u.replace(/^https?:\/\//, ''), kind: 'url' });
  }
  return out;
}

const COLORS = ['#4e8fd6', '#d08a3a', '#5aa36a', '#b065c0', '#c9b440', '#d0606a', '#3fb0b0', '#8a8fe0', '#c07a50', '#7fae3c'];
function colorOf(key: string) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/** Topic of every turn that has one. `manual` — names set by hand (turn id → name). */
export function computeTopics(turns: Turn[], manual: Record<string, string> | undefined, auto = true): Map<string, Topic> {
  const reasons = new Map<string, Set<string>>(); // root-independent: turn id → why it is linked
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // the earlier turn stays the root (its question names the topic)
    const ia = turns.findIndex((t) => t.id === ra);
    const ib = turns.findIndex((t) => t.id === rb);
    if (ia <= ib) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  for (const t of turns) parent.set(t.id, t.id);
  const note = (id: string, why: string) => reasons.set(id, (reasons.get(id) ?? new Set()).add(why));
  // ↩ replies: the quoted question → the latest earlier turn asking it
  turns.forEach((t, i) => {
    const r = splitReply(t.prompt);
    // «✕ Убрать из темы» ("-"): no automatic link either
    if (!r || manual?.[t.id] === "-") return;
    const q = norm(r.question);
    for (let j = i - 1; j >= 0; j--) {
      if (q && norm(ownQuestion(turns[j].prompt)).startsWith(q.slice(0, 120))) {
        union(turns[j].id, t.id);
        note(t.id, '↩ ответ на ответ');
        break;
      }
    }
  });
  // shared memory notes, rarely edited files, task numbers, pages — a file nearly every question touches links nothing
  if (auto) {
    const users = new Map<string, { label: string; kind: string; ids: string[] }>();
    for (const t of turns) {
      if (manual?.[t.id] === '-') continue;
      for (const s of signals(t)) {
        const u = users.get(s.key) ?? { label: s.label, kind: s.kind, ids: [] };
        if (!u.ids.includes(t.id)) u.ids.push(t.id);
        users.set(s.key, u);
      }
    }
    const limit = { memory: 12, file: 4, task: 30, url: 12 } as Record<string, number>;
    for (const u of users.values()) {
      if (u.ids.length < 2 || u.ids.length > limit[u.kind]) continue;
      for (const id of u.ids.slice(1)) union(u.ids[0], id);
      for (const id of u.ids) note(id, u.label);
    }
  }
  // hand-made: one name — one topic
  const byName = new Map<string, string>();
  for (const t of turns) {
    const name = manual?.[t.id];
    if (!name || name === "-") continue;
    const first = byName.get(name);
    if (first) union(first, t.id);
    else byName.set(name, t.id);
  }
  const groups = new Map<string, string[]>();
  for (const t of turns) {
    const r = find(t.id);
    groups.set(r, [...(groups.get(r) ?? []), t.id]);
  }
  const out = new Map<string, Topic>();
  for (const [root, ids] of groups) {
    const named = ids.map((id) => manual?.[id]).find((n) => n && n !== '-');
    if (ids.length < 2 && !named) continue;
    const rootTurn = turns.find((t) => t.id === root);
    const why = new Set<string>();
    for (const id of ids) for (const r of reasons.get(id) ?? []) why.add(r);
    // the first question names the topic; without text (a background-task note) — what ties it together
    const name = named ?? (norm(ownQuestion(rootTurn?.prompt ?? '')).slice(0, 40) || [...why].find((w) => !w.startsWith('↩'))?.replace(/^(память|файл|страница) /, '').replace(/\.md$/, '') || 'тема');
    if (named) why.add('вручную');
    const topic = { key: named ? 'n:' + named : root, name, color: colorOf(named ? 'n:' + named : root), size: ids.length, reasons: [...why].slice(0, 8) };
    for (const id of ids) out.set(id, topic);
  }
  return out;
}
