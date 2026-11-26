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
}

const COLORS = ['#4e8fd6', '#d08a3a', '#5aa36a', '#b065c0', '#c9b440', '#d0606a', '#3fb0b0', '#8a8fe0', '#c07a50', '#7fae3c'];
function colorOf(key: string) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/** Topic of every turn that has one. `manual` — names set by hand (turn id → name). */
export function computeTopics(turns: Turn[], manual: Record<string, string> | undefined): Map<string, Topic> {
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
  // ↩ replies: the quoted question → the latest earlier turn asking it
  turns.forEach((t, i) => {
    const r = splitReply(t.prompt);
    // «✕ Убрать из темы» ("-"): no automatic link either
    if (!r || manual?.[t.id] === "-") return;
    const q = norm(r.question);
    for (let j = i - 1; j >= 0; j--) {
      if (q && norm(ownQuestion(turns[j].prompt)).startsWith(q.slice(0, 120))) {
        union(turns[j].id, t.id);
        break;
      }
    }
  });
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
    const name = named ?? norm(ownQuestion(rootTurn?.prompt ?? '')).slice(0, 40) ?? 'тема';
    const topic = { key: named ? 'n:' + named : root, name: name || 'тема', color: colorOf(named ? 'n:' + named : root), size: ids.length };
    for (const id of ids) out.set(id, topic);
  }
  return out;
}
