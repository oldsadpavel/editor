import { useEffect, useState } from 'react';
import { call } from '../api';
import { set, useStore } from '../store';
import { formatTime } from '../util';

interface Status {
  sessionId: string;
  title: string;
  cwd: string;
  status: string;
  processRunning: boolean;
  model: string | null;
  modelChoice: string | null;
  effort: string | null;
  permissionMode: string | null;
  autoApprove: boolean;
  remote: boolean;
  version: string | null;
  outputStyle: string | null;
  tools: number | null;
  mcp: { name: string; status: string }[];
  context: { used: number; max: number; percent: number; categories: { name: string; tokens: number }[] } | null;
  account: { loggedIn: boolean; email?: string; method?: string; orgName?: string };
  turns: number;
  usage: { session?: { percent: number; resetsAt?: number }; week?: { percent: number; resetsAt?: number }; plan?: string } | null;
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="st-row">
      <span className="st-label">{label}</span>
      <span className="st-val">{children}</span>
    </div>
  );
}

/** /status and /context of a chat: session, model, permissions, MCP servers, context window, plan limits. */
export function StatusModal() {
  const target = useStore((s) => s.statusFor);
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState<string>();

  useEffect(() => {
    setSt(null);
    setErr(undefined);
    if (target) call<Status>('chat:status', target.sessionId).then(setSt, (e) => setErr(e.message));
  }, [target?.sessionId]);

  if (!target) return null;
  const close = () => set({ statusFor: undefined });
  const onlyContext = target.section === 'context';
  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal status-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{onlyContext ? '/context' : '/status'}</b>
          <span className="muted" style={{ marginLeft: 8 }}>
            {st?.title}
          </span>
          <div className="grow" />
          <button className="icon-btn" onClick={close}>
            ×
          </button>
        </div>
        {err && <div className="turn-error">{err}</div>}
        {!st && !err && (
          <div className="empty">
            <span className="spinner" /> Собираю данные…
          </div>
        )}
        {st && !onlyContext && (
          <div className="st-grid">
            <Row label="Сессия">
              <code>{st.sessionId}</code>
            </Row>
            <Row label="Папка">{st.cwd}</Row>
            <Row label="Состояние">
              {st.status}
              {st.processRunning ? ' · процесс Claude запущен' : ' · процесс запустится со следующим вопросом'}
            </Row>
            <Row label="Модель">
              {st.model ?? 'по умолчанию'}
              {st.modelChoice && st.model !== st.modelChoice ? ` (выбрано: ${st.modelChoice})` : ''}
            </Row>
            <Row label="Качество (effort)">{st.effort ?? 'по умолчанию'}</Row>
            <Row label="Режим разрешений">
              {st.permissionMode ?? 'из настроек'}
              {st.autoApprove ? ' · ⚡ автоодобрение' : ''}
            </Row>
            <Row label="Удалённое управление">{st.remote ? '📱 включено (claude.ai/code и приложение Claude)' : 'выключено'}</Row>
            <Row label="Аккаунт">{st.account.loggedIn ? `${st.account.email} · ${st.account.orgName ?? ''} · ${st.account.method ?? ''}` : 'не выполнен вход'}</Row>
            <Row label="Claude Code">{st.version ?? '—'}</Row>
            {st.tools !== null && <Row label="Инструментов">{st.tools}</Row>}
            <Row label="MCP-серверы">
              {st.mcp.length
                ? st.mcp.map((m) => (
                    <span key={m.name} className={`chip ${m.status === 'connected' ? 'valid' : m.status === 'failed' ? 'expired' : ''}`} style={{ marginRight: 4 }}>
                      {m.name}: {m.status}
                    </span>
                  ))
                : 'нет данных (появятся, когда процесс запущен)'}
            </Row>
            <Row label="Вопросов в чате">{st.turns}</Row>
            {st.usage?.session && (
              <Row label="Лимит сессии">
                использовано {st.usage.session.percent.toFixed(1)}%{st.usage.session.resetsAt ? `, сброс ${formatTime(st.usage.session.resetsAt)}` : ''}
              </Row>
            )}
            {st.usage?.week && (
              <Row label="Лимит недели">
                использовано {st.usage.week.percent.toFixed(1)}%{st.usage.week.resetsAt ? `, сброс ${formatTime(st.usage.week.resetsAt)}` : ''}
              </Row>
            )}
          </div>
        )}
        {st && (
          <div className="st-context">
            <div className="st-sub">Контекст</div>
            {st.context ? (
              <>
                <div className="st-bar">
                  <span style={{ width: `${Math.min(100, st.context.percent)}%` }} />
                </div>
                <div className="muted">
                  {k(st.context.used)} из {k(st.context.max)} токенов ({st.context.percent.toFixed(0)}%)
                </div>
                {st.context.categories.map((c) => (
                  <Row key={c.name} label={c.name}>
                    {k(c.tokens)}
                  </Row>
                ))}
              </>
            ) : (
              <div className="muted">Нет данных: процесс Claude для этого чата сейчас не запущен — задайте вопрос, и данные появятся.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
