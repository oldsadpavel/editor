import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalEntry, ChatSnapshot, FavoriteAnswer, FileEdit, PermissionRequest, Turn, TurnAttachment, TurnItem, TurnItemTool } from '../../shared/types';
import { call, fileUrl } from '../api';
import { isImage, pasteHasFiles, readPastedFiles } from '../clipboard';
import { isFavorite, openFavorite, removeFavorite, toggleFavorite } from '../favorites';
import { loadDraft, markSeen, openFile, openInSystem, openLightbox, renameChat, sendPrompt, set, setAutoApprove, setRemote, toast, updateDraft, useStore, type LightboxItem } from '../store';
import { Markdown, basename, formatDuration, formatTime, plural, relPath } from '../util';
import { DeployCard } from './Panels';
import { fileIcon } from './icons';

const MODES = [
  { id: '', label: 'Как в настройках Claude' },
  { id: 'default', label: 'Спрашивать' },
  { id: 'acceptEdits', label: 'Правки без вопросов' },
  { id: 'auto', label: 'Авто' },
  { id: 'plan', label: 'План' },
  { id: 'bypassPermissions', label: 'Без ограничений' },
];

export const MODELS = [
  { id: '', label: 'Модель: по умолчанию' },
  { id: 'fable', label: 'Fable — самая сильная' },
  { id: 'opus', label: 'Opus — сложные задачи' },
  { id: 'sonnet', label: 'Sonnet — быстро и умно' },
  { id: 'haiku', label: 'Haiku — быстрее всех' },
];

export const EFFORTS = [
  { id: '', label: 'Качество: по умолчанию' },
  { id: 'low', label: 'Быстро (low)' },
  { id: 'medium', label: 'Средне (medium)' },
  { id: 'high', label: 'Тщательно (high)' },
  { id: 'xhigh', label: 'Очень тщательно (xhigh)' },
  { id: 'max', label: 'Максимум (max)' },
];

/** Thumbnail/chip of an attachment; images from a transcript are fetched only when shown. */
function useAttachmentSrc(sessionId: string, a: TurnAttachment): string | undefined {
  const [src, setSrc] = useState<string | undefined>(a.path ? fileUrl(a.path) : undefined);
  useEffect(() => {
    if (a.path || !a.ref) return;
    let alive = true;
    void call<string | null>('chat:image', sessionId, a.ref.uuid, a.ref.index).then((u) => alive && u && setSrc(u));
    return () => {
      alive = false;
    };
  }, [sessionId, a.path, a.ref?.uuid, a.ref?.index]);
  return src;
}

function AttachmentThumb({ sessionId, a, onOpen }: { sessionId: string; a: TurnAttachment; onOpen: (src: string) => void }) {
  const src = useAttachmentSrc(sessionId, a);
  if (a.kind === 'file')
    return (
      <span className="att-chip" title={a.path} onClick={() => a.path && openFile(a.path)}>
        {fileIcon(a.path ?? '')} {basename(a.path ?? 'файл')}
      </span>
    );
  return (
    <span className="att-thumb" title={a.path ?? 'Картинка из истории'} onClick={() => src && onOpen(src)}>
      {src ? <img src={src} alt="" /> : <span className="spinner" />}
    </span>
  );
}

function TurnAttachments({ sessionId, list }: { sessionId: string; list: TurnAttachment[] }) {
  // Lightbox walks through every image of the turn; transcript-only images are resolved on open.
  const open = async (clicked: TurnAttachment) => {
    const images = list.filter((a) => a.kind === 'image');
    const items: LightboxItem[] = [];
    for (const a of images) {
      const src = a.path ? fileUrl(a.path) : await call<string | null>('chat:image', sessionId, a.ref!.uuid, a.ref!.index);
      if (src) items.push({ src, path: a.path });
    }
    openLightbox(items, Math.max(0, images.indexOf(clicked)));
  };
  return (
    <div className="att-row">
      {list.map((a, i) => (
        <AttachmentThumb key={i} sessionId={sessionId} a={a} onOpen={() => void open(a)} />
      ))}
    </div>
  );
}

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

/** Opens a separate window with what these answers changed in the file. */
function openDiff(sessionId: string, turnIds: string[], file: string) {
  call('chat:diff', sessionId, turnIds, file).catch((e) => toast(e.message, 'error'));
}

/** A background task finished (Bash run_in_background, subagent…): Claude Code tells the model with a <task-notification>. */
interface TaskNote {
  taskId?: string;
  status?: string;
  summary?: string;
  outputFile?: string;
}

function taskNotes(prompt: string): TaskNote[] | null {
  if (!prompt.trimStart().startsWith('<task-notification>')) return null;
  const tag = (block: string, name: string) => block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
  return [...prompt.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].map((m) => ({
    taskId: tag(m[1], 'task-id'),
    status: tag(m[1], 'status'),
    summary: tag(m[1], 'summary'),
    outputFile: tag(m[1], 'output-file'),
  }));
}

const NOTE_STATUS: Record<string, string> = { completed: '✓ завершена', failed: '✕ с ошибкой', killed: '⏹ остановлена', running: '⏳ идёт' };

/** One line for the turn head: what finished, without the XML. */
function promptHeadline(prompt: string): string {
  const notes = taskNotes(prompt);
  if (!notes) return firstLine(prompt);
  return '🔔 ' + notes.map((n) => n.summary ?? `Фоновая задача ${n.taskId ?? ''}`).join(' · ');
}

/** The question part of a turn: a normal prompt, or a card for background-task notifications. */
function PromptText({ prompt, cwd }: { prompt: string; cwd: string }) {
  const notes = taskNotes(prompt);
  if (!notes) return <div className="q-text">{prompt}</div>;
  return (
    <div className="task-notes">
      {notes.map((n, i) => (
        <div key={i} className={`task-note ${n.status ?? ''}`} title={`Фоновая задача ${n.taskId ?? ''} — Claude Code сообщил о ней сам, это не ваш вопрос`}>
          <span className="tn-ico">🔔</span>
          <span className="tn-text">
            Фоновая задача {NOTE_STATUS[n.status ?? ''] ?? n.status ?? ''}
            {n.summary && <b> · {n.summary}</b>}
          </span>
          {n.outputFile && (
            <span className="path-link" title={n.outputFile} onClick={() => openFile(n.outputFile!)}>
              вывод: {relPath(n.outputFile, cwd).split(/[\\/]/).pop()}
            </span>
          )}
        </div>
      ))}
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
        {errors > 0 && (
          <span
            className="err-count"
            title={tools
              .filter((t) => t.error)
              .map((t) => `${t.name}${t.path ? ' ' + basename(t.path) : ''}: ${t.errorText ?? 'ошибка'}`)
              .join('\n\n')}
          >
            ! {errors} с ошибкой
          </span>
        )}
      </div>
      {open && (
        <div className="tool-list">
          {tools.map((t) => (
            <div key={t.id} className={`tool-row ${t.error ? 'err' : ''}`} title={t.error ? t.errorText : undefined}>
              {t.error && (
                <span className="err-mark" title={t.errorText ?? 'Ошибка'}>
                  !
                </span>
              )}
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

type BodyTab = 'answer' | 'files' | 'approvals';

function TurnBody({
  turn,
  cwd,
  partial,
  sessionId,
  approvals,
  tab,
  setTab,
}: {
  turn: Turn;
  cwd: string;
  partial?: string;
  sessionId: string;
  approvals: ApprovalEntry[];
  tab: BodyTab;
  setTab: (t: BodyTab) => void;
}) {
  // Consecutive tool calls are folded into one group so the text answer stays readable.
  const blocks: ({ kind: 'text'; text: string } | { kind: 'tools'; tools: Extract<TurnItem, { kind: 'tool' }>[] })[] = [];
  for (const it of turn.items) {
    const last = blocks[blocks.length - 1];
    if (it.kind === 'text') blocks.push({ kind: 'text', text: it.text });
    else if (last?.kind === 'tools') last.tools.push(it);
    else blocks.push({ kind: 'tools', tools: [it] });
  }
  const edits = [...turn.edits].sort((a, b) => b.lastAt - a.lastAt);
  const autoN = approvals.filter((a) => a.decision === 'auto').length;
  const denyN = approvals.filter((a) => a.decision === 'deny').length;
  return (
    <div className="turn-body turn-split">
      <div className="turn-main">
      <div className="question">
        <div className="q-label">
          {turn.more?.length ? `Вопрос 1 из ${turn.more.length + 1}` : 'Вопрос'} · {formatTime(turn.startedAt)}
        </div>
        {turn.prompt && <PromptText prompt={turn.prompt} cwd={cwd} />}
        {turn.attachments?.length ? (
          <TurnAttachments sessionId={sessionId} list={turn.attachments} />
        ) : (
          !turn.prompt && turn.images > 0 && !turn.more?.length && <div className="q-text">[{turn.images} изображение]</div>
        )}
        {turn.more?.map((m, i) => (
          <div key={i} className={`q-more ${m.pending ? 'pending' : ''}`} title={m.pending ? 'В очереди: Claude ещё не взял этот вопрос в работу' : 'Claude взял этот вопрос в работу'}>
            <div className="q-label">
              Вопрос {i + 2} из {turn.more!.length + 1} · {formatTime(m.at)} ·{' '}
              {m.pending ? '⏳ в очереди — Claude ещё не взял' : '✓ взят в работу — ответ общий'}
            </div>
            {m.prompt && <PromptText prompt={m.prompt} cwd={cwd} />}
            {m.attachments?.length ? <TurnAttachments sessionId={sessionId} list={m.attachments} /> : null}
          </div>
        ))}
      </div>
      {tab === 'answer' && (
        <>
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
        </>
      )}
      {tab === 'files' && (
        <div className="turn-files">
          {edits.map((e) => (
            <div key={e.path} className="dd-row" onClick={() => openFile(e.path)} title={e.path}>
              <span className="dd-name">{basename(e.path)}</span>
              <span className="dd-path">{relPath(e.path, cwd).replace(/[^\\/]*$/, '')}</span>
              <span className="dd-meta">{editLabel(e)}</span>
              <span className="dd-time">{formatTime(e.lastAt)}</span>
              <button
                className="btn small diff-btn"
                title="Что изменилось в этом файле в этом ответе — в отдельном окне"
                onClick={(ev) => (ev.stopPropagation(), openDiff(sessionId, [turn.id], e.path))}
              >
                Δ изменения
              </button>
            </div>
          ))}
          {!edits.length && <div className="muted small">В этом ответе файлы не менялись.</div>}
        </div>
      )}
      {tab === 'approvals' && (
        <div className="turn-files">
          {approvals.map((a, i) => (
            <div key={i} className={`approval-row inline ${a.decision}`}>
              <span className="adecision">{DECISION_LABEL[a.decision]}</span>
              <span className="atool">{a.tool.replace(/^mcp__/, '')}</span>
              <span className="asum" title={a.summary}>
                {a.summary}
              </span>
              <span className="muted small">{formatTime(a.at)}</span>
            </div>
          ))}
          {!approvals.length && <div className="muted small">В этом ответе Claude ничего не спрашивал.</div>}
        </div>
      )}
      </div>
      {/* Vertical tabs on the right of the answer */}
      <div className="turn-side">
        <span className={`side-tab ${tab === 'answer' ? 'on' : ''}`} onClick={() => setTab('answer')} title="Ответ">
          <span className="side-ico">💬</span>
        </span>
        <span className={`side-tab ${tab === 'files' ? 'on' : ''} ${!edits.length ? 'empty' : ''}`} onClick={() => setTab('files')} title={`Файлы, изменённые в этом ответе: ${edits.length}`}>
          <span className="side-ico">✎</span>{edits.length > 0 && <span className="count">{edits.length}</span>}
        </span>
        <span
          className={`side-tab ${tab === 'approvals' ? 'on' : ''} ${!approvals.length ? 'empty' : ''} ${denyN ? 'deny' : autoN && autoN === approvals.length ? 'auto' : ''}`}
          onClick={() => setTab('approvals')}
          title={`Что Claude спрашивал в этом ответе и как решено${autoN ? `\n⚡ авто: ${autoN}` : ''}${denyN ? `\n✕ отклонено: ${denyN}` : ''}`}
        >
          <span className="side-ico">🛡</span>{approvals.length > 0 && <span className="count">{approvals.length}</span>}
        </span>
      </div>
    </div>
  );
}

const kTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * Tokens spent on the answer. The headline is what the model processed (fresh input + cache writes + output);
 * cache reads are cheap and shown only in the tooltip.
 */
/** «claude-fable-5-1» → «Fable 5.1»; unknown ids are shown as they are. */
function modelName(id: string) {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length <= 2 ? '.' + m[3] : ''}` : id;
}

function TokensBadge({ turn }: { turn: Turn }) {
  const t = turn.tokens;
  if (!t) return null;
  const main = t.input + t.cacheWrite + t.output;
  // Subagents (Agent/Task tool) did part of the work in their own context.
  const agents = turn.items.filter((i) => i.kind === 'tool' && (i.name === 'Agent' || i.name === 'Task')).map((i) => (i as TurnItemTool).summary).filter(Boolean);
  const tip = [
    turn.models?.length ? `Отвечал: ${turn.models.map((m) => `${modelName(m)} (${m})`).join(', ')}` : 'Модель: нет данных',
    ...(agents.length ? [`Субагенты: ${agents.slice(0, 5).join('; ')}${agents.length > 5 ? ` и ещё ${agents.length - 5}` : ''}`] : []),
    '',
    'Токены на этот ответ',
    `Вход: ${t.input.toLocaleString('ru-RU')}`,
    `Выход: ${t.output.toLocaleString('ru-RU')}`,
    `Запись в кеш: ${t.cacheWrite.toLocaleString('ru-RU')}`,
    `Чтение из кеша: ${t.cacheRead.toLocaleString('ru-RU')} (дешевле в 10 раз)`,
    `Всего с кешем: ${(main + t.cacheRead).toLocaleString('ru-RU')}`,
    ...(turn.costUsd !== undefined ? [`Стоимость по ценам API: $${turn.costUsd.toFixed(4)}`] : []),
  ].join('\n');
  return (
    <span className="turn-tokens" title={tip}>
      {turn.models?.length ? <span className="turn-model">{modelName(turn.models[turn.models.length - 1]).split(' ')[0]}</span> : null}🪙 {kTokens(main)}
    </span>
  );
}

/** Turn head for a question without text: what was attached (file names, or that it is a picture). */
function attachmentsHeadline(attachments: Turn['attachments'], images?: unknown): string {
  const files = (attachments ?? []).filter((a) => a.kind === 'file' && a.path).map((a) => a.path!.split(/[\\/]/).pop());
  if (files.length) return files.join(', ');
  return attachments?.length || images ? '(изображение)' : '(вложение)';
}

function firstLine(s: string) {
  const l = s.trim().split('\n')[0];
  return l.length > 140 ? l.slice(0, 140) + '…' : l;
}

function FavStar({ sessionId, turn }: { sessionId: string; turn: Turn }) {
  const fav = useStore((s) => isFavorite(s.app?.favoriteAnswers, sessionId, turn));
  return (
    <span
      className={`fav-star ${fav ? 'on' : ''}`}
      title={fav ? 'В избранном — нажмите, чтобы убрать' : 'Сохранить ответ в избранное'}
      onClick={(e) => (e.stopPropagation(), toggleFavorite(sessionId, turn))}
    >
      {fav ? '★' : '☆'}
    </span>
  );
}

function TurnRow({
  turn,
  cwd,
  open,
  onToggle,
  partial,
  highlight,
  sessionId,
  approvals,
}: {
  turn: Turn;
  cwd: string;
  open: boolean;
  onToggle: () => void;
  partial?: string;
  highlight?: boolean;
  sessionId: string;
  approvals: ApprovalEntry[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [bodyTab, setBodyTab] = useState<BodyTab>('answer');
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [highlight]);
  const dur = turn.answeredAt ? turn.answeredAt - turn.startedAt : 0;
  const showTab = (t: BodyTab) => {
    setBodyTab(t);
    if (!open) onToggle();
  };
  return (
    <div className={`turn ${open ? 'open' : ''} ${turn.live ? 'live' : ''} ${turn.error ? 'failed' : ''} ${highlight ? 'flash' : ''}`} ref={ref}>
      <div className="turn-head" onClick={onToggle}>
        <span className="twisty">{open ? '▾' : '▸'}</span>
        <span className="turn-q">
          {turn.attachments?.length ? (
            <span className="att-badge" title="Вложения">
              📎{turn.attachments.length}
            </span>
          ) : null}
          {promptHeadline(turn.prompt) || attachmentsHeadline(turn.attachments, turn.images)}
        </span>
        {turn.more?.length ? (
          <span className="more-badge" title={turn.more.map((m) => promptHeadline(m.prompt)).join('\n')}>
            +{turn.more.length} {plural(turn.more.length, 'вопрос', 'вопроса', 'вопросов')}
          </span>
        ) : null}
        {turn.edits.length > 0 && (
          <span
            className="edits-btn"
            title="Файлы, изменённые в этом ответе"
            onClick={(e) => {
              e.stopPropagation();
              showTab('files');
            }}
          >
            ✎ {turn.edits.length} {plural(turn.edits.length, 'файл', 'файла', 'файлов')}
          </span>
        )}
        {approvals.length > 0 && (
          <span
            className={`perm-badge ${approvals.some((a) => a.decision === 'deny') ? 'deny' : approvals.every((a) => a.decision === 'auto') ? 'auto' : ''}`}
            title="Разрешения в этом ответе"
            onClick={(e) => {
              e.stopPropagation();
              showTab('approvals');
            }}
          >
            🛡 {approvals.length}
          </span>
        )}
        <TokensBadge turn={turn} />
        {!turn.live && <FavStar sessionId={sessionId} turn={turn} />}
        <span className="turn-date" title={`Вопрос: ${new Date(turn.startedAt).toLocaleString('ru-RU')}${turn.answeredAt ? `\nОтвет: ${new Date(turn.answeredAt).toLocaleString('ru-RU')}` : ''}`}>
          {turn.live ? <span className="spinner" /> : turn.error ? '⚠' : '✓'} {formatTime(turn.answeredAt ?? turn.startedAt)}
          {dur > 0 && !turn.live && <span className="muted"> · {formatDuration(dur)}</span>}
        </span>
      </div>
      {open && <TurnBody turn={turn} cwd={cwd} partial={partial} sessionId={sessionId} approvals={approvals} tab={bodyTab} setTab={setBodyTab} />}
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
        <button
          className="btn auto-all"
          title="Включить автоодобрение для этого чата: этот и все следующие запросы одобряются сами (журнал — во вкладке «Разрешения»)"
          onClick={() => setAutoApprove(req.sessionId, true)}
        >
          ⚡ Разрешать всё в этом чате
        </button>
        <button className="btn danger" onClick={() => answer('deny')}>
          Отклонить
        </button>
      </div>
    </div>
  );
}

function AttachmentChips({ paths, onRemove }: { paths: string[]; onRemove: (p: string) => void }) {
  if (!paths.length) return null;
  const images = paths.filter(isImage);
  return (
    <div className="att-row composer-atts">
      {paths.map((p) =>
        isImage(p) ? (
          <span key={p} className="att-thumb" title={p} onClick={() => openLightbox(images.map((x) => ({ src: fileUrl(x), path: x })), images.indexOf(p))}>
            <img src={fileUrl(p)} alt="" />
            <span className="att-x" onClick={(e) => (e.stopPropagation(), onRemove(p))} title="Убрать">
              ×
            </span>
          </span>
        ) : (
          <span key={p} className="att-chip" title={p} onClick={() => openInSystem(p)}>
            {fileIcon(p)} {basename(p)}
            <span className="att-x" onClick={(e) => (e.stopPropagation(), onRemove(p))} title="Убрать">
              ×
            </span>
          </span>
        ),
      )}
    </div>
  );
}

function Composer({ chat, onSent }: { chat: ChatSnapshot; onSent: () => void }) {
  // The draft (text + attachments) lives in the store per chat, so switching chats or restarting keeps it.
  const draft = useStore((s) => s.drafts[chat.sessionId]) ?? loadDraft(chat.sessionId);
  const text = draft.text;
  const attachments = draft.attachments;
  const setText = (v: string | ((prev: string) => string)) => updateDraft(chat.sessionId, (d) => ({ ...d, text: typeof v === 'function' ? v(d.text) : v }));
  const setAttachments = (v: string[] | ((prev: string[]) => string[])) =>
    updateDraft(chat.sessionId, (d) => ({ ...d, attachments: typeof v === 'function' ? v(d.attachments) : v }));
  const [dragOver, setDragOver] = useState(false);
  const defaultMode = useStore((s) => s.app!.defaultPermissionMode ?? '');
  const [mode, setMode] = useState(chat.permissionMode ?? defaultMode);
  const [model, setModel] = useState(chat.model ?? '');
  const [effort, setEffort] = useState(chat.effort ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = chat.status === 'running' || chat.status === 'waiting';
  const activeFile = useStore((s) => s.activeFile);

  const addFiles = (paths: string[]) => {
    if (!paths.length) return;
    setAttachments((a) => [...a, ...paths.filter((p) => !a.includes(p))]);
    ref.current?.focus();
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    if (!pasteHasFiles(e)) return; // ordinary text: default paste
    e.preventDefault();
    const files = e.clipboardData.files;
    try {
      addFiles(await readPastedFiles(files, { fallback: true }));
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    // A file dragged from the project tree carries its path as text.
    const treePath = e.dataTransfer.getData('application/x-editor-path');
    if (treePath) return addFiles([treePath]);
    addFiles(await readPastedFiles(e.dataTransfer.files));
  };

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

  // `/` menu: editor commands plus the session's own Claude Code commands (loaded when the menu opens).
  const [commands, setCommands] = useState<SlashItem[] | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const slashQuery = /^\/[^\s]*$/.test(text) ? text.slice(1).toLowerCase() : null;
  useEffect(() => {
    if (slashQuery === null || commands) return;
    void call<SlashItem[]>('chat:commands', chat.sessionId).then((list) => setCommands(list), () => setCommands([]));
  }, [slashQuery !== null]);
  const menu = slashQuery === null ? [] : mergeCommands(commands ?? []).filter((c) => c.name.toLowerCase().includes(slashQuery)).slice(0, 12);
  useEffect(() => setMenuIndex(0), [slashQuery]);
  const pickCommand = (c: SlashItem) => {
    setText(`/${c.name}${c.local && !c.argumentHint ? '' : ' '}`);
    ref.current?.focus();
  };

  const submit = async () => {
    const t = text.trim();
    if (!t && !attachments.length) return;
    // Editor-side commands are answered here, not sent to Claude.
    const rename = t.match(/^\/rename\s+(.+)$/s);
    if (rename) {
      setText('');
      void renameChat(chat.sessionId, rename[1].trim());
      toast(`Чат переименован: ${rename[1].trim()}`);
      return;
    }
    if (t === '/chrome') {
      setText('');
      void call('chat:chrome', chat.sessionId, !chat.chrome);
      toast(chat.chrome ? 'Claude in Chrome выключен для этого чата' : 'Claude in Chrome включён: Claude может открывать страницы, кликать и читать их в вашем Chrome');
      return;
    }
    if (t === '/rc' || t === '/remote-control') {
      setText('');
      void setRemote(chat.sessionId, !chat.remote);
      return;
    }
    if (t === '/status' || t === '/context') {
      setText('');
      set({ statusFor: { sessionId: chat.sessionId, section: t === '/context' ? 'context' : undefined } });
      return;
    }
    const sent = { text, attachments };
    setText('');
    setAttachments([]);
    onSent();
    const ok = await sendPrompt(chat.sessionId, t, { permissionMode: mode || undefined, model, effort, attachments: sent.attachments });
    if (!ok) {
      // Keep what the user typed if sending failed.
      setText(sent.text);
      setAttachments(sent.attachments);
    }
  };

  return (
    <div
      className={`composer ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <AttachmentChips paths={attachments} onRemove={(p) => setAttachments((a) => a.filter((x) => x !== p))} />
      {menu.length > 0 && (
        <div className="slash-menu">
          {menu.map((c, i) => (
            <div
              key={c.name}
              className={`slash-item ${i === menuIndex ? 'on' : ''}`}
              onMouseEnter={() => setMenuIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pickCommand(c);
              }}
            >
              <span className="slash-name">/{c.name}</span>
              {c.argumentHint && <span className="muted"> {c.argumentHint}</span>}
              <span className="slash-desc">{c.description}</span>
              {c.local && <span className="chip">редактор</span>}
            </div>
          ))}
        </div>
      )}
      {/* Which chat this goes to — hard to miss, so a question doesn't land in the wrong chat. */}
      <div className="composer-target" title={`${chat.title}\n${chat.cwd}`}>
        <span className="muted">Пишете в:</span> <b>{chat.title}</b>
        <span className="ct-project">{basename(chat.cwd)}</span>
      </div>
      <textarea
        ref={ref}
        value={text}
        placeholder={
          chat.remote
            ? `«${chat.title}» · удалённый режим: вопрос уйдёт в тот же чат, что и на телефоне`
            : busy
            ? `«${chat.title}» · Claude работает… можно дописать — сообщение уйдёт в очередь`
            : `Вопрос в «${chat.title}» (${basename(chat.cwd)})… Enter — отправить, Shift+Enter — перенос, Ctrl+V — скриншот или файлы`
        }
        onPaste={onPaste}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (menu.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setMenuIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : menu.length - 1)) % menu.length);
              return;
            }
            // Tab completes; Enter completes too unless the command is already typed in full.
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && text.trim() !== `/${menu[menuIndex].name}`)) {
              e.preventDefault();
              pickCommand(menu[menuIndex]);
              return;
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
          if (e.key === 'Escape' && busy) void call('chat:interrupt', chat.sessionId);
        }}
      />
      <div className="composer-bar">
        <select value={model} onChange={(e) => setModel(e.target.value)} title="Какая модель отвечает (меняется на лету, история чата сохраняется)">
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <select value={effort} onChange={(e) => setEffort(e.target.value)} title="Качество ответа: сколько модель думает перед ответом">
          {EFFORTS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value)} title="Режим разрешений">
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <label
          className={`auto-approve approve-all ${chat.autoApprove ? 'on' : ''}`}
          title={
            chat.autoApprove
              ? 'Автоодобрение включено: всё, что Claude просит подтвердить (команды, правки, выполнение плана), одобряется само. Журнал — вкладка «Разрешения». Нажмите, чтобы выключить.'
              : 'Автоодобрение: одобрять всё, что Claude просит подтвердить. Каждое решение пишется во вкладку «Разрешения».'
          }
        >
          <input type="checkbox" checked={!!chat.autoApprove} onChange={(e) => setAutoApprove(chat.sessionId, e.target.checked)} />
          ⚡ Подтверждать всё
        </label>
        <label
          className={`auto-approve remote ${chat.remote ? 'on' : ''}`}
          title={
            chat.remote
              ? '/RC (Remote Control) включён: чат виден и управляется с claude.ai/code и из приложения Claude, и отсюда тоже. Подтверждения — с телефона или ⚡ Авто. Снимите галочку, чтобы вернуть обычный режим.'
              : '/RC — Remote Control, как в Claude Code: чат появится на claude.ai/code и в приложении Claude на телефоне; писать можно и там, и здесь. На Windows нужен Git for Windows (winpty), на macOS ничего не нужно.'
          }
        >
          <input type="checkbox" checked={!!chat.remote} onChange={(e) => setRemote(chat.sessionId, e.target.checked)} />
          /RC
        </label>
        <label
          className={`auto-approve chrome ${chat.chrome ? 'on' : ''}`}
          title="Claude in Chrome (/chrome): Claude управляет вашим Chrome через расширение — открывает страницы, кликает, читает, заполняет формы. Нужно расширение Claude in Chrome. Переключение перезапускает процесс Claude (история сохраняется)."
        >
          <input type="checkbox" checked={!!chat.chrome} onChange={(e) => void call('chat:chrome', chat.sessionId, e.target.checked)} />
          🌐 Chrome
        </label>
        {chat.remote && (
          <a className="small" href="https://claude.ai/code" target="_blank" title="Открыть список сессий на claude.ai/code">
            claude.ai/code ↗
          </a>
        )}
        <button className="btn small" title="Прикрепить файл (или Ctrl+V / перетащите файл сюда)" onClick={() => pickFiles(addFiles)}>
          📎
        </button>
        {activeFile && (
          <button className="btn small" title={`Вставить путь открытого файла: ${basename(activeFile)}\n${activeFile}`} onClick={() => setText((v) => v + (v ? ' ' : '') + activeFile + ' ')}>
            @F
          </button>
        )}
        <div className="grow" />
        {busy && (
          chat.turns[chat.turns.length - 1]?.more?.some((m) => m.pending) ? (
            <button
              className="btn danger small"
              onClick={() => call('chat:interrupt', chat.sessionId)}
              title="Esc — бросить текущий ответ и сразу взяться за вопросы из очереди (серые)"
            >
              ⏭ Стоп и к новому
            </button>
          ) : (
            <button className="btn danger small" onClick={() => call('chat:interrupt', chat.sessionId)} title="Esc">
              ⛔ Стоп
            </button>
          )
        )}
        <button className="btn primary small" disabled={!text.trim() && !attachments.length} onClick={() => void submit()}>
          Отправить ↵
        </button>
      </div>
    </div>
  );
}

interface SlashItem {
  name: string;
  description: string;
  argumentHint?: string;
  /** Handled by the editor itself instead of being sent to Claude Code. */
  local?: boolean;
}

const LOCAL_COMMANDS: SlashItem[] = [
  { name: 'status', description: 'Состояние чата: модель, режим, MCP-серверы, контекст, лимиты', local: true },
  { name: 'context', description: 'Сколько занято окно контекста и чем', local: true },
  { name: 'rename', description: 'Переименовать этот чат: /rename новое имя', argumentHint: '<имя>', local: true },
  { name: 'chrome', description: 'Claude in Chrome: включить/выключить управление браузером через расширение', local: true },
  { name: 'rc', description: 'Remote Control: включить/выключить — чат на claude.ai/code и в приложении Claude', local: true },
];

/** Editor commands first; Claude Code's own list follows (its /status and /context are replaced by the editor's). */
function mergeCommands(session: SlashItem[]): SlashItem[] {
  const local = new Set(LOCAL_COMMANDS.map((c) => c.name));
  return [...LOCAL_COMMANDS, ...session.filter((c) => !local.has(c.name))];
}

/** System "open file" dialog through a hidden <input type=file>; paths come from the preload bridge. */
function pickFiles(onPick: (paths: string[]) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = () => void readPastedFiles(input.files).then(onPick);
  input.click();
}

const NO_APPROVALS: ApprovalEntry[] = [];
const DECISION_LABEL: Record<ApprovalEntry['decision'], string> = {
  auto: '⚡ автоодобрено',
  allow: '✓ разрешено вами',
  always: '✓✓ разрешено навсегда',
  deny: '✕ отклонено вами',
};

function ApprovalsTab({ chat }: { chat: ChatSnapshot }) {
  const list = [...chat.approvals].reverse();
  return (
    <div className="approvals-tab">
      <label className={`auto-approve big ${chat.autoApprove ? 'on' : ''}`}>
        <input type="checkbox" checked={!!chat.autoApprove} onChange={(e) => setAutoApprove(chat.sessionId, e.target.checked)} />
        ⚡ Одобрять все запросы разрешений автоматически в этом чате
      </label>
      <div className="muted small approvals-note">
        Журнал всех решений по разрешениям в этом чате — и ваших кликов, и автоодобрения. Хранится в approvals.jsonl в папке данных редактора.
      </div>
      {list.map((a, i) => (
        <div key={i} className={`approval-row ${a.decision}`}>
          <span className="adecision">{DECISION_LABEL[a.decision]}</span>
          <span className="atool">{a.tool.replace(/^mcp__/, '')}</span>
          <span className="asum" title={a.summary}>
            {a.summary}
          </span>
          <span className="muted small">{formatTime(a.at)}</span>
        </div>
      ))}
      {!list.length && <div className="empty">Решений по разрешениям в этом чате ещё не было.</div>}
    </div>
  );
}

export { MODES };

export function ChatView({ chat }: { chat: ChatSnapshot }) {
  const [tab, setTab] = useState<'chat' | 'files' | 'deploys' | 'approvals' | 'favorites'>('chat');
  const favCount = useStore((s) => (s.app?.favoriteAnswers ?? []).filter((f) => f.sessionId === chat.sessionId).length);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(chat.turns.slice(-1).map((t) => t.id)));
  const [q, setQ] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** When the user last scrolled by hand (wheel, touch, keys, scrollbar). Only that can unpin the view. */
  const userScrollAt = useRef(0);
  const focus = useStore((s) => (s.focusTurn?.sessionId === chat.sessionId ? s.focusTurn : undefined));
  const deploys = useStore((s) => s.deploys.filter((d) => d.sessionId === chat.sessionId));
  const files = useMemo(() => aggregate(chat.turns), [chat.turns]);
  const last = chat.turns[chat.turns.length - 1];
  const chatBusy = chat.status === 'running' || chat.status === 'waiting';
  // A decision belongs to the turn that was running when it was made. Matched by time, because a turn's id
  // differs between the live run (random) and the transcript reload (message uuid).
  const approvalsByTurn = useMemo(() => {
    const m = new Map<string, ApprovalEntry[]>();
    const starts = chat.turns.map((t) => t.startedAt);
    for (const a of chat.approvals) {
      let i = starts.findIndex((s) => s > a.at) - 1;
      if (i === -2) i = starts.length - 1;
      const id = chat.turns[i]?.id;
      if (id) (m.get(id) ?? m.set(id, []).get(id)!).push(a);
    }
    return m;
  }, [chat.approvals, chat.turns]);

  useEffect(() => markSeen(chat.sessionId), [chat.sessionId, chat.status]);

  // A new last question (asked here, from the phone, or re-read from the transcript with a new id) auto-expands
  // so its answer is visible.
  const lastSeenId = useRef(last?.id);
  useEffect(() => {
    if (!last) return;
    if (last.live || last.id !== lastSeenId.current) setExpanded((s) => (s.has(last.id) ? s : new Set(s).add(last.id)));
    lastSeenId.current = last.id;
  }, [last?.id, last?.live]);

  useEffect(() => {
    if (!focus) return;
    setTab('chat');
    setExpanded((s) => new Set(s).add(focus.turnId));
    stick.current = false;
    // The jump is done once the turn is on screen; after that the chat follows new output again (if at the bottom).
    const t = setTimeout(() => set({ focusTurn: undefined }), 1500);
    return () => clearTimeout(t);
  }, [focus?.nonce]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current && tab === 'chat' && !focus) el.scrollTop = el.scrollHeight;
  }, [chat, tab]);

  // Content keeps growing after a render (a turn expands, thumbnails load, the answer streams): while the view is
  // pinned to the bottom, every size change scrolls to the end again.
  // The scroll area itself also shrinks and grows (permission cards, composer height, window size).
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = content.current;
    const sc0 = scroller.current;
    if (!el || !sc0) return;
    const ro = new ResizeObserver(() => {
      const sc = scroller.current;
      if (sc && stick.current && !focusRef.current) sc.scrollTop = sc.scrollHeight;
    });
    ro.observe(el);
    ro.observe(sc0);
    return () => ro.disconnect();
  }, [tab]);
  const focusRef = useRef(focus);
  focusRef.current = focus;

  const needle = q.toLowerCase();
  const turns = needle
    ? chat.turns.filter(
        (t) =>
          t.prompt.toLowerCase().includes(needle) ||
          t.more?.some((m) => m.prompt.toLowerCase().includes(needle)) ||
          t.items.some((i) => i.kind === 'text' && i.text.toLowerCase().includes(needle)),
      )
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
        onWheel={() => (userScrollAt.current = Date.now())}
        onTouchMove={() => (userScrollAt.current = Date.now())}
        onKeyDown={() => (userScrollAt.current = Date.now())}
        onPointerDown={(e) => {
          // a press on the scrollbar (right of the content box)
          const el = e.currentTarget;
          if (e.clientX <= el.getBoundingClientRect().left + el.clientWidth) return;
          // dragging the thumb: counts as scrolling by hand until the button is released
          userScrollAt.current = Number.MAX_SAFE_INTEGER;
          window.addEventListener('pointerup', () => (userScrollAt.current = Date.now()), { once: true });
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          // Back at the bottom always re-pins. Leaving it only counts when the user scrolled: while an answer streams,
          // content grows between our scroll and this event, which must not unpin the view.
          if (atBottom) stick.current = true;
          else if (Date.now() - userScrollAt.current < 800 || userScrollAt.current === Number.MAX_SAFE_INTEGER) stick.current = false;
        }}
      >
        {tab === 'chat' && (
          <div ref={content}>
            {turns.map((t) => (
              <TurnRow
                key={t.id}
                // A question can only be "in progress" while the chat itself is working.
                turn={t.live && !chatBusy ? { ...t, live: false } : t}
                cwd={chat.cwd}
                sessionId={chat.sessionId}
                open={expanded.has(t.id) || (!!needle && turns.length <= 3)}
                onToggle={() => toggle(t.id)}
                partial={t === last ? chat.partial : undefined}
                highlight={focus?.turnId === t.id}
                approvals={approvalsByTurn.get(t.id) ?? NO_APPROVALS}
              />
            ))}
            {!chat.turns.length && <div className="empty">Новый чат в {chat.cwd}. Задайте вопрос ниже.</div>}
          </div>
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
                <button className="btn small diff-btn" title="Все изменения этого файла в чате — в отдельном окне" onClick={() => openDiff(chat.sessionId, f.turns, f.path)}>
                  Δ
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
        {tab === 'approvals' && <ApprovalsTab chat={chat} />}
        {tab === 'favorites' && <FavoritesTab chat={chat} onOpen={() => setTab('chat')} />}
      </div>
      {chat.pending.map((p) => (
        <PermissionCard key={p.id} req={p} />
      ))}
      {tab === 'chat' && (
        <Composer
          chat={chat}
          onSent={() => {
            // A new question always brings the view to the end of the chat, even if it was scrolled up.
            stick.current = true;
            set({ focusTurn: undefined });
            setQ('');
            requestAnimationFrame(() => scroller.current && (scroller.current.scrollTop = scroller.current.scrollHeight));
          }}
        />
      )}
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
        <div className={`tab ${tab === 'approvals' ? 'on' : ''}`} onClick={() => setTab('approvals')} title="Журнал разрешений и автоодобрений">
          🛡 Разрешения {chat.approvals.length > 0 && <span className="count">{chat.approvals.length}</span>}
          {chat.autoApprove && <span className="auto-dot" title="Автоодобрение включено" />}
        </div>
        <div className={`tab ${tab === 'favorites' ? 'on' : ''}`} onClick={() => setTab('favorites')} title="Ответы, сохранённые в избранное (☆ у ответа)">
          ★ Избранное {favCount > 0 && <span className="count">{favCount}</span>}
        </div>
        <div className="grow" />
        <span className="muted chat-cwd" title={chat.sessionId}>
          {chat.cwd}
        </span>
      </div>
    </div>
  );
}


/** Saved answers: this chat's first, other chats on request. Click — jump to the answer (opens its chat). */
function FavoritesTab({ chat, onOpen }: { chat: ChatSnapshot; onOpen: () => void }) {
  const all = useStore((s) => s.app?.favoriteAnswers ?? NO_FAVS);
  const [everywhere, setEverywhere] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const list = [...all].filter((f) => everywhere || f.sessionId === chat.sessionId).sort((a, b) => b.savedAt - a.savedAt);
  return (
    <div className="favorites-tab">
      <div className="fav-bar">
        <label>
          <input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} /> из всех чатов ({all.length})
        </label>
      </div>
      {list.map((f: FavoriteAnswer) => (
        <div key={f.id} className="fav-item">
          <div className="fav-head" onClick={() => setOpen(open === f.id ? null : f.id)}>
            <span className="twisty">{open === f.id ? '▾' : '▸'}</span>
            <span className="fav-q">{f.prompt.split('\n')[0].slice(0, 140) || '(без текста)'}</span>
            {f.sessionId !== chat.sessionId && (
              <span className="tproj" title={f.cwd}>
                {f.chatTitle}
              </span>
            )}
            <span className="muted small">{formatTime(f.startedAt)}</span>
            <button className="btn small" title="Показать в чате" onClick={(e) => (e.stopPropagation(), onOpen(), void openFavorite(f))}>
              → в чат
            </button>
            <button className="btn small" title="Убрать из избранного" onClick={(e) => (e.stopPropagation(), removeFavorite(f.id))}>
              ✕
            </button>
          </div>
          {open === f.id && (
            <div className="fav-body">
              <Markdown text={f.answer || '(ответ без текста)'} cwd={f.cwd} />
            </div>
          )}
        </div>
      ))}
      {!list.length && <div className="empty">Здесь будут ответы, отмеченные ☆ в заголовке ответа.</div>}
    </div>
  );
}

const NO_FAVS: FavoriteAnswer[] = [];
