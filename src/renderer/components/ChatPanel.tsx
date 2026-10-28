import { useEffect, useRef, useState } from 'react';
import type { ChatSnapshot, SessionInfo } from '../../shared/types';
import { closeChat, isUnread, loadSessions, newChat, openChat, renameChat, saveApp, useStore } from '../store';
import { Help, basename, formatTime } from '../util';
import { ChatView } from './ChatView';
import { BlockHandle } from './Layout';

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
  const chats = useStore((s) => s.chats);
  const [showHistory, setShowHistory] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
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
      <div className="tabs chat-tabs">
        {app.openChats.map((id) => {
          const c = chats[id];
          if (!c) return null;
          return (
            <div
              key={id}
              className={`tab ${id === active ? 'on' : ''}`}
              title={`${c.title}\n${c.cwd}\nДвойной клик — переименовать`}
              onClick={() => openChat(id)}
              onDoubleClick={() => setEditing(id)}
              onAuxClick={(e) => e.button === 1 && closeChat(id)}
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
              {app.projects.length > 1 && <span className="tproj">{basename(c.cwd)}</span>}
              <span className="x" onClick={(e) => (e.stopPropagation(), closeChat(id))}>
                ×
              </span>
            </div>
          );
        })}
      </div>
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
