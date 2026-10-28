import { useEffect, useState } from 'react';
import type { DirEntry } from '../../shared/types';
import { call } from '../api';
import { addProjects, get, openFile, saveApp, setUi, toggleFavorite, toast, useStore } from '../store';
import { Help, basename } from '../util';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { fileIcon } from './icons';

const childrenCache = new Map<string, DirEntry[]>();

/** Inserts text into the active chat input (listened to by ChatView). */
export function insertIntoChat(text: string) {
  window.dispatchEvent(new CustomEvent('chat-insert', { detail: text }));
}

function Node({ entry, depth, root, onMenu }: { entry: DirEntry; depth: number; root?: boolean; onMenu: (e: React.MouseEvent, entry: DirEntry, root?: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<DirEntry[] | null>(childrenCache.get(entry.path) ?? null);
  const active = useStore((s) => s.activeFile === entry.path);
  const favorite = useStore((s) => s.app?.favorites.includes(entry.path));

  async function load() {
    try {
      const list = await call<DirEntry[]>('fs:list', entry.path);
      childrenCache.set(entry.path, list);
      setKids(list);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }

  useEffect(() => {
    if (open) void load();
  }, [open]);

  const click = () => (entry.dir ? setOpen(!open) : void openFile(entry.path));
  return (
    <>
      <div
        className={`tree-row ${active ? 'active' : ''} ${root ? 'root' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={click}
        onContextMenu={(e) => onMenu(e, entry, root)}
        title={entry.path}
      >
        <span className="twisty">{entry.dir ? (open ? '▾' : '▸') : ''}</span>
        <span className="ficon">{entry.dir ? (open ? '📂' : '📁') : fileIcon(entry.name)}</span>
        <span className="tname">{entry.name}</span>
        {favorite && !root && <span className="fav-star">★</span>}
        {root && <span className="troot-path">{entry.path}</span>}
      </div>
      {open && kids?.map((k) => <Node key={k.path} entry={k} depth={depth + 1} onMenu={onMenu} />)}
    </>
  );
}

export function TreePanel() {
  const app = useStore((s) => s.app!);
  const tab = app.ui.leftTab === 'favorites' ? 'favorites' : 'projects';
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [, refresh] = useState(0);

  function onMenu(e: React.MouseEvent, entry: DirEntry, root?: boolean) {
    e.preventDefault();
    const fav = get().app!.favorites.includes(entry.path);
    const items: MenuItem[] = [
      ...(entry.dir ? [] : [{ label: 'Открыть', action: () => openFile(entry.path) }]),
      { label: fav ? 'Убрать из избранного' : 'В избранное ★', action: () => toggleFavorite(entry.path) },
      { label: 'Вставить путь в чат', action: () => insertIntoChat(entry.path) },
      { label: 'Копировать путь', action: () => navigator.clipboard.writeText(entry.path) },
      { label: 'Показать в проводнике', action: () => call('shell:reveal', entry.path) },
      ...(entry.dir
        ? [
            {
              label: 'Обновить',
              action: () => {
                childrenCache.clear();
                refresh((x) => x + 1);
              },
            },
          ]
        : []),
      ...(root && tab === 'projects'
        ? [
            { label: 'Чаты этого проекта', action: () => saveApp({ chatProject: entry.path, ui: { ...get().app!.ui, visible: { ...get().app!.ui.visible, chat: true } } }) },
            { label: 'Убрать проект из списка', danger: true, action: () => saveApp({ projects: get().app!.projects.filter((p) => p.path !== entry.path) }) },
          ]
        : []),
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  const roots: DirEntry[] =
    tab === 'projects'
      ? app.projects.map((p) => ({ name: p.name, path: p.path, dir: true }))
      : app.favorites.map((f) => ({ name: basename(f), path: f, dir: !/\.[^\\/]+$/.test(basename(f)) }));

  return (
    <div className="panel tree-panel">
      <div className="panel-head">
        <div className="seg">
          <button className={tab === 'projects' ? 'on' : ''} onClick={() => setUi({ leftTab: 'projects' })}>
            Проекты
          </button>
          <button className={tab === 'favorites' ? 'on' : ''} onClick={() => setUi({ leftTab: 'favorites' })}>
            Избранное {app.favorites.length > 0 && <span className="count">{app.favorites.length}</span>}
          </button>
        </div>
        <div className="grow" />
        <button className="icon-btn" title="Добавить проект" onClick={() => addProjects()}>
          ＋
        </button>
        <Help id="tree" />
      </div>
      <div className="tree-body" key={tab}>
        {roots.map((r) => (
          <Node key={r.path} entry={r} depth={0} root onMenu={onMenu} />
        ))}
        {!roots.length && (
          <div className="empty">
            {tab === 'projects' ? (
              <>
                Нет открытых проектов.
                <button className="btn primary" onClick={() => addProjects()}>
                  Открыть папку проекта
                </button>
              </>
            ) : (
              'Пусто. ПКМ по папке или файлу → «В избранное».'
            )}
          </div>
        )}
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
