import { createContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Task, Turn } from '../../shared/types';
import { call } from '../api';
import { focusChatTurn, get, openChat, saveApp, set, setUi, toast, useStore } from '../store';
import { playSound, soundVolume } from '../sounds';
import { Markdown, formatTime } from '../util';

/** The answer a piece of text belongs to — set around each turn, so «⏰ Напомнить» knows its chat. */
export const TurnContext = createContext<{ sessionId: string; cwd: string; chatTitle: string; turn: Turn } | null>(null);

const NO_TASKS: Task[] = [];
const DAY = 86_400_000;

/** 'overdue' — the date has passed; 'soon' — within a day. */
export function dueState(t: Task, now = Date.now()): '' | 'soon' | 'overdue' {
  if (t.done || !t.due) return '';
  if (t.due <= now) return 'overdue';
  if (t.due - now < DAY) return 'soon';
  return '';
}

/** «сегодня 18:00», «завтра 09:00», «05.11 03:30»… */
export function dueLabel(due: number) {
  const d = new Date(due);
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / DAY);
  if (diff === 0) return `сегодня ${hm}`;
  if (diff === 1) return `завтра ${hm}`;
  if (diff === -1) return `вчера ${hm}`;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hm}`;
}

const toLocalInput = (ms?: number) => {
  if (!ms) return '';
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

/** Quick due dates. */
function presets(): { label: string; at: number }[] {
  const now = new Date();
  const at = (days: number, h: number, m = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, h, m).getTime();
  const list = [
    { label: 'через час', at: Date.now() + 3600_000 },
    { label: 'сегодня 18:00', at: at(0, 18) },
    { label: 'завтра 9:00', at: at(1, 9) },
    { label: 'через неделю', at: at(7, 9) },
  ];
  return list.filter((p) => p.at > Date.now());
}

export function saveTask(task: Task) {
  const tasks = get().app?.tasks ?? [];
  const i = tasks.findIndex((t) => t.id === task.id);
  void saveApp({ tasks: i >= 0 ? tasks.map((t) => (t.id === task.id ? task : t)) : [task, ...tasks] });
}

export function removeTask(id: string) {
  void saveApp({ tasks: (get().app?.tasks ?? []).filter((t) => t.id !== id) });
}

export function openTasks(id?: string) {
  setUi({ tasksOpen: true, editorHidden: false });
  if (id) set({ taskSelected: id });
}

/** «⏰ Напомнить» in an answer: the dialog prefilled with that text and a link back to the answer. */
export function remindFrom(ctx: { sessionId: string; cwd: string; chatTitle: string; turn: Turn } | null, text: string) {
  const clean = text.replace(/^\s*👉?\s*(Тебе сделать|Что нужно от вас|Вам нужно)\s*:?\s*/i, '').trim();
  // the first sentence of the first line, without Markdown marks — the whole text goes into the description
  const line = (clean.split('\n').find((l) => l.trim()) ?? '').replace(/[*_`#>]/g, '').replace(/^\s*(\d+[.)]|[-•])\s*/, '').trim();
  const sentence = line.split(/(?<=[.!?…])\s/)[0] ?? line;
  const title = (sentence.length > 90 ? sentence.slice(0, 89) + '…' : sentence) || 'Напоминание';
  set({
    taskDraft: {
      title,
      body: clean,
      ...(ctx ? { source: { sessionId: ctx.sessionId, cwd: ctx.cwd, chatTitle: ctx.chatTitle, turnStartedAt: ctx.turn.startedAt, prompt: ctx.turn.prompt.slice(0, 200) } } : {}),
    },
  });
}

/** New task from a chat answer: title, due date (presets), text — saved into Задачи. */
export function TaskDraftModal() {
  const draft = useStore((s) => s.taskDraft);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [due, setDue] = useState<number | undefined>();
  useEffect(() => {
    if (!draft) return;
    setTitle(draft.title ?? '');
    setBody(draft.body ?? '');
    setDue(draft.due);
  }, [draft]);
  if (!draft) return null;
  const close = () => set({ taskDraft: undefined });
  const create = (open: boolean) => {
    const task: Task = { id: crypto.randomUUID(), title: title.trim() || 'Без названия', body, subtasks: [], due, done: false, createdAt: Date.now(), source: draft.source };
    saveTask(task);
    close();
    toast(due ? `Задача создана, напомню ${dueLabel(due)}` : 'Задача создана');
    if (open) openTasks(task.id);
  };
  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal task-draft" onMouseDown={(e) => e.stopPropagation()}>
        <h3>⏰ Новая задача</h3>
        <input className="task-title-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Название" autoFocus />
        <div className="task-due-row">
          <span className="muted small">Напомнить:</span>
          {presets().map((p) => (
            <button key={p.label} className={`btn small ${due === p.at ? 'primary' : ''}`} onClick={() => setDue(p.at)}>
              {p.label}
            </button>
          ))}
          <input type="datetime-local" value={toLocalInput(due)} onChange={(e) => setDue(e.target.value ? new Date(e.target.value).getTime() : undefined)} />
          {due && (
            <button className="btn small" onClick={() => setDue(undefined)} title="Без срока">
              ✕
            </button>
          )}
        </div>
        <textarea className="task-body-input" value={body} onChange={(e) => setBody(e.target.value)} rows={7} placeholder="Описание" />
        {draft.source && <div className="muted small">Из чата «{draft.source.chatTitle}»</div>}
        <div className="modal-actions">
          <button className="btn primary" onClick={() => create(false)}>
            Создать
          </button>
          <button className="btn" onClick={() => create(true)}>
            Создать и открыть
          </button>
          <button className="btn" onClick={close}>
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}

/** ✅ Задачи in the top bar: opens the tasks in place of the editor; red — overdue, orange — due within a day. */
export function TasksButton() {
  const tasks = useStore((s) => s.app?.tasks ?? NO_TASKS);
  const open = useStore((s) => !!s.app?.ui.tasksOpen);
  const hidden = useStore((s) => !!s.app?.ui.hiddenButtons?.includes('tasks'));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const overdue = tasks.filter((t) => dueState(t, now) === 'overdue').length;
  const soon = tasks.filter((t) => dueState(t, now) === 'soon').length;
  if (hidden && !open && !overdue) return null;
  return (
    <button
      className={`tb-btn ${open ? 'on' : ''} ${overdue ? 'alert' : ''}`}
      onClick={() => setUi({ tasksOpen: !open, editorHidden: false })}
      title={`Задачи${overdue ? `\nСрок прошёл: ${overdue}` : ''}${soon ? `\nСрок в ближайшие сутки: ${soon}` : ''}\nОткрываются на месте редактора`}
    >
      <span className="tb-icon">✅</span>
      Задачи
      {overdue > 0 && <span className="badge red">{overdue}</span>}
      {soon > 0 && <span className="badge orange">{soon}</span>}
    </button>
  );
}

/** Reminders: when a task's time comes, a pop-up and a sound (once per task). */
export function useTaskReminders() {
  useEffect(() => {
    const tick = () => {
      const app = get().app;
      if (!app?.tasks?.length) return;
      const now = Date.now();
      const due = app.tasks.filter((t) => !t.done && t.due && t.due <= now && !t.notifiedAt);
      if (!due.length) return;
      void saveApp({ tasks: app.tasks.map((t) => (due.includes(t) ? { ...t, notifiedAt: now } : t)) });
      for (const t of due) {
        toast(`⏰ ${t.title}`);
        if (app.notifications !== false) void call('notify:task', t.id, '⏰ Пора: ' + t.title, t.body.split('\n')[0]?.slice(0, 200) ?? '').catch(() => {});
      }
      playSound(app.sound?.default ?? 'synth:chime', soundVolume() || 0.6);
    };
    tick();
    const t = setInterval(tick, 20_000);
    return () => clearInterval(t);
  }, []);
}

/** Задачи: list on the left, the chosen one on the right (title, due date, subtasks, description with pictures). */
export function TasksView() {
  const tasks = useStore((s) => s.app?.tasks ?? NO_TASKS);
  const selected = useStore((s) => s.taskSelected);
  const [filter, setFilter] = useState<'active' | 'done' | 'all'>('active');
  const list = useMemo(() => {
    const l = tasks.filter((t) => (filter === 'all' ? true : filter === 'done' ? t.done : !t.done));
    return [...l].sort((a, b) => (a.done !== b.done ? (a.done ? 1 : -1) : (a.due ?? Infinity) - (b.due ?? Infinity) || b.createdAt - a.createdAt));
  }, [tasks, filter]);
  const current = tasks.find((t) => t.id === selected) ?? list[0];
  const add = () => {
    const t: Task = { id: crypto.randomUUID(), title: 'Новая задача', body: '', subtasks: [], done: false, createdAt: Date.now() };
    saveTask(t);
    set({ taskSelected: t.id });
    setFilter('active');
  };
  return (
    <div className="tasks-view">
      <div className="tasks-list">
        <div className="tasks-head">
          <b>✅ Задачи</b>
          <div className="grow" />
          <button className="btn small primary" onClick={add}>
            ＋ Задача
          </button>
          <button className="icon-btn" title="Закрыть задачи (вернуть редактор)" onClick={() => setUi({ tasksOpen: false })}>
            ×
          </button>
        </div>
        <div className="seg tasks-filter">
          {(['active', 'done', 'all'] as const).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'active' ? `Активные ${tasks.filter((t) => !t.done).length}` : f === 'done' ? 'Выполненные' : 'Все'}
            </button>
          ))}
        </div>
        {list.map((t) => (
          <div key={t.id} className={`task-item ${current?.id === t.id ? 'on' : ''} ${t.done ? 'done' : ''} due-${dueState(t)}`} onClick={() => set({ taskSelected: t.id })}>
            <input type="checkbox" checked={t.done} onClick={(e) => e.stopPropagation()} onChange={(e) => saveTask({ ...t, done: e.target.checked, doneAt: e.target.checked ? Date.now() : undefined })} />
            <div className="task-item-main">
              <span className="task-item-title">{t.title}</span>
              <span className="muted small">
                {t.due ? `⏰ ${dueLabel(t.due)}` : ''}
                {t.subtasks.length ? ` · ${t.subtasks.filter((s) => s.done).length}/${t.subtasks.length}` : ''}
              </span>
            </div>
          </div>
        ))}
        {!list.length && <div className="empty">{filter === 'done' ? 'Выполненных пока нет' : 'Задач нет. «＋ Задача» или ⏰ в ответе чата.'}</div>}
      </div>
      <div className="task-detail">{current ? <TaskEditor key={current.id} task={current} /> : <div className="empty big">Выберите или создайте задачу</div>}</div>
    </div>
  );
}

function TaskEditor({ task }: { task: Task }) {
  const [editing, setEditing] = useState(!task.body);
  const [body, setBody] = useState(task.body);
  const area = useRef<HTMLTextAreaElement>(null);
  const update = (p: Partial<Task>) => saveTask({ ...task, ...p, ...(p.due !== undefined && p.due !== task.due ? { notifiedAt: undefined } : {}) });
  // the description is saved a moment after typing stops
  useEffect(() => {
    if (body === task.body) return;
    const t = setTimeout(() => update({ body }), 500);
    return () => clearTimeout(t);
  }, [body]);
  const insertAtCursor = (text: string) => {
    const el = area.current;
    const at = el?.selectionStart ?? body.length;
    setBody((b) => b.slice(0, at) + text + b.slice(at));
  };
  const onPaste = async (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) {
      const p = await call<string>('attach:saveBlob', new Uint8Array(await f.arrayBuffer()), f.type, f.name || 'image.png');
      // forward slashes: backslashes would be escapes in Markdown
      insertAtCursor(`\n![](${p.replace(/\\/g, '/')})\n`);
    }
  };
  const subs = task.subtasks;
  return (
    <div className="task-editor">
      <div className="task-top">
        <input type="checkbox" checked={task.done} onChange={(e) => update({ done: e.target.checked, doneAt: e.target.checked ? Date.now() : undefined })} title="Выполнено" />
        <input className="task-title-input" value={task.title} onChange={(e) => update({ title: e.target.value })} />
        <button className="btn small danger" onClick={() => confirm(`Удалить задачу «${task.title}»?`) && removeTask(task.id)}>
          Удалить
        </button>
      </div>
      <div className="task-due-row">
        <span className={`task-due due-${dueState(task)}`}>{task.due ? `⏰ ${dueLabel(task.due)}` : 'Без срока'}</span>
        <input type="datetime-local" value={toLocalInput(task.due)} onChange={(e) => update({ due: e.target.value ? new Date(e.target.value).getTime() : undefined })} />
        {presets().map((p) => (
          <button key={p.label} className="btn small" onClick={() => update({ due: p.at })}>
            {p.label}
          </button>
        ))}
        {task.due && (
          <button className="btn small" onClick={() => update({ due: undefined })}>
            без срока
          </button>
        )}
      </div>
      {task.source && (
        <div className="task-source">
          Из чата{' '}
          <span
            className="path-link"
            onClick={() => {
              const src = task.source!;
              void openChat(src.sessionId, src.cwd).then(() => focusChatTurn(src.sessionId, src.turnStartedAt));
            }}
          >
            «{task.source.chatTitle}» →
          </span>
          <span className="muted small"> {formatTime(task.source.turnStartedAt)}</span>
        </div>
      )}
      <div className="task-subs">
        <div className="task-section-title">
          Подзадачи {subs.length ? `${subs.filter((s) => s.done).length}/${subs.length}` : ''}
        </div>
        {subs.map((s, i) => (
          <div key={s.id} className={`task-sub ${s.done ? 'done' : ''}`}>
            <input type="checkbox" checked={s.done} onChange={(e) => update({ subtasks: subs.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)) })} />
            <input value={s.text} onChange={(e) => update({ subtasks: subs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
            <button className="icon-btn" title="Убрать" onClick={() => update({ subtasks: subs.filter((_, j) => j !== i) })}>
              ×
            </button>
          </div>
        ))}
        <input
          className="task-sub-new"
          placeholder="＋ подзадача (Enter)"
          onKeyDown={(e) => {
            const v = e.currentTarget.value.trim();
            if (e.key !== 'Enter' || !v) return;
            update({ subtasks: [...subs, { id: crypto.randomUUID(), text: v, done: false }] });
            e.currentTarget.value = '';
          }}
        />
      </div>
      <div className="task-section-title">
        Описание
        <button className="btn small" onClick={() => setEditing(!editing)}>
          {editing ? 'Готово' : 'Изменить'}
        </button>
        {editing && <span className="muted small">Ctrl+V — вставить картинку</span>}
      </div>
      {editing ? (
        <textarea ref={area} className="task-body-input" value={body} onChange={(e) => setBody(e.target.value)} onPaste={(e) => void onPaste(e)} placeholder="Описание, ссылки, картинки (Ctrl+V)" />
      ) : (
        <div className="task-body" onDoubleClick={() => setEditing(true)} title="Двойной клик — изменить">
          {body.trim() ? <Markdown text={body} cwd={task.source?.cwd ?? ''} /> : <span className="muted">Нет описания</span>}
        </div>
      )}
    </div>
  );
}

/** ⏰ on an answer: a task from it (text of the answer, a link back to it). */
export function RemindButton({ ctx }: { ctx: { sessionId: string; cwd: string; chatTitle: string; turn: Turn } }) {
  return (
    <span
      className="fav-star remind-btn"
      title="Создать задачу / напоминание из этого ответа"
      onClick={(e) => {
        e.stopPropagation();
        const text = ctx.turn.items.filter((i) => i.kind === 'text').map((i) => (i as { text: string }).text).join('\n\n');
        remindFrom(ctx, text || ctx.turn.prompt);
      }}
    >
      ⏰
    </span>
  );
}
