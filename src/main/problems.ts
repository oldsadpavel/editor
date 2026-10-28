import { randomUUID } from 'node:crypto';
import type { Problem } from '../shared/types';
import { emit } from './bus';
import { problemsFile } from './store';

const MAX_PROBLEMS = 200;

function publish() {
  problemsFile.save();
  emit({ type: 'problems', problems: problemsFile.data });
}

/**
 * Records a problem. A problem with the same key (source + title + session/path) replaces
 * the older one instead of piling up duplicates.
 */
export function report(p: Omit<Problem, 'id' | 'at'> & { key?: string }) {
  const key = p.key ?? `${p.source}|${p.title}|${p.sessionId ?? ''}|${p.path ?? ''}`;
  const list = problemsFile.data.filter((x) => x.id !== key);
  const { key: _k, ...rest } = p;
  list.unshift({ ...rest, id: key, at: Date.now(), acknowledged: false });
  problemsFile.data = list.slice(0, MAX_PROBLEMS);
  publish();
}

/** Removes problems whose id starts with the prefix (e.g. resolved key or deploy issues). */
export function resolve(prefix: string) {
  const before = problemsFile.data.length;
  problemsFile.data = problemsFile.data.filter((x) => !x.id.startsWith(prefix));
  if (problemsFile.data.length !== before) publish();
}

export function acknowledge(id?: string) {
  for (const p of problemsFile.data) if (!id || p.id === id) p.acknowledged = true;
  publish();
}

export function remove(id?: string) {
  problemsFile.data = id ? problemsFile.data.filter((x) => x.id !== id) : [];
  publish();
}

export function list() {
  return problemsFile.data;
}

export const newId = () => randomUUID();
