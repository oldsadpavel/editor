import { Fragment, useEffect, useRef, useState } from 'react';
import type { ColumnId, MainBlock, PanelId } from '../shared/types';
import { call } from './api';
import { ChatPanel } from './components/ChatPanel';
import { EditorArea } from './components/Editor';
import { ImageLightbox } from './components/ImageViewer';
import { DropColumn, LayoutButton } from './components/Layout';
import { ContextMenu, type MenuItem } from './components/ContextMenu';
import { BOTTOM_PANELS, panelAlerts } from './components/Panels';
import { TreePanel } from './components/Tree';
import { UsageMeters } from './components/UsageMeters';
import { ProjectSettings } from './components/ProjectSettings';
import { StatusModal } from './components/StatusModal';
import { Boot } from './components/Boot';
import { CloudModal } from './components/CloudModal';
import { McpModal } from './components/ChatExtras';
import { Switcher } from './components/Switcher';
import { InstallClaudeButton } from './components/SetupPanel';
import { HELP } from './help';
import { get, init, isUnread, set, setUi, toast, togglePanel, useStore } from './store';
import { Markdown } from './util';

const TOOLBAR: { id: PanelId; label: string; icon: string }[] = [
  { id: 'setup', label: 'Настройка', icon: '⚙' },
  { id: 'tree', label: 'Проекты', icon: '🗂' },
  { id: 'chat', label: 'ИИ-чат', icon: '✳' },
  { id: 'problems', label: 'Ошибки', icon: '⛔' },
  { id: 'ping', label: 'Пинг', icon: '📡' },
  { id: 'deploys', label: 'Деплои', icon: '🚀' },
  { id: 'tests', label: 'Тесты', icon: '🧪' },
  { id: 'keys', label: 'Ключи', icon: '🔑' },
  { id: 'cache', label: 'Кеш ИИ', icon: '🧹' },
];

function ToolbarButton({ id, label, icon }: { id: PanelId; label: string; icon: string }) {
  const visible = useStore((s) => s.app!.ui.visible[id]);
  const alerts = useStore((s) => panelAlerts(s, id));
  const unread = useStore((s) => (id === 'chat' ? Object.keys(s.app!.chatMeta).filter((k) => isUnread(k, s)).length : 0));
  const running = useStore((s) =>
    id === 'chat'
      ? Object.values(s.chats).filter((c) => c.status === 'running' || c.status === 'waiting').length
      : id === 'deploys'
        ? s.deploys.filter((d) => d.state === 'building' || d.state === 'deploying').length
        : 0,
  );
  const todo = useStore((s) => (id === 'setup' ? s.setup.filter((i) => i.level === 'todo').length : 0));
  const waiting = useStore((s) => (id === 'chat' ? Object.values(s.chats).some((c) => c.status === 'waiting') : false));
  const cls = ['tb-btn', visible ? 'on' : '', alerts ? (visible ? 'alert-open' : 'alert') : '', waiting && !visible ? 'alert' : '', todo && !visible ? 'attn' : ''].join(' ');
  return (
    <button className={cls} onClick={() => togglePanel(id)} title={`${visible ? 'Скрыть' : 'Показать'}: ${label}`}>
      <span className="tb-icon">{icon}</span>
      {label}
      {running > 0 && <span className="spinner small" title="Выполняется" />}
      {alerts > 0 && <span className="badge red">{alerts}</span>}
      {todo > 0 && <span className="badge orange" title="Что нужно настроить">{todo}</span>}
      {unread > 0 && <span className="badge blue" title="Готовые непрочитанные ответы">{unread}</span>}
    </button>
  );
}

/** Appears when a newer build was installed next to this one (scripts/install-local.ps1). */
function UpdateButton() {
  const update = useStore((s) => s.update);
  if (!update) return null;
  return (
    <button
      className="tb-btn update-btn"
      title="Установлена новая версия редактора. Открытые чаты, файлы и раскладка восстановятся после перезапуска."
      onClick={async () => {
        const busy = await call<number>('chat:busyCount');
        if (busy && !confirm(`Идёт ответ в ${busy} ${busy === 1 ? 'чате' : 'чатах'}. Перезапуск прервёт его. Перезапустить всё равно?`)) return;
        await call('app:restartToUpdate');
      }}
    >
      ⬆ Новая версия — перезапустить
    </button>
  );
}

/**
 * Account of Claude Code: who is signed in, plus login (claude.ai / Console / SSO), switch account and logout.
 * These are Claude Code's own credentials, so the terminal and IDE plugins follow the same account.
 */
function AuthButton() {
  const auth = useStore((s) => s.auth);
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const run = async (label: string, channel: string, ...args: unknown[]) => {
    setBusy(label);
    try {
      set({ auth: await call(channel, ...args) });
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const items: MenuItem[] = [
    { label: auth?.loggedIn ? 'Сменить аккаунт (claude.ai, подписка)' : 'Войти через claude.ai (подписка)', action: () => run('Ждём вход в браузере…', 'auth:login', 'claudeai') },
    { label: 'Войти через Anthropic Console (оплата по API)', action: () => run('Ждём вход в браузере…', 'auth:login', 'console') },
    { label: 'Войти через SSO (корпоративный вход)', action: () => run('Ждём вход в браузере…', 'auth:login', 'sso') },
    { label: 'Обновить статус входа', action: () => run('Проверяю…', 'auth:status') },
    { label: '☁ Облако настроек (Insider или свой сервер)…', action: () => set({ showCloud: true }) },
    ...(auth?.loggedIn
      ? [
          {
            label: 'Выйти из аккаунта',
            danger: true,
            action: () =>
              confirm('Выйти из Claude? Это общий вход Claude Code: терминал и плагины IDE тоже выйдут. Работающие чаты остановятся с ошибкой авторизации.') &&
              run('Выхожу…', 'auth:logout'),
          },
        ]
      : []),
  ];
  const open = (e: React.MouseEvent) => setMenu({ x: e.clientX, y: e.clientY + 12 });

  if (!auth) return <span className="muted">Проверяю вход…</span>;
  if (auth.notInstalled)
    return (
      <span className="auth-login" title="Claude Code не найден — без него чаты не работают">
        <InstallClaudeButton />
      </span>
    );
  return (
    <>
      {busy ? (
        <span className="auth muted">
          <span className="spinner small" /> {busy}
        </span>
      ) : auth.loggedIn ? (
        <button className="auth ok auth-btn" title={`${auth.method ?? ''} · ${auth.orgName ?? ''}\n${auth.cliPath ?? ''}\nНажмите — сменить аккаунт или выйти`} onClick={open}>
          <span className="auth-avatar">{(auth.email ?? '?')[0].toUpperCase()}</span>
          <span className="auth-name">{auth.email?.split('@')[0]}</span> ▾
        </button>
      ) : (
        <span className="auth-login">
          <button className="btn primary small" title={auth.error} onClick={() => run('Ждём вход в браузере…', 'auth:login', 'claudeai')}>
            Войти в Claude
          </button>
          <button className="btn small" title="Другие способы входа" onClick={open}>
            ▾
          </button>
        </span>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </>
  );
}

/** Drag handle that resizes a neighbouring panel. */
function Splitter({ dir, onDrag }: { dir: 'x' | 'y'; onDrag: (delta: number) => void }) {
  const start = useRef(0);
  // The window listener lives for the whole drag, so it must call the latest onDrag (which sees the current size),
  // not the one from the render when the mouse went down — otherwise every move restarts from the old size.
  const latest = useRef(onDrag);
  latest.current = onDrag;
  return (
    <div
      className={`splitter ${dir}`}
      onMouseDown={(e) => {
        e.preventDefault();
        start.current = dir === 'x' ? e.clientX : e.clientY;
        const move = (ev: MouseEvent) => {
          const pos = dir === 'x' ? ev.clientX : ev.clientY;
          latest.current(pos - start.current);
          start.current = pos;
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          document.body.classList.remove('resizing');
        };
        document.body.classList.add('resizing');
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
    />
  );
}

function HelpModal() {
  const id = useStore((s) => s.help);
  if (!id) return null;
  const h = HELP[id];
  return (
    <div className="modal-bg" onClick={() => set({ help: undefined })}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{h.title}</b>
          <div className="grow" />
          <button className="icon-btn" onClick={() => set({ help: undefined })}>
            ×
          </button>
        </div>
        <Markdown text={h.body} cwd="" />
        <div className="modal-foot">
          {Object.entries(HELP)
            .filter(([k]) => k !== id)
            .map(([k, v]) => (
              <span key={k} className="path-link" onClick={() => set({ help: k })}>
                {v.title}
              </span>
            ))}
        </div>
      </div>
    </div>
  );
}

function Toast() {
  const t = useStore((s) => s.toast);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!t) return;
    setShown(true);
    const h = setTimeout(() => setShown(false), t.kind === 'error' ? 6000 : 2500);
    return () => clearTimeout(h);
  }, [t?.nonce]);
  if (!t || !shown) return null;
  return <div className={`toast ${t.kind}`}>{t.text}</div>;
}

export function App() {
  const app = useStore((s) => s.app);
  const [ready, setReady] = useState(false);
  const [, rerender] = useState(0);

  useEffect(() => {
    init().then(() => setReady(true));
    const onResize = () => rerender((x) => x + 1);
    window.addEventListener('resize', onResize);
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const unreadCount = useStore((s) => (s.app ? Object.keys(s.app.chatMeta).filter((k) => isUnread(k, s)).length : 0));
  useEffect(() => {
    document.title = unreadCount ? `(${unreadCount}) Claude Editor` : 'Claude Editor';
  }, [unreadCount]);

  if (!ready || !app) return <Boot />;
  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">✳ Claude Editor</span>
        <div className="tb-group">
          {TOOLBAR.map((b) => (
            <ToolbarButton key={b.id} {...b} />
          ))}
        </div>
        <div className="grow" />
        <UpdateButton />
        <UsageMeters />
        <LayoutButton />
        <AuthButton />
        <button className="icon-btn help-btn" title="Инструкция" onClick={() => set({ help: 'general' })}>
          ?
        </button>
      </div>
      <Workspace />
      <HelpModal />
      <ProjectSettings />
      <ImageLightbox />
      <StatusModal />
      <CloudModal />
      <McpModal />
      <Switcher />
      <Toast />
    </div>
  );
}

/** A block scaled by Ctrl+wheel over it (see useBlockZoom); the top menu bar isn't inside any of these. */
function Zoom({ id, children }: { id: string; children: React.ReactNode }) {
  const z = useStore((s) => s.app!.ui.zoom?.[id] ?? 1);
  return (
    <div className="zoom-box" data-zoom={id} style={z !== 1 ? { zoom: z } : undefined}>
      {children}
    </div>
  );
}

/** Ctrl+wheel zooms the block under the cursor, Ctrl+0 resets it; remembered per block. */
function useBlockZoom() {
  useEffect(() => {
    let pointer = { x: 0, y: 0 };
    const blockAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest('[data-zoom]') as HTMLElement | null)?.dataset.zoom;
    const apply = (id: string, z: number) => {
      z = Math.round(clamp(z, 0.5, 2.5) * 20) / 20;
      setUi({ zoom: { ...get().app!.ui.zoom, [id]: z } });
      toast(`Масштаб блока: ${Math.round(z * 100)}%  ·  Ctrl+0 — сбросить`);
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault(); // not the whole window
      const id = blockAt(e.clientX, e.clientY);
      if (!id || !e.deltaY) return;
      apply(id, (get().app!.ui.zoom?.[id] ?? 1) * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    };
    const onMove = (e: MouseEvent) => (pointer = { x: e.clientX, y: e.clientY });
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key !== '0') return;
      const id = blockAt(pointer.x, pointer.y);
      if (!id) return;
      e.preventDefault();
      apply(id, 1);
    };
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
}

/**
 * Double-click selects a word without the space after it (Chromium on Windows takes the trailing space too, so a
 * copied word came out as "ВставитьИзExcel "). Copying plain page text also drops whitespace at the edges.
 */
function useTrimWordSelection() {
  useEffect(() => {
    const onDbl = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.cm-editor')) return; // CodeMirror selects words itself
      if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) {
        const v = t.value;
        let end = t.selectionEnd ?? 0;
        while (end > (t.selectionStart ?? 0) && /\s/.test(v[end - 1])) end--;
        t.setSelectionRange(t.selectionStart, end);
        return;
      }
      const sel = getSelection();
      if (!sel || sel.isCollapsed) return;
      const n = sel.toString().length - sel.toString().trimEnd().length;
      for (let i = 0; i < n; i++) sel.modify('extend', 'backward', 'character');
    };
    const onCopy = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.('.cm-editor') || t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) return;
      const text = getSelection()?.toString() ?? '';
      const trimmed = text.replace(/^[ \t]+|\s+$/g, '');
      if (!trimmed || trimmed === text) return;
      e.preventDefault();
      e.clipboardData?.setData('text/plain', trimmed);
    };
    document.addEventListener('dblclick', onDbl, true);
    document.addEventListener('copy', onCopy, true);
    return () => {
      document.removeEventListener('dblclick', onDbl, true);
      document.removeEventListener('copy', onCopy, true);
    };
  }, []);
}

const BLOCKS: Record<MainBlock, () => React.ReactElement> = { tree: TreePanel, chat: ChatPanel, editor: EditorArea };
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/**
 * Three columns filled according to ui.layout. The center column is elastic and also hosts the bottom blocks;
 * if the block assigned to the center is hidden, the editor (which can't be hidden) takes the elastic place.
 */
function Workspace() {
  const ui = useStore((s) => s.app!.ui);
  useBlockZoom();
  useTrimWordSelection();
  const v = ui.visible;
  const shown = (b: MainBlock) => b === 'editor' || v[b];
  const columns = (['left', 'center', 'right'] as ColumnId[]).filter((c) => shown(ui.layout[c]));
  const flexColumn: ColumnId = shown(ui.layout.center) ? 'center' : columns.find((c) => ui.layout[c] === 'editor')!;
  const flexIndex = columns.indexOf(flexColumn);

  return (
    <div className="workspace">
      {columns.map((c, i) => {
        const block = ui.layout[c];
        const Block = BLOCKS[block];
        if (c === flexColumn)
          return (
            <DropColumn key={c} column={c} className="col center">
              <CenterColumn Block={Block} block={block} />
            </DropColumn>
          );
        const before = i < flexIndex;
        const width = before ? ui.leftWidth : ui.rightWidth;
        const splitter = (
          <Splitter
            dir="x"
            onDrag={(d) =>
              setUi(before ? { leftWidth: clamp(ui.leftWidth + d, 180, window.innerWidth - 360) } : { rightWidth: clamp(ui.rightWidth - d, 240, window.innerWidth - 360) })
            }
          />
        );
        return (
          <Fragment key={c}>
            {!before && splitter}
            <DropColumn column={c} className="col" style={{ width }}>
              <Zoom id={block}>
                <Block />
              </Zoom>
            </DropColumn>
            {before && splitter}
          </Fragment>
        );
      })}
      <ToolDock />
    </div>
  );
}

/**
 * Tool blocks (Настройка, Ошибки, Пинг…) docked as a narrow column on the far right. Only one is open there at a time
 * (togglePanel closes the others), so it gets the whole height.
 */
function ToolDock() {
  const ui = useStore((s) => s.app!.ui);
  if (ui.toolDock !== 'right') return null;
  const open = BOTTOM_PANELS.filter((p) => ui.visible[p.id]);
  if (!open.length) return null;
  const width = ui.toolWidth ?? 380;
  return (
    <>
      <Splitter dir="x" onDrag={(d) => setUi({ toolWidth: clamp(width - d, 260, window.innerWidth - 500) })} />
      <div className="col tool-dock" style={{ width }}>
        {open.map(({ id, C }) => (
          <div key={id} className="bottom-slot" style={{ flex: 1 }}>
            <Zoom id={id}>
              <C />
            </Zoom>
          </div>
        ))}
      </div>
    </>
  );
}

function CenterColumn({ Block, block }: { Block: () => React.ReactElement; block: MainBlock }) {
  const ui = useStore((s) => s.app!.ui);
  const bottom = ui.toolDock === 'right' ? [] : BOTTOM_PANELS.filter((p) => ui.visible[p.id]);
  const max = !!ui.bottomMax && bottom.length > 0;
  const area = useRef<HTMLDivElement>(null);
  const flex = ui.bottomFlex ?? {};

  /** Moves the border between two neighbouring bottom blocks by `dx` pixels. */
  const resizePair = (a: PanelId, b: PanelId, dx: number) => {
    const width = area.current?.clientWidth ?? 1;
    const total = bottom.reduce((s, p) => s + (flex[p.id] ?? 1), 0);
    const delta = (dx / width) * total;
    const fa = flex[a] ?? 1;
    const fb = flex[b] ?? 1;
    const min = total * 0.08;
    if (fa + delta < min || fb - delta < min) return;
    setUi({ bottomFlex: { ...flex, [a]: fa + delta, [b]: fb - delta } });
  };

  return (
    <>
      <div className="center-top" style={max ? { display: 'none' } : undefined}>
        <Zoom id={block}>
          <Block />
        </Zoom>
      </div>
      {bottom.length > 0 && (
        <>
          {!max && <Splitter dir="y" onDrag={(d) => setUi({ bottomHeight: clamp(ui.bottomHeight - d, 90, window.innerHeight - 110) })} />}
          <div className="bottom-area" ref={area} style={max ? { flex: 1 } : { height: ui.bottomHeight }}>
            {bottom.map(({ id, C }, i) => (
              <Fragment key={id}>
                {i > 0 && <Splitter dir="x" onDrag={(d) => resizePair(bottom[i - 1].id, id, d)} />}
                <div className="bottom-slot" style={{ flex: flex[id] ?? 1 }}>
                  <Zoom id={id}>
                    <C />
                  </Zoom>
                </div>
              </Fragment>
            ))}
          </div>
        </>
      )}
    </>
  );
}
