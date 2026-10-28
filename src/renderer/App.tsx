import { useEffect, useRef, useState } from 'react';
import type { PanelId } from '../shared/types';
import { call } from './api';
import { ChatPanel } from './components/ChatPanel';
import { EditorArea } from './components/Editor';
import { BOTTOM_PANELS, panelAlerts } from './components/Panels';
import { TreePanel } from './components/Tree';
import { HELP } from './help';
import { init, isUnread, set, setUi, togglePanel, useStore } from './store';
import { Markdown } from './util';

const TOOLBAR: { id: PanelId; label: string; icon: string }[] = [
  { id: 'tree', label: 'Проекты', icon: '🗂' },
  { id: 'chat', label: 'ИИ-чат', icon: '✳' },
  { id: 'problems', label: 'Ошибки', icon: '⛔' },
  { id: 'deploys', label: 'Деплои', icon: '🚀' },
  { id: 'tests', label: 'Тесты', icon: '🧪' },
  { id: 'keys', label: 'Ключи', icon: '🔑' },
];

function ToolbarButton({ id, label, icon }: { id: PanelId; label: string; icon: string }) {
  const visible = useStore((s) => s.app!.ui.visible[id]);
  const alerts = useStore((s) => panelAlerts(s, id));
  const unread = useStore((s) => (id === 'chat' ? Object.keys(s.app!.chatMeta).filter((k) => isUnread(k, s)).length : 0));
  const running = useStore((s) =>
    id === 'chat'
      ? Object.values(s.chats).filter((c) => c.status === 'running' || c.status === 'waiting').length
      : id === 'deploys'
        ? s.deploys.filter((d) => ['pushed', 'building', 'deploying'].includes(d.state)).length
        : 0,
  );
  const waiting = useStore((s) => (id === 'chat' ? Object.values(s.chats).some((c) => c.status === 'waiting') : false));
  const cls = ['tb-btn', visible ? 'on' : '', alerts ? (visible ? 'alert-open' : 'alert') : '', waiting && !visible ? 'alert' : ''].join(' ');
  return (
    <button className={cls} onClick={() => togglePanel(id)} title={`${visible ? 'Скрыть' : 'Показать'}: ${label}`}>
      <span className="tb-icon">{icon}</span>
      {label}
      {running > 0 && <span className="spinner small" title="Выполняется" />}
      {alerts > 0 && <span className="badge red">{alerts}</span>}
      {unread > 0 && <span className="badge blue" title="Готовые непрочитанные ответы">{unread}</span>}
    </button>
  );
}

function AuthButton() {
  const auth = useStore((s) => s.auth);
  const [busy, setBusy] = useState(false);
  if (!auth) return <span className="muted">Проверяю вход…</span>;
  if (auth.loggedIn)
    return (
      <span className="auth ok" title={`${auth.method ?? ''} · ${auth.orgName ?? ''}\n${auth.cliPath ?? ''}`}>
        ● {auth.email}
      </span>
    );
  return (
    <button
      className="btn primary small"
      disabled={busy}
      title={auth.error}
      onClick={async () => {
        setBusy(true);
        set({ auth: await call('auth:login') });
        setBusy(false);
      }}
    >
      {busy ? 'Ждём вход в браузере…' : 'Войти в Claude'}
    </button>
  );
}

/** Drag handle that resizes a neighbouring panel. */
function Splitter({ dir, onDrag }: { dir: 'x' | 'y'; onDrag: (delta: number) => void }) {
  const start = useRef(0);
  return (
    <div
      className={`splitter ${dir}`}
      onMouseDown={(e) => {
        start.current = dir === 'x' ? e.clientX : e.clientY;
        const move = (ev: MouseEvent) => {
          const pos = dir === 'x' ? ev.clientX : ev.clientY;
          onDrag(pos - start.current);
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

  if (!ready || !app) return <div className="boot">Загрузка…</div>;
  const v = app.ui.visible;
  const bottom = BOTTOM_PANELS.filter((p) => v[p.id]);
  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

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
        <AuthButton />
        <button className="icon-btn help-btn" title="Инструкция" onClick={() => set({ help: 'general' })}>
          ?
        </button>
      </div>
      <div className="workspace">
        {v.tree && (
          <>
            <div style={{ width: app.ui.leftWidth }} className="col">
              <TreePanel />
            </div>
            <Splitter dir="x" onDrag={(d) => setUi({ leftWidth: clamp(app.ui.leftWidth + d, 180, 700) })} />
          </>
        )}
        <div className="col center">
          <div className="center-top">
            <EditorArea />
          </div>
          {bottom.length > 0 && (
            <>
              <Splitter dir="y" onDrag={(d) => setUi({ bottomHeight: clamp(app.ui.bottomHeight - d, 120, window.innerHeight - 200) })} />
              <div className="bottom-area" style={{ height: app.ui.bottomHeight }}>
                {bottom.map(({ id, C }) => (
                  <C key={id} />
                ))}
              </div>
            </>
          )}
        </div>
        {v.chat && (
          <>
            <Splitter dir="x" onDrag={(d) => setUi({ rightWidth: clamp(app.ui.rightWidth - d, 340, window.innerWidth - 400) })} />
            <div style={{ width: app.ui.rightWidth }} className="col">
              <ChatPanel />
            </div>
          </>
        )}
      </div>
      <HelpModal />
      <Toast />
    </div>
  );
}
