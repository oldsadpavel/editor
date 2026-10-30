import { useEffect, useRef, useState } from 'react';
import { get, set, useStore } from '../store';
import { basename, dirname, relPath } from '../util';
import { fileIcon } from './icons';

/** Open files, most recently used first (the active one on top). */
const mru: string[] = [];

/**
 * Ctrl+Tab: the open documents, most recently used first, like in an IDE. Holding Ctrl, Tab / Shift+Tab or the
 * arrows move the highlight; releasing Ctrl opens it, Esc closes the list.
 */
export function Switcher() {
  const active = useStore((s) => s.activeFile);
  const files = useStore((s) => s.files);
  const projects = useStore((s) => s.app?.projects ?? []);
  const [index, setIndex] = useState<number | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;

  useEffect(() => {
    if (!active) return;
    const i = mru.indexOf(active);
    if (i >= 0) mru.splice(i, 1);
    mru.unshift(active);
  }, [active]);

  const ordered = () => {
    const open = get().files.map((f) => f.path);
    return [...mru.filter((p) => open.includes(p)), ...open.filter((p) => !mru.includes(p))];
  };

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const list = ordered();
      if (e.key === 'Tab' && e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        if (!list.length) return;
        const cur = indexRef.current;
        const step = e.shiftKey ? -1 : 1;
        // first press goes straight to the previous document
        setIndex(cur === null ? Math.min(1, list.length - 1) : (cur + step + list.length) % list.length);
        return;
      }
      if (indexRef.current === null) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setIndex((i) => ((i ?? 0) + step + list.length) % list.length);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setIndex(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        pick(list[indexRef.current]);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== 'Control' || indexRef.current === null) return;
      pick(ordered()[indexRef.current]);
    };
    const onBlur = () => setIndex(null);
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const pick = (p?: string) => {
    setIndex(null);
    if (p) set({ activeFile: p });
  };

  if (index === null) return null;
  const list = ordered();
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();
  /** Folder inside its project (nothing for the project root); outside projects — the full folder. */
  const folder = (p: string) => {
    const dir = dirname(p);
    const root = projects.find((r) => norm(p).startsWith(norm(r.path)))?.path;
    if (!root) return dir;
    return norm(dir) === norm(root) ? '' : relPath(dir.replace(/\//g, '\\'), root.replace(/\//g, '\\'));
  };
  return (
    <div className="switcher-bg" onMouseDown={() => setIndex(null)}>
      <div className="switcher" onMouseDown={(e) => e.stopPropagation()}>
        <div className="switcher-head">Открытые файлы · Ctrl+Tab / Shift+Tab · отпустите Ctrl — открыть</div>
        {list.map((p, i) => {
          const f = files.find((x) => x.path === p);
          const dirty = !!f && f.text !== f.savedText;
          return (
            <div
              key={p}
              className={`switcher-row ${i === index ? 'on' : ''} ${p === active ? 'current' : ''} ${f?.unseen ? 'unseen' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(p)}
              title={p}
            >
              <span className="ficon">{fileIcon(p)}</span>
              <span className="sw-name">{basename(p)}</span>
              {dirty && <span className="dirty">●</span>}
              {f?.unseen && <span className="sw-badge">изменён</span>}
              <span className="sw-dir">{folder(p)}</span>
            </div>
          );
        })}
        {!list.length && <div className="empty">Нет открытых файлов</div>}
      </div>
    </div>
  );
}
