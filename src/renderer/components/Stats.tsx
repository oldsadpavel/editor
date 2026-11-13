import { useEffect, useState } from 'react';
import type { ChatSpend, CronJob } from '../../shared/types';
import { call } from '../api';
import { get, openChat, saveApp, set, useStore } from '../store';
import { formatTime } from '../util';
import { ContextMenu } from './ContextMenu';

const WINDOW = 5 * 3600_000;
const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const pct = (x: number) => (x >= 10 ? Math.round(x) : x.toFixed(1)) + '%';

/** 📊 Spending in the current 5-hour window by chat, model, tools and the biggest answers; and the chats' cron jobs. */
export function StatsModal() {
  const tab = useStore((s) => s.statsOpen);
  const usage = useStore((s) => s.usage);
  const [spend, setSpend] = useState<ChatSpend[] | null>(null);
  const [cron, setCron] = useState<CronJob[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const resets = usage?.session?.resetsAt;
  const since = resets ? resets - WINDOW : Date.now() - WINDOW;
  useEffect(() => {
    if (!tab) return;
    void call<ChatSpend[]>('stats:usage', since).then(setSpend);
    void call<CronJob[]>('stats:cron').then(setCron);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && set({ statsOpen: undefined });
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [tab, since]);
  if (!tab) return null;
  const close = () => set({ statsOpen: undefined });
  const total = spend?.reduce((a, c) => a + c.est, 0) ?? 0;
  const used = usage?.session?.percent;
  const share = (est: number) => (total ? (used !== undefined ? (est / total) * used : (est / total) * 100) : 0);
  const active = cron?.filter((j) => j.state === 'active').length ?? 0;
  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal stats-modal" onMouseDown={(e) => e.stopPropagation()}>
        <button className="icon-btn git-x" title="Закрыть (Esc)" onClick={close}>
          ×
        </button>
        <div className="seg">
          <button className={tab === 'spend' ? 'on' : ''} onClick={() => set({ statsOpen: 'spend' })}>
            📊 Расход за 5 часов
          </button>
          <button className={tab === 'cron' ? 'on' : ''} onClick={() => set({ statsOpen: 'cron' })}>
            ⏰ Крон-задачи {active ? <span className="count">{active}</span> : null}
          </button>
        </div>
        {tab === 'spend' && (
          <>
            <div className="muted small">
              Окно с {new Date(since).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
              {resets ? ` до ${new Date(resets).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : ''}
              {used !== undefined ? ` · использовано ${pct(used)} 5-часового лимита` : ''} · доля чата — по оценке стоимости токенов (Opus в 5 раз дороже Sonnet) · только открытые чаты
            </div>
            {!spend ? (
              <div className="muted">Считаю…</div>
            ) : !spend.length ? (
              <div className="empty">В этом окне открытые чаты ничего не тратили</div>
            ) : (
              <div className="stats-list">
                {spend.map((c) => (
                  <div key={c.id} className="stats-chat">
                    <div className="stats-row" onClick={() => setOpen(open === c.id ? null : c.id)}>
                      <span className="stats-bar">
                        <span style={{ width: `${Math.min(100, (c.est / (spend[0].est || 1)) * 100)}%` }} />
                      </span>
                      <b className="stats-title">{c.title}</b>
                      <span className="muted small">{c.cwd.split(/[\\/]/).pop()}</span>
                      <span className="grow" />
                      <span title="Доля 5-часового лимита (оценка)">{pct(share(c.est))}</span>
                      <span className="muted small" title="Токены: вход + выход + кэш">
                        {fmtTok(c.tokens.input + c.tokens.output + c.tokens.cacheRead + c.tokens.cacheWrite)} ток.
                      </span>
                      <span className="muted small" title="Оценка по ценам API">
                        ≈${c.est.toFixed(2)}
                      </span>
                    </div>
                    {open === c.id && (
                      <div className="stats-detail">
                        <div>
                          <b>Модели:</b>{' '}
                          {Object.entries(c.models)
                            .sort((a, b) => b[1] - a[1])
                            .map(([m, v]) => `${m} ${pct((v / c.est) * 100)}`)
                            .join(' · ')}
                        </div>
                        <div>
                          <b>Токены:</b> вход {fmtTok(c.tokens.input)} · выход {fmtTok(c.tokens.output)} · кэш чтение {fmtTok(c.tokens.cacheRead)} · кэш запись {fmtTok(c.tokens.cacheWrite)}
                        </div>
                        {Object.keys(c.tools).length > 0 && (
                          <div>
                            <b>Инструменты:</b>{' '}
                            {Object.entries(c.tools)
                              .sort((a, b) => b[1] - a[1])
                              .slice(0, 12)
                              .map(([n, k]) => `${n.replace(/^mcp__/, '')} ×${k}`)
                              .join(' · ')}
                          </div>
                        )}
                        <div>
                          <b>Самые дорогие ответы:</b>
                        </div>
                        {c.turns.map((t) => (
                          <div key={t.startedAt} className="stats-turn">
                            <span className="muted small">{formatTime(t.startedAt)}</span> <span>{t.prompt || '(без текста)'}</span>{' '}
                            <span className="muted small">
                              {pct(share(t.est))} · {fmtTok(t.tokens)} ток. · {t.tools} действий{t.model ? ` · ${t.model.replace(/^claude-/, '')}` : ''}
                            </span>
                          </div>
                        ))}
                        <button className="btn small" onClick={() => (close(), void openChat(c.id))}>
                          Открыть чат
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {tab === 'cron' && (
          <>
            <div className="muted small">Задачи по расписанию, которые чаты создали сами (CronCreate, /loop). Живут, пока работает процесс Claude этого чата, и не дольше 7 дней.</div>
            {!cron ? (
              <div className="muted">Загрузка…</div>
            ) : !cron.length ? (
              <div className="empty">В открытых чатах крон-задач нет</div>
            ) : (
              <div className="stats-list">
                {cron.map((j, i) => (
                  <div key={(j.id ?? '') + i} className={`cron-job ${j.state}`}>
                    <div className="stats-row">
                      <span className={`cron-state ${j.state}`}>{CRON_STATE[j.state]}</span>
                      <b>{j.human ?? j.cron ?? ''}</b>
                      {j.cron && <code className="muted small">{j.cron}</code>}
                      <span className="grow" />
                      <span className="path-link small" onClick={() => (close(), void openChat(j.chatId))}>
                        {j.chatTitle}
                      </span>
                    </div>
                    <div className="muted small cron-prompt">{j.prompt}</div>
                    <div className="muted small">
                      создана {formatTime(j.createdAt)}
                      {j.nextRun && j.state === 'active' ? ` · следующий запуск ${j.nextRun}` : ''}
                      {j.id ? ` · id ${j.id}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const CRON_STATE: Record<CronJob['state'], string> = { active: '● идёт', cancelled: 'отменена', expired: 'истекла (7 дней)', stopped: 'остановлена — процесс перезапускался', done: 'выполнена' };

const ECO_LABEL = { off: 'выкл', ask: 'спрашивать', block: 'только Sonnet' } as const;

/** 🪙 Economy mode in the top bar: off / ask before Opus·Fable / swap them for Sonnet. */
export function EconomyButton() {
  const mode = useStore((s) => s.app?.economy ?? 'off');
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        className={`tb-btn economy ${mode !== 'off' ? 'on' : ''}`}
        title={`Режим экономии: ${ECO_LABEL[mode]}\n«Спрашивать» — перед отправкой в Opus / Fable спросит, не отправить ли в Sonnet.\n«Только Sonnet» — дорогие модели заменяются на Sonnet при любой отправке (и при автопродолжении).`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 2 });
        }}
      >
        🪙 {mode === 'off' ? 'Эконом' : `Эконом: ${ECO_LABEL[mode]}`}
      </button>
      {menu && (
        <ContextMenu
          {...menu}
          onClose={() => setMenu(null)}
          items={(['off', 'ask', 'block'] as const).map((m) => ({ label: `${mode === m ? '● ' : '○ '}${m === 'off' ? 'Выключен' : m === 'ask' ? 'Спрашивать перед Opus / Fable' : 'Не давать: Opus / Fable → Sonnet'}`, action: () => saveApp({ economy: m }) }))}
        />
      )}
    </>
  );
}

/** Economy 'ask': the confirmation before a question goes to an expensive model. */
export function EconomyAsk() {
  const ask = useStore((s) => s.economyAsk);
  if (!ask) return null;
  const done = (r: 'sonnet' | 'keep' | 'cancel') => {
    set({ economyAsk: undefined });
    ask.resolve(r);
  };
  return (
    <div className="modal-bg" onMouseDown={() => done('cancel')}>
      <div className="modal" style={{ width: 'min(460px, 92vw)' }} onMouseDown={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>🪙 Режим экономии</h3>
        <p>
          Вопрос уйдёт в <b>{ask.model || 'модель по умолчанию (Opus)'}</b> — она тратит лимит примерно в 5 раз быстрее Sonnet.
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={() => done('cancel')}>
            Отмена
          </button>
          <button className="btn" onClick={() => done('keep')}>
            Всё равно в {ask.model || 'Opus'}
          </button>
          <button className="btn primary" autoFocus onClick={() => done('sonnet')}>
            Отправить в Sonnet
          </button>
        </div>
      </div>
    </div>
  );
}

/** Asks (economy 'ask') before an expensive model; returns the model to use, or null to cancel. */
export async function economyCheck(model: string | undefined): Promise<string | undefined | null> {
  const mode = get().app?.economy ?? 'off';
  if (mode !== 'ask' || (model && !/opus|fable/i.test(model))) return model;
  const r = await new Promise<'sonnet' | 'keep' | 'cancel'>((resolve) => set({ economyAsk: { model, resolve } }));
  return r === 'cancel' ? null : r === 'sonnet' ? 'sonnet' : model;
}
