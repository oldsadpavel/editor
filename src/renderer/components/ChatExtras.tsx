import { useEffect, useState } from 'react';
import type { BgTask, ChatSnapshot, PermissionRequest, ShellRun, TodoItem, Turn, TurnItemTool } from '../../shared/types';
import { call } from '../api';
import { closeChat, openChat, openFile, set, toast, updateDraft, useStore } from '../store';
import { Markdown, basename, formatTime } from '../util';

/** The model's reasoning: folded by default, like Ctrl+O in Claude Code. */
export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`thinking-block ${open ? 'open' : ''}`}>
      <div className="tb-head" onClick={() => setOpen(!open)}>
        <span className="twisty">{open ? '▾' : '▸'}</span> 💭 Размышления <span className="muted">· {text.length.toLocaleString('ru-RU')} символов</span>
      </div>
      {open && <div className="tb-body">{text}</div>}
    </div>
  );
}

/** Expanded tool call: full command/arguments, what it returned, live subagent activity. */
export function ToolDetails({ t }: { t: TurnItemTool }) {
  const empty = !t.detail && !t.output && !t.errorText && !t.sub?.length;
  if (empty) return <div className="tool-details muted small">Нет подробностей (вызов без вывода)</div>;
  return (
    <div className="tool-details">
      {t.detail && (
        <>
          <div className="td-label">Вызов</div>
          <pre className="td-pre">{t.detail}</pre>
        </>
      )}
      {t.sub?.length ? (
        <>
          <div className="td-label">Что делает субагент{!t.done ? ' (сейчас)' : ''}</div>
          <div className="td-sub">
            {t.sub.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </>
      ) : null}
      {(t.output || t.errorText) && (
        <>
          <div className="td-label">{t.error ? 'Ошибка' : 'Результат'}</div>
          <pre className={`td-pre ${t.error ? 'err' : ''}`}>{t.error ? (t.errorText ?? t.output) : t.output}</pre>
        </>
      )}
    </div>
  );
}

/** Claude's task checklist (TodoWrite), as Claude Code shows it. */
export function TodoCard({ todos }: { todos: TodoItem[] }) {
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="todo-card">
      <div className="todo-head">
        📋 План Claude <span className="muted">· {done} из {todos.length}</span>
      </div>
      {todos.map((t, i) => (
        <div key={i} className={`todo-item ${t.status}`}>
          <span className="todo-box">{t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'}</span>
          {t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content}
        </div>
      ))}
    </div>
  );
}

/** A `!command` run in bash mode. */
export function ShellCard({ run }: { run: ShellRun }) {
  return (
    <div className={`shell-card ${run.code ? 'failed' : ''}`}>
      <div className="sh-head">
        <code>$ {run.command}</code>
        <span className="muted small">
          {run.running ? (
            <>
              <span className="spinner" /> выполняется…
            </>
          ) : run.code === 0 ? (
            '✓ код 0 · вывод уйдёт Claude со следующим вопросом'
          ) : (
            `✕ код ${run.code ?? '?'} · вывод уйдёт Claude со следующим вопросом`
          )}
        </span>
      </div>
      <pre className="sh-out">{run.output || (run.running ? '' : '(пусто)')}</pre>
    </div>
  );
}

/** Background tasks of the Claude process (Bash in background, subagents), with stop. */
export function TasksBar({ chat }: { chat: ChatSnapshot }) {
  const [open, setOpen] = useState(false);
  const tasks = chat.tasks ?? [];
  const running = tasks.filter((t) => t.status === 'running');
  if (!tasks.length) return null;
  const label: Record<BgTask['status'], string> = { running: '⏳', completed: '✓', failed: '✕', stopped: '⏹' };
  return (
    <div className="tasks-bar">
      <div className="tk-head" onClick={() => setOpen(!open)}>
        <span className="twisty">{open ? '▾' : '▸'}</span> Фоновые задачи: {running.length ? <b>{running.length} идёт</b> : 'нет активных'}
        <span className="muted"> · всего {tasks.length}</span>
      </div>
      {open &&
        [...tasks].reverse().map((t) => (
          <div key={t.id} className={`tk-row ${t.status}`}>
            <span>{label[t.status]}</span>
            <span className="tk-desc" title={t.summary ?? t.description}>
              {t.description || t.summary || t.id}
              {t.kind ? <span className="muted"> · {t.kind}</span> : null}
            </span>
            <span className="muted small">{t.progress ?? formatTime(t.startedAt)}</span>
            {t.outputFile && (
              <span className="path-link small" onClick={() => openFile(t.outputFile!)}>
                вывод
              </span>
            )}
            {t.status === 'running' && (
              <button className="btn small danger" onClick={() => call('chat:stopTask', chat.sessionId, t.id).catch((e) => toast(e.message, 'error'))}>
                Остановить
              </button>
            )}
          </div>
        ))}
    </div>
  );
}

/** Rewind: back to the moment before this question — files (checkpoints) and the conversation (a new chat from there). */
export async function rewindTo(chat: ChatSnapshot, turn: Turn) {
  if (chat.status === 'running' || chat.status === 'waiting') return toast('Дождитесь конца ответа или нажмите «Стоп»', 'error');
  toast('Проверяю, что можно откатить…');
  const p = await call<{ files: { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }; conversation: boolean }>(
    'chat:rewindPreview',
    chat.sessionId,
    turn.id,
  ).catch((e) => (toast(e.message, 'error'), null));
  if (!p) return;
  const f = p.files;
  const filesNote = f.canRewind
    ? f.filesChanged?.length
      ? `Файлы вернутся к состоянию до вопроса: ${f.filesChanged.map((x) => basename(x)).join(', ')} (+${f.insertions ?? 0} −${f.deletions ?? 0} строк).`
      : 'Файлы после этого вопроса не менялись.'
    : `Файлы откатить нельзя: ${f.error ?? 'нет контрольной точки'} — откатится только разговор.`;
  const ok = confirm(
    `Откатить чат к моменту перед вопросом «${turn.prompt.slice(0, 80)}»?\n\n` +
      `• Разговор продолжится в новом чате с этой точки (старый останется в истории).\n• ${filesNote}\n• Текст вопроса вернётся в поле ввода — можно поправить и отправить.`,
  );
  if (!ok) return;
  const r = await call<{ sessionId: string; prompt: string; snapshot: ChatSnapshot }>('chat:rewind', chat.sessionId, turn.id, {
    files: f.canRewind && !!f.filesChanged?.length,
  }).catch((e) => (toast(e.message, 'error'), null));
  if (!r) return;
  set((s) => ({ chats: { ...s.chats, [r.sessionId]: r.snapshot } }));
  updateDraft(r.sessionId, (d) => ({ ...d, text: r.prompt }));
  await openChat(r.sessionId, chat.cwd);
  void closeChat(chat.sessionId);
  toast('Откат сделан: продолжайте в новом чате');
}

/** Plan mode: Claude finished its plan and asks to start (ExitPlanMode). */
export function PlanCard({ req, answer }: { req: PermissionRequest; answer: (behavior: 'allow' | 'deny', extra?: object) => void }) {
  const [feedback, setFeedback] = useState('');
  const plan = String((req.input as any).plan ?? '');
  return (
    <div className="perm-card plan-card">
      <div className="perm-title">📝 План готов — начинать?</div>
      <div className="plan-body">
        <Markdown text={plan || '(план пустой)'} cwd="" />
      </div>
      <textarea className="plan-feedback" placeholder="Что поправить в плане (для «Доработать»)…" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      <div className="perm-actions">
        <button className="btn primary" onClick={() => answer('allow')}>
          ✓ Принять план и выполнять
        </button>
        <button
          className="btn"
          title="Принять и дальше одобрять правки файлов без вопросов"
          onClick={() => {
            answer('allow');
            void call('chat:mode', req.sessionId, 'acceptEdits').catch(() => {});
          }}
        >
          ✓ Принять, правки без вопросов
        </button>
        <button className="btn danger" onClick={() => answer('deny', { message: feedback.trim() ? `Доработай план: ${feedback.trim()}` : 'Пользователь не принял план — продолжай планировать' })}>
          ✎ Доработать
        </button>
      </div>
    </div>
  );
}

/** /mcp: servers of this chat's Claude process; reconnect (signs in when a server needs it), on/off. */
export function McpModal() {
  const target = useStore((s) => s.mcpFor);
  const [list, setList] = useState<{ name: string; status: string; error?: string }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    setList(null);
    if (target) call<any[]>('chat:mcpList', target).then(setList, (e) => toast(e.message, 'error'));
  }, [target]);
  if (!target) return null;
  const close = () => set({ mcpFor: undefined });
  const act = async (name: string, action: 'reconnect' | 'enable' | 'disable') => {
    setBusy(name);
    try {
      setList(await call<any[]>('chat:mcpAction', target, name, action));
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const LABEL: Record<string, string> = { connected: '✓ подключён', failed: '✕ ошибка', 'needs-auth': '🔑 нужен вход', pending: '⏳ подключается', disabled: '⏸ выключен' };
  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal mcp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>MCP-серверы чата</b>
          <div className="grow" />
          <button className="icon-btn" onClick={close}>
            ×
          </button>
        </div>
        {!list && <div className="muted">Загрузка…</div>}
        {list?.map((s) => (
          <div key={s.name} className={`mcp-row ${s.status}`}>
            <span className="mcp-name">{s.name}</span>
            <span className="mcp-status">{LABEL[s.status] ?? s.status}</span>
            {s.error && <span className="muted small" title={s.error}>{s.error.slice(0, 80)}</span>}
            <div className="grow" />
            {s.status === 'needs-auth' && s.name.startsWith('claude.ai') && (
              <a className="btn small primary" href="https://claude.ai/settings/connectors" target="_blank">
                Войти на claude.ai
              </a>
            )}
            {s.status !== 'disabled' && (
              <button className="btn small" disabled={busy === s.name} onClick={() => act(s.name, 'reconnect')} title="Переподключить (для серверов с OAuth откроется вход в браузере)">
                {s.status === 'needs-auth' && !s.name.startsWith('claude.ai') ? 'Войти' : 'Переподключить'}
              </button>
            )}
            <button className="btn small" disabled={busy === s.name} onClick={() => act(s.name, s.status === 'disabled' ? 'enable' : 'disable')}>
              {s.status === 'disabled' ? 'Включить' : 'Выключить'}
            </button>
          </div>
        ))}
        <div className="muted small" style={{ marginTop: 8 }}>
          Коннекторы «claude.ai …» подключаются в настройках claude.ai. Свои серверы добавляются в настройках Claude Code (/permissions → settings.json) или
          командой <code>claude mcp add</code>.
        </div>
      </div>
    </div>
  );
}

/** /memory, /permissions, /hooks, /agents: Claude Code's own files, opened in the editor. */
export async function openClaudeConfig(cwd: string, kind: 'memory' | 'settings' | 'agents') {
  const r = await call<{ files: string[]; dirs: string[] }>('claude:configFiles', cwd, kind).catch((e) => (toast(e.message, 'error'), null));
  if (!r) return;
  for (const f of r.files) await openFile(f);
  for (const d of r.dirs) if (!r.files.length) void call('shell:reveal', d);
  toast(
    kind === 'memory'
      ? 'Открыта память Claude: CLAUDE.md проекта и общая — правьте и сохраняйте (Ctrl+S)'
      : kind === 'settings'
        ? 'Открыты настройки Claude Code: permissions (allow/deny) и hooks — в settings.local.json проекта'
        : r.files.length
          ? 'Открыты агенты (.claude/agents/*.md)'
          : 'Агентов пока нет — папки .claude/agents открыты, положите туда агентов (.md)',
  );
}
