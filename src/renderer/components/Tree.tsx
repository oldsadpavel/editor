import { useEffect, useMemo, useState } from 'react';
import type { DirEntry, TreeSort, TreeSortBy } from '../../shared/types';
import { call } from '../api';
import { addProjects, get, openFile, saveApp, set, setTreeOpen, setUi, toggleFavorite, toast, useStore } from '../store';
import { Help, basename, dirname } from '../util';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { BlockHandle } from './Layout';
import { fileIcon } from './icons';

const childrenCache = new Map<string, DirEntry[]>();

/** Inserts text into the active chat input (listened to by ChatView). */
export function insertIntoChat(text: string) {
  window.dispatchEvent(new CustomEvent('chat-insert', { detail: text }));
}

/** Reloads a folder in the tree (and opens it), e.g. after files were pasted into it. */
function refreshDir(path: string) {
  childrenCache.delete(path);
  window.dispatchEvent(new CustomEvent('tree-refresh', { detail: path.toLowerCase() }));
}

const DEFAULT_SORT: TreeSort = { by: 'name', desc: false };
const SORT_LABEL: Record<TreeSortBy, string> = { name: 'по имени', mtime: 'по дате изменения', size: 'по размеру', type: 'по типу' };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const ext = (n: string) => (n.includes('.') ? n.slice(n.lastIndexOf('.') + 1).toLowerCase() : '');

/** Folders always stay on top; the chosen key orders within folders and files, name breaks ties. */
function sortEntries(list: DirEntry[], s: TreeSort): DirEntry[] {
  const key = (a: DirEntry, b: DirEntry) => {
    switch (s.by) {
      case 'mtime':
        return (a.mtime ?? 0) - (b.mtime ?? 0);
      case 'size':
        return (a.size ?? 0) - (b.size ?? 0);
      case 'type':
        return collator.compare(ext(a.name), ext(b.name));
      default:
        return 0;
    }
  };
  return [...list].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    const k = key(a, b) || collator.compare(a.name, b.name);
    return s.desc ? -k : k;
  });
}

function useSort(path: string): TreeSort {
  return useStore((s) => s.app!.ui.treeSort?.[path.toLowerCase()] ?? s.app!.ui.treeSortDefault ?? DEFAULT_SORT);
}

/** Paste target: the selected folder, or the folder of the selected file. */
function targetDir(entry: DirEntry) {
  return entry.dir ? entry.path : dirname(entry.path);
}

async function pasteInto(dir: string) {
  try {
    const created = await call<string[]>('clipboard:pasteInto', dir);
    if (!created.length) return toast('В буфере нет файлов или картинки', 'error');
    refreshDir(dir);
    set({ treeSelected: created[0] });
    toast(`Вставлено в ${basename(dir)}: ${created.map(basename).join(', ')}`);
  } catch (e: any) {
    toast(e.message, 'error');
  }
}

function Node({ entry, depth, root, onMenu }: { entry: DirEntry; depth: number; root?: boolean; onMenu: (e: React.MouseEvent, entry: DirEntry, root?: boolean) => void }) {
  // Expanded folders are remembered across restarts.
  const open = useStore((s) => !!entry.dir && !!s.app!.ui.treeOpen?.includes(entry.path.toLowerCase()));
  const setOpen = (v: boolean) => setTreeOpen(entry.path, v);
  const [kids, setKids] = useState<DirEntry[] | null>(childrenCache.get(entry.path) ?? null);
  const active = useStore((s) => s.activeFile === entry.path);
  const selected = useStore((s) => s.treeSelected === entry.path);
  const favorite = useStore((s) => s.app?.favorites.includes(entry.path));
  const sort = useSort(entry.path);
  const sorted = useMemo(() => (kids ? sortEntries(kids, sort) : null), [kids, sort]);

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

  useEffect(() => {
    if (!entry.dir) return;
    const onRefresh = (e: Event) => {
      if ((e as CustomEvent).detail !== entry.path.toLowerCase()) return;
      if (open) void load();
      else setOpen(true);
    };
    window.addEventListener('tree-refresh', onRefresh);
    return () => window.removeEventListener('tree-refresh', onRefresh);
  }, [open, entry.path]);

  const click = () => {
    set({ treeSelected: entry.path });
    if (entry.dir) setOpen(!open);
    else void openFile(entry.path);
  };
  return (
    <>
      <div
        className={`tree-row ${active ? 'active' : ''} ${selected ? 'selected' : ''} ${root ? 'root' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={click}
        onContextMenu={(e) => {
          set({ treeSelected: entry.path });
          onMenu(e, entry, root);
        }}
        title={entry.path}
        draggable={!root}
        onDragStart={(e) => {
          // Dropping onto the chat input attaches the file.
          e.dataTransfer.setData('application/x-editor-path', entry.path);
          e.dataTransfer.setData('text/plain', entry.path);
        }}
      >
        <span className="twisty">{entry.dir ? (open ? '▾' : '▸') : ''}</span>
        <span className="ficon">{entry.dir ? (open ? '📂' : '📁') : fileIcon(entry.name)}</span>
        <span className="tname">{entry.name}</span>
        {favorite && !root && <span className="fav-star">★</span>}
        {entry.dir && open && (sort.by !== 'name' || sort.desc) && (
          <span className="sort-mark" title={`Сортировка ${SORT_LABEL[sort.by]}, ${sort.desc ? 'по убыванию' : 'по возрастанию'}`}>
            {sort.desc ? '↓' : '↑'}
            {SORT_LABEL[sort.by].replace('по ', '')}
          </span>
        )}
        {root && <span className="troot-path">{entry.path}</span>}
        {root && get().app!.projects.some((p) => p.path === entry.path) && (
          <span
            className="troot-gear"
            title="Настройки проекта: домены, пинг, сайт деплоя"
            onClick={(e) => {
              e.stopPropagation();
              set({ projectSettings: entry.path });
            }}
          >
            ⚙
          </span>
        )}
      </div>
      {open && sorted?.map((k) => <Node key={k.path} entry={k} depth={depth + 1} onMenu={onMenu} />)}
    </>
  );
}

function sortMenu(dir: string): MenuItem[] {
  const ui = get().app!.ui;
  const own = ui.treeSort?.[dir.toLowerCase()];
  const cur = own ?? ui.treeSortDefault ?? DEFAULT_SORT;
  const setFor = (s: TreeSort) => setUi({ treeSort: { ...ui.treeSort, [dir.toLowerCase()]: s } });
  return [
    ...(Object.keys(SORT_LABEL) as TreeSortBy[]).map((by) => ({
      label: `${cur.by === by ? '● ' : '○ '}Сортировать ${SORT_LABEL[by]}`,
      action: () => setFor({ ...cur, by }),
    })),
    { label: `${cur.desc ? '↓ По убыванию' : '↑ По возрастанию'} — переключить на ${cur.desc ? '↑ возрастание' : '↓ убывание'}`, action: () => setFor({ ...cur, desc: !cur.desc }) },
    { label: 'Эту сортировку — для всех папок по умолчанию', action: () => setUi({ treeSortDefault: cur }) },
    ...(own
      ? [
          {
            label: 'Сбросить сортировку этой папки',
            action: () => {
              const next = { ...ui.treeSort };
              delete next[dir.toLowerCase()];
              setUi({ treeSort: next });
            },
          },
        ]
      : []),
  ];
}

export function TreePanel() {
  const app = useStore((s) => s.app!);
  const tab = app.ui.leftTab === 'favorites' ? 'favorites' : 'projects';
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  function onMenu(e: React.MouseEvent, entry: DirEntry, root?: boolean) {
    e.preventDefault();
    const fav = get().app!.favorites.includes(entry.path);
    const items: MenuItem[] = [
      ...(entry.dir ? [] : [{ label: 'Открыть', action: () => openFile(entry.path) }]),
      { label: `Вставить из буфера в «${basename(targetDir(entry))}» (Ctrl+V)`, action: () => pasteInto(targetDir(entry)) },
      { label: fav ? 'Убрать из избранного' : 'В избранное ★', action: () => toggleFavorite(entry.path) },
      { label: 'Вставить путь в чат', action: () => insertIntoChat(entry.path) },
      { label: 'Копировать путь', action: () => navigator.clipboard.writeText(entry.path) },
      { label: 'Показать в проводнике', action: () => call('shell:reveal', entry.path) },
      ...(entry.dir ? [...sortMenu(entry.path), { label: 'Обновить', action: () => refreshDir(entry.path) }] : []),
      ...(root && tab === 'projects'
        ? [
            { label: 'Настройки проекта… (домены, пинг, деплой)', action: () => set({ projectSettings: entry.path }) },
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'v') return;
    e.preventDefault();
    const sel = get().treeSelected;
    if (!sel) return toast('Выберите папку в дереве, куда вставить', 'error');
    const isDir = (childrenCache.get(dirname(sel)) ?? []).find((x) => x.path === sel)?.dir ?? roots.some((r) => r.path === sel && r.dir);
    void pasteInto(isDir ? sel : dirname(sel));
  };

  return (
    <div className="panel tree-panel">
      <div className="panel-head">
        <BlockHandle block="tree" />
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
      <div className="tree-body" key={tab} tabIndex={0} onKeyDown={onKeyDown}>
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
