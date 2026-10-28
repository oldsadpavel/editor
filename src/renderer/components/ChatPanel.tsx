import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatSnapshot, SessionInfo } from '../../shared/types';
import { call } from '../api';
import { closeChat, toast, isUnread, loadSessions, newChat, openChat, renameChat, saveApp, useStore } from '../store';
import { Help, basename, formatTime } from '../util';
import { ChatView } from './ChatView';
import { BlockHandle } from './Layout';
import { TabStrip, middleClose } from './Tabs';
import { ContextMenu, type MenuItem } from './ContextMenu';

export function StatusDot({ id, status }: { id: string; status?: ChatSnapshot['status'] }) {
  const unread = useStore((s) => isUnread(id, s));
  if (status === 'running') return <span className="sdot running" title="Работает" />;
  if (status === 'waiting') return <span className="sdot waiting" title="Ждёт вашего ответа">!</span>;
  if (status === 'error') return <span className="sdot error" title="Ошибка" />;
  if (unread) return <span className="sdot unread" title="Готово — не прочитано" />;
  return null;
}

function Rename({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="rename-input"
      defaultValue={value}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(e.currentTarget.value);
        if (e.key === 'Escape') onDone(null);
      }}
      onBlur={(e) => onDone(e.currentTarget.value)}
    />
  );
}

function History({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const sessions = useStore((s) => s.sessions[cwd]) ?? [];
  const chats = useStore((s) => s.chats);
  const openIds = useStore((s) => s.app!.openChats);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => void loadSessions(cwd), [cwd]);

  const list = sessions.filter((s) => !q || s.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="history" onMouseDown={(e) => e.stopPropagation()}>
      <div className="history-head">
        <input autoFocus placeholder="Поиск чата…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onClose()} />
        <span className="muted">{sessions.length}</span>
      </div>
      <div className="history-list">
        {list.map((s: SessionInfo) => (
          <div
            key={s.sessionId}
            className={`history-row ${openIds.includes(s.sessionId) ? 'open' : ''}`}
            onClick={() => {
              void openChat(s.sessionId, s.cwd);
              onClose();
            }}
          >
            <StatusDot id={s.sessionId} status={chats[s.sessionId]?.status} />
            {editing === s.sessionId ? (
              <Rename
                value={s.title}
                onDone={(v) => {
                  setEditing(null);
                  if (v && v !== s.title) void renameChat(s.sessionId, v);
                }}
              />
            ) : (
              <span className="htitle" title={s.title}>
                {s.title}
              </span>
            )}
            <span className="hdate">{formatTime(s.lastModified)}</span>
            <button
              className="icon-btn"
              title="Переименовать"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(s.sessionId);
              }}
            >
              ✎
            </button>
          </div>
        ))}
        {!list.length && <div className="empty">Чатов нет</div>}
      </div>
    </div>
  );
}

export function ChatPanel() {
  const app = useStore((s) => s.app!);
  const unread = useStore((s) => s.app!.openChats.filter((id) => isUnread(id, s)));
  const chats = useStore((s) => s.chats);
  const [showHistory, setShowHistory] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const cwd = app.chatProject ?? app.projects[0]?.path;
  const active = app.activeChat && chats[app.activeChat] ? app.activeChat : undefined;

  useEffect(() => {
    if (!showHistory) return;
    const close = () => setShowHistory(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [showHistory]);

  return (
    <div className="panel chat-panel">
      <div className="panel-head">
        <BlockHandle block="chat" />
        <span className="panel-title">ИИ</span>
        <select
          className="project-select"
          value={cwd ?? ''}
          onChange={(e) => saveApp({ chatProject: e.target.value })}
          title="Проект для новых чатов и истории"
        >
          {app.projects.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn primary small" disabled={!cwd} onClick={() => cwd && newChat(cwd)}>
          ＋ Чат
        </button>
        <div className="history-wrap">
          <button className="btn small" disabled={!cwd} onMouseDown={(e) => e.stopPropagation()} onClick={() => setShowHistory(!showHistory)}>
            История ▾
          </button>
          {showHistory && cwd && <History cwd={cwd} onClose={() => setShowHistory(false)} />}
        </div>
        <div className="grow" />
        <Help id="chat" />
      </div>
      <TabStrip className="chat-tabs" activeKey={active} onPick={(id) => openChat(id)}>
        {groupByProject(app.openChats.filter((id) => chats[id]), (id) => chats[id].cwd).map((g) => (
          <ProjectGroup key={g.cwd} cwd={g.cwd}>
            {g.ids.map((id) => {
          const c = chats[id];
          const mark = c.status === 'running' ? '  — работает' : c.status === 'waiting' ? '  — ждёт ответа' : c.status === 'error' ? '  — ошибка' : '';
          return (
            <div
              key={id}
              data-tab-key={id}
              data-tab-label={`${c.title}${mark}${unread.includes(id) ? '  — новый ответ' : ''}`}
              data-tab-sort={app.chatMeta[id]?.completedAt ?? 0}
              className={`tab ${id === active ? 'on' : ''} ${unread.includes(id) ? 'unread unseen' : ''}`}
              title={`${c.title}${unread.includes(id) ? '\nЕсть новый ответ — вы ещё не смотрели' : ''}\n${c.cwd}\nДвойной клик — переименовать · средняя кнопка мыши — закрыть`}
              onClick={() => openChat(id)}
              onDoubleClick={() => setEditing(id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setTabMenu({
                  x: e.clientX,
                  y: e.clientY,
                  items: [
                    { label: 'Переименовать', action: () => setEditing(id) },
                    {
                      label: 'Ответвить чат (копия)',
                      action: () => void call<ChatSnapshot>('chat:fork', id).then((snap) => openChat(snap.sessionId, snap.cwd), (e) => toast(e.message, 'error')),
                    },
                    { label: 'Экспорт в Markdown…', action: () => void call<string | null>('chat:export', id).then((f) => f && toast(`Чат сохранён: ${f}`), (e) => toast(e.message, 'error')) },
                    { label: 'Закрыть', action: () => closeChat(id) },
                    { label: 'Закрыть остальные', action: () => app.openChats.filter((x) => x !== id).forEach((x) => closeChat(x)) },
                  ],
                });
              }}
              {...middleClose(() => closeChat(id))}
            >
              <StatusDot id={id} status={c.status} />
              {editing === id ? (
                <Rename
                  value={c.title}
                  onDone={(v) => {
                    setEditing(null);
                    if (v && v !== c.title) void renameChat(id, v);
                  }}
                />
              ) : (
                <span className="ttitle">{c.title}</span>
              )}
              {editing !== id && (
                <span className="tab-rename" title="Переименовать" onClick={(e) => (e.stopPropagation(), setEditing(id))}>
                  ✎
                </span>
              )}
              <span className="x" onClick={(e) => (e.stopPropagation(), closeChat(id))}>
                ×
              </span>
            </div>
          );
            })}
          </ProjectGroup>
        ))}
      </TabStrip>
      {tabMenu && <ContextMenu {...tabMenu} onClose={() => setTabMenu(null)} />}
      {active ? (
        <ChatView key={active} chat={chats[active]} />
      ) : (
        <div className="empty big">
          <div className="logo">✳</div>
          {app.projects.length ? 'Создайте новый чат или откройте из «Истории».' : 'Сначала добавьте проект в дереве слева.'}
          {cwd && (
            <button className="btn primary" onClick={() => newChat(cwd)}>
              ＋ Новый чат в {basename(cwd)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Open chats grouped by project, groups in the order their first chat was opened. */
function groupByProject(ids: string[], cwdOf: (id: string) => string) {
  const groups: { cwd: string; ids: string[] }[] = [];
  for (const id of ids) {
    const cwd = cwdOf(id);
    const key = cwd.toLowerCase();
    const g = groups.find((x) => x.cwd.toLowerCase() === key);
    if (g) g.ids.push(id);
    else groups.push({ cwd, ids: [id] });
  }
  return groups;
}

/**
 * A project's chat tabs with a small project label above them; thin lines run from the label down to the middle of
 * every tab, so it's clear which chats belong to which project.
 */
function ProjectGroup({ cwd, children }: { cwd: string; children: React.ReactNode }) {
  const tabs = useRef<HTMLDivElement>(null);
  const [centers, setCenters] = useState<number[]>([]);
  useLayoutEffect(() => {
    const el = tabs.current;
    if (!el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      const next = Array.from(el.querySelectorAll<HTMLElement>('[data-tab-key]')).map((t) => {
        const r = t.getBoundingClientRect();
        return Math.round(r.left - box.left + r.width / 2);
      });
      setCenters((prev) => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const t of Array.from(el.children)) ro.observe(t);
    return () => ro.disconnect();
  });
  const name = basename(cwd);
  const first = centers[0] ?? 0;
  const last = centers[centers.length - 1] ?? 0;
  return (
    <div className="chat-group" title={cwd}>
      <div className="cg-head">
        <svg className="cg-lines" aria-hidden="true">
          {centers.length > 1 && <line x1={first} x2={last} y1={6.5} y2={6.5} />}
          {centers.map((x, i) => (
            <line key={i} x1={x + 0.5} x2={x + 0.5} y1={6.5} y2={14} />
          ))}
        </svg>
        <span className="cg-label" style={{ left: (first + last) / 2 }}>
          {name}
        </span>
      </div>
      <div className="cg-tabs" ref={tabs}>
        {children}
      </div>
    </div>
  );
}
