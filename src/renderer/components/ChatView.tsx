import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatSnapshot, FileEdit, PermissionRequest, Turn, TurnItem } from '../../shared/types';
import { call } from '../api';
import { markSeen, openFile, sendPrompt, set, useStore } from '../store';
import { Markdown, basename, formatDuration, formatTime, plural, relPath } from '../util';
import { DeployCard } from './Panels';

const MODES = [
  { id: '', label: 'Как в настройках Claude' },
  { id: 'default', label: 'Спрашивать' },
  { id: 'acceptEdits', label: 'Правки без вопросов' },
  { id: 'auto', label: 'Авто' },
  { id: 'plan', label: 'План' },
  { id: 'bypassPermissions', label: 'Без ограничений' },
];

function editLabel(e: FileEdit) {
  const parts: string[] = [];
  if (e.count) parts.push(`${e.count} ${plural(e.count, 'замена', 'замены', 'замен')}`);
  if (e.writes) parts.push(e.writes === 1 ? 'записан целиком' : `${e.writes} перезаписи`);
  return parts.join(' · ');
}

function aggregate(turns: Turn[]) {
  const map = new Map<string, FileEdit & { turns: string[] }>();
  for (const t of turns)
    for (const e of t.edits) {
      const key = e.path.toLowerCase();
      const ex = map.get(key);
      if (!ex) map.set(key, { ...e, turns: [t.id] });
      else {
        ex.count += e.count;
        ex.writes += e.writes;
        ex.lastAt = Math.max(ex.lastAt, e.lastAt);
        ex.firstAt = Math.min(ex.firstAt, e.firstAt);
        if (!ex.turns.includes(t.id)) ex.turns.push(t.id);
      }
    }
  return [...map.values()].sort((a, b) => b.lastAt - a.lastAt);
}

function EditsButton({ edits, cwd }: { edits: FileEdit[]; cwd: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const toggleOpen = () => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ top: Math.min(r.bottom + 4, window.innerHeight - 200), right: Math.max(8, window.innerWidth - r.right) });
    setOpen(!open);
  };
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  if (!edits.length) return null;
  const total = edits.reduce((n, e) => n + e.count + e.writes, 0);
  return (
    <div className="edits-wrap" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className={`edits-btn ${open ? 'on' : ''}`} title="Файлы, изменённые в этом ответе" onClick={toggleOpen}>
        ✎ {edits.length} {plural(edits.length, 'файл', 'файла', 'файлов')} ▾
      </button>
      {open && (
        <div className="dropdown edits-dd" style={{ top: pos.top, right: pos.right }}>
          <div className="dd-head">
            {edits.length} {plural(edits.length, 'файл', 'файла', 'файлов')} · {total} {plural(total, 'изменение', 'изменения', 'изменений')}
          </div>
          {[...edits]
            .sort((a, b) => b.lastAt - a.lastAt)
            .map((e) => (
              <div
                key={e.path}
                className="dd-row"
                onClick={() => {
                  setOpen(false);
                  void openFile(e.path);
                }}
                title={e.path}
              >
                <span className="dd-name">{basename(e.path)}</span>
                <span className="dd-path">{relPath(e.path, cwd).replace(/[^\\/]*$/, '')}</span>
                <span className="dd-meta">{editLabel(e)}</span>
                <span className="dd-time">{formatTime(e.lastAt)}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function ToolGroup({ tools, cwd }: { tools: Extract<TurnItem, { kind: 'tool' }>[]; cwd: string }) {
  const [open, setOpen] = useState(false);
  const errors = tools.filter((t) => t.error).length;
  const running = tools.some((t) => !t.done);
  const names = [...new Set(tools.map((t) => t.name))].slice(0, 4).join(', ');
  return (
    <div className="tool-group">
      <div className="tool-head" onClick={() => setOpen(!open)}>
        <span className="twisty">{open ? '▾' : '▸'}</span>
        {running ? <span className="spinner" /> : '⚙'} {tools.length} {plural(tools.length, 'действие', 'действия', 'действий')}
        <span className="muted"> · {names}</span>
        {errors > 0 && <span className="err-count">{errors} с ошибкой</span>}
      </div>
      {open && (
        <div className="tool-list">
          {tools.map((t) => (
            <div key={t.id} className={`tool-row ${t.error ? 'err' : ''}`}>
              <span className="tname">{t.name.replace(/^mcp__/, '')}</span>
              {t.path ? (
                <span className="path-link" onClick={() => openFile(t.path!)}>
                  {relPath(t.path, cwd)}
                </span>
              ) : (
                <span className="tsum">{t.summary}</span>
              )}
              {!t.done && <span className="spinner" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TurnBody({ turn, cwd, partial }: { turn: Turn; cwd: string; partial?: string }) {
  // Consecutive tool calls are folded into one group so the text answer stays readable.
  const blocks: ({ kind: 'text'; text: string } | { kind: 'tools'; tools: Extract<TurnItem, { kind: 'tool' }>[] })[] = [];
  for (const it of turn.items) {
    const last = blocks[blocks.length - 1];
    if (it.kind === 'text') blocks.push({ kind: 'text', text: it.text });
    else if (last?.kind === 'tools') last.tools.push(it);
    else blocks.push({ kind: 'tools', tools: [it] });
  }
  return (
    <div className="turn-body">
      <div className="question">
        <div className="q-label">Вопрос · {formatTime(turn.startedAt)}</div>
        <div className="q-text">{turn.prompt || (turn.images ? `[${turn.images} изображение]` : '')}</div>
      </div>
      {blocks.map((b, i) => (b.kind === 'text' ? <Markdown key={i} text={b.text} cwd={cwd} /> : <ToolGroup key={i} tools={b.tools} cwd={cwd} />))}
      {partial && <Markdown text={partial} cwd={cwd} />}
      {turn.live && !partial && (
        <div className="thinking">
          <span className="spinner" /> Claude работает…
        </div>
      )}
      {turn.error && <div className="turn-error">⚠ {turn.error}</div>}
      {turn.reads.length > 0 && (
        <div className="reads">
          Прочитаны:{' '}
          {turn.reads.slice(0, 12).map((r) => (
            <span key={r} className="path-link" onClick={() => openFile(r)} title={r}>
              {basename(r)}
            </span>
          ))}
          {turn.reads.length > 12 && <span className="muted"> и ещё {turn.reads.length - 12}</span>}
        </div>
      )}
    </div>
  );
}

function firstLine(s: string) {
  const l = s.trim().split('\n')[0];
  return l.length > 140 ? l.slice(0, 140) + '…' : l;
}

function TurnRow({ turn, cwd, open, onToggle, partial, highlight }: { turn: Turn; cwd: string; open: boolean; onToggle: () => void; partial?: string; highlight?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [highlight]);
  const dur = turn.answeredAt ? turn.answeredAt - turn.startedAt : 0;
  return (
    <div className={`turn ${open ? 'open' : ''} ${turn.live ? 'live' : ''} ${turn.error ? 'failed' : ''} ${highlight ? 'flash' : ''}`} ref={ref}>
      <div className="turn-head" onClick={onToggle}>
        <span className="twisty">{open ? '▾' : '▸'}</span>
        <span className="turn-q">{firstLine(turn.prompt) || '(изображение)'}</span>
        <EditsButton edits={turn.edits} cwd={cwd} />
        <span className="turn-date" title={`Вопрос: ${new Date(turn.startedAt).toLocaleString('ru-RU')}${turn.answeredAt ? `\nОтвет: ${new Date(turn.answeredAt).toLocaleString('ru-RU')}` : ''}`}>
          {turn.live ? <span className="spinner" /> : turn.error ? '⚠' : '✓'} {formatTime(turn.answeredAt ?? turn.startedAt)}
          {dur > 0 && !turn.live && <span className="muted"> · {formatDuration(dur)}</span>}
        </span>
      </div>
      {open && <TurnBody turn={turn} cwd={cwd} partial={partial} />}
    </div>
  );
}

function PermissionCard({ req }: { req: PermissionRequest }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const answer = (behavior: 'allow' | 'deny', extra: object = {}) => call('chat:permission', req.sessionId, req.id, { behavior, ...extra });
  const input: any = req.input;

  if (req.toolName === 'AskUserQuestion') {
    const qs: any[] = input.questions ?? [];
    return (
      <div className="perm-card question-card">
        <div className="perm-title">Claude спрашивает</div>
        {qs.map((q) => (
          <div key={q.question} className="ask">
            <div className="ask-q">{q.question}</div>
            <div className="ask-opts">
              {q.options?.map((o: any) => (
                <button
                  key={o.label}
                  className={`btn ${answers[q.question] === o.label ? 'primary' : ''}`}
                  title={o.description}
                  onClick={() => setAnswers({ ...answers, [q.question]: o.label })}
                >
                  {o.label}
                </button>
              ))}
              <input placeholder="Свой ответ…" onChange={(e) => setAnswers({ ...answers, [q.question]: e.target.value })} />
            </div>
          </div>
        ))}
        <div className="perm-actions">
          <button className="btn primary" disabled={qs.some((q) => !answers[q.question])} onClick={() => answer('allow', { updatedInput: { ...input, answers } })}>
            Ответить
          </button>
          <button className="btn" onClick={() => answer('deny', { message: 'Пользователь пропустил вопрос' })}>
            Пропустить
          </button>
        </div>
      </div>
    );
  }

  if (req.toolName === 'ExitPlanMode') {
    return (
      <div className="perm-card">
        <div className="perm-title">План готов — выполнять?</div>
        <div className="plan">
          <Markdown text={String(input.plan ?? '')} cwd="" />
        </div>
        <div className="perm-actions">
          <button className="btn primary" onClick={() => answer('allow')}>
            Выполнять
          </button>
          <button className="btn" onClick={() => answer('deny', { message: 'Пользователь хочет доработать план' })}>
            Доработать план
          </button>
        </div>
      </div>
    );
  }

  const preview =
    input.command ??
    (input.old_string !== undefined ? `— ${String(input.old_string).slice(0, 600)}\n+ ${String(input.new_string ?? '').slice(0, 600)}` : undefined) ??
    (input.content !== undefined ? String(input.content).slice(0, 800) : JSON.stringify(input, null, 1).slice(0, 800));
  return (
    <div className="perm-card">
      <div className="perm-title">
        Разрешить <b>{req.toolName.replace(/^mcp__/, '')}</b>
        {input.file_path && (
          <>
            {' '}
            для <span className="path-link" onClick={() => openFile(input.file_path)}>{basename(input.file_path)}</span>
          </>
        )}
        ?
      </div>
      {req.title && <div className="muted">{req.title}</div>}
      {input.description && <div className="muted">{input.description}</div>}
      <pre className="perm-preview">{preview}</pre>
      <div className="perm-actions">
        <button className="btn primary" onClick={() => answer('allow')}>
          Разрешить
        </button>
        {req.hasSuggestions && (
          <button className="btn" onClick={() => answer('allow', { always: true })}>
            Всегда разрешать
          </button>
        )}
        <button className="btn danger" onClick={() => answer('deny')}>
          Отклонить
        </button>
      </div>
    </div>
  );
}

function Composer({ chat }: { chat: ChatSnapshot }) {
  const [text, setText] = useState('');
  const defaultMode = useStore((s) => s.app!.defaultPermissionMode ?? '');
  const [mode, setMode] = useState(chat.permissionMode ?? defaultMode);
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = chat.status === 'running' || chat.status === 'waiting';
  const activeFile = useStore((s) => s.activeFile);

  useEffect(() => {
    const onInsert = (e: Event) => {
      const t = (e as CustomEvent).detail as string;
      setText((v) => (v && !v.endsWith(' ') ? v + ' ' : v) + t + ' ');
      ref.current?.focus();
    };
    window.addEventListener('chat-insert', onInsert);
    return () => window.removeEventListener('chat-insert', onInsert);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current!;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 260) + 'px';
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    void sendPrompt(chat.sessionId, t, mode || undefined);
  };

  return (
    <div className="composer">
      <textarea
        ref={ref}
        value={text}
        placeholder={busy ? 'Claude работает… можно дописать — сообщение уйдёт в очередь' : 'Спросите Claude… (Enter — отправить, Shift+Enter — перенос)'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape' && busy) void call('chat:interrupt', chat.sessionId);
        }}
      />
      <div className="composer-bar">
        <select value={mode} onChange={(e) => setMode(e.target.value)} title="Режим разрешений">
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {activeFile && (
          <button className="btn small" title="Вставить путь открытого файла" onClick={() => setText((v) => v + (v ? ' ' : '') + activeFile + ' ')}>
            @ {basename(activeFile)}
          </button>
        )}
        <div className="grow" />
        {busy && (
          <button className="btn danger small" onClick={() => call('chat:interrupt', chat.sessionId)} title="Esc">
            ■ Стоп
          </button>
        )}
        <button className="btn primary small" disabled={!text.trim()} onClick={submit}>
          Отправить ↵
        </button>
      </div>
    </div>
  );
}

export { MODES };

export function ChatView({ chat }: { chat: ChatSnapshot }) {
  const [tab, setTab] = useState<'chat' | 'files' | 'deploys'>('chat');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(chat.turns.slice(-1).map((t) => t.id)));
  const [q, setQ] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const focus = useStore((s) => (s.focusTurn?.sessionId === chat.sessionId ? s.focusTurn : undefined));
  const deploys = useStore((s) => s.deploys.filter((d) => d.sessionId === chat.sessionId));
  const files = useMemo(() => aggregate(chat.turns), [chat.turns]);
  const last = chat.turns[chat.turns.length - 1];

  useEffect(() => markSeen(chat.sessionId), [chat.sessionId, chat.status]);

  // A new question auto-expands so the live answer is visible.
  useEffect(() => {
    if (last?.live) setExpanded((s) => (s.has(last.id) ? s : new Set(s).add(last.id)));
  }, [last?.id, last?.live]);

  useEffect(() => {
    if (focus) {
      setTab('chat');
      setExpanded((s) => new Set(s).add(focus.turnId));
    }
  }, [focus?.nonce]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current && tab === 'chat' && !focus) el.scrollTop = el.scrollHeight;
  }, [chat, tab]);

  const needle = q.toLowerCase();
  const turns = needle
    ? chat.turns.filter((t) => t.prompt.toLowerCase().includes(needle) || t.items.some((i) => i.kind === 'text' && i.text.toLowerCase().includes(needle)))
    : chat.turns;

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="chat-view">
      {tab === 'chat' && (
        <div className="chat-toolbar">
          <input className="search" placeholder="Поиск по вопросам и ответам…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="muted">
            {turns.length} {plural(turns.length, 'вопрос', 'вопроса', 'вопросов')}
          </span>
          <button className="btn small" onClick={() => setExpanded(new Set(turns.map((t) => t.id)))} title="Развернуть все">
            ⊞
          </button>
          <button className="btn small" onClick={() => setExpanded(new Set())} title="Свернуть все">
            ⊟
          </button>
        </div>
      )}
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {tab === 'chat' && (
          <>
            {turns.map((t) => (
              <TurnRow
                key={t.id}
                turn={t}
                cwd={chat.cwd}
                open={expanded.has(t.id) || (!!needle && turns.length <= 3)}
                onToggle={() => toggle(t.id)}
                partial={t === last ? chat.partial : undefined}
                highlight={focus?.turnId === t.id}
              />
            ))}
            {!chat.turns.length && <div className="empty">Новый чат в {chat.cwd}. Задайте вопрос ниже.</div>}
          </>
        )}
        {tab === 'files' && (
          <div className="files-tab">
            {files.map((f) => (
              <div key={f.path} className="file-row" title={f.path}>
                <span className="path-link fname" onClick={() => openFile(f.path)}>
                  {basename(f.path)}
                </span>
                <span className="fdir">{relPath(f.path, chat.cwd).replace(/[^\\/]*$/, '')}</span>
                <span className="fmeta">{editLabel(f)}</span>
                <button
                  className="btn small"
                  title="Показать ответы, где правился файл"
                  onClick={() => set({ focusTurn: { sessionId: chat.sessionId, turnId: f.turns[f.turns.length - 1], nonce: Date.now() } })}
                >
                  в {f.turns.length} {plural(f.turns.length, 'ответе', 'ответах', 'ответах')} →
                </button>
                <span className="ftime">{formatTime(f.lastAt)}</span>
              </div>
            ))}
            {!files.length && <div className="empty">В этом чате файлы ещё не правились.</div>}
          </div>
        )}
        {tab === 'deploys' && (
          <div className="deploys-tab">
            {deploys.map((d) => (
              <DeployCard key={d.id} d={d} />
            ))}
            {!deploys.length && <div className="empty">Пушей из этого чата пока не было. Как только чат сделает git push — здесь появится статус выкладки.</div>}
          </div>
        )}
      </div>
      {chat.pending.map((p) => (
        <PermissionCard key={p.id} req={p} />
      ))}
      {tab === 'chat' && <Composer chat={chat} />}
      <div className="tabs bottom-tabs">
        <div className={`tab ${tab === 'chat' ? 'on' : ''}`} onClick={() => setTab('chat')}>
          💬 Чат
        </div>
        <div className={`tab ${tab === 'files' ? 'on' : ''}`} onClick={() => setTab('files')}>
          📄 Файлы {files.length > 0 && <span className="count">{files.length}</span>}
        </div>
        <div className={`tab ${tab === 'deploys' ? 'on' : ''} ${deploys.some((d) => d.state === 'failed' || d.state === 'stuck') ? 'alert' : ''}`} onClick={() => setTab('deploys')}>
          🚀 Деплои {deploys.length > 0 && <span className="count">{deploys.length}</span>}
        </div>
        <div className="grow" />
        <span className="muted chat-cwd" title={chat.sessionId}>
          {chat.cwd}
        </span>
      </div>
    </div>
  );
}

