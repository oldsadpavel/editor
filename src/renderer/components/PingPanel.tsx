import { useState } from 'react';
import type { PingResult } from '../../shared/types';
import { call } from '../api';
import { set, useStore } from '../store';
import { formatTime } from '../util';
import { PanelFrame } from './Panels';

const KIND_LABEL: Record<PingResult['kind'], string> = { http: 'HTTP', tcp: 'TCP', icmp: 'ping' };

function History({ h }: { h: PingResult['history'] }) {
  return (
    <span className="ping-hist" title="Последние проверки, новые справа">
      {h.map((x, i) => (
        <span key={i} className={x.ok ? 'up' : 'down'} title={`${new Date(x.at).toLocaleString('ru-RU')}${x.ms ? ` · ${x.ms} мс` : ''}`} />
      ))}
    </span>
  );
}

export function PingPanel() {
  const projects = useStore((s) => s.app!.projects);
  const results = useStore((s) => s.ping);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (project?: string) => {
    setBusy(project ?? '*');
    try {
      set({ ping: await call<PingResult[]>('ping:now', project) });
    } finally {
      setBusy(null);
    }
  };

  const withDomains = projects.filter((p) => p.domains?.length);
  const down = results.filter((r) => !r.ok).length;

  return (
    <PanelFrame
      id="ping"
      title={down ? `Пинг: не отвечает ${down}` : 'Пинг'}
      actions={
        <button className="btn small" disabled={!!busy} onClick={() => run()}>
          {busy === '*' ? 'Проверяю…' : '⟳ Проверить все'}
        </button>
      }
    >
      {projects.map((p) => {
        const list = (p.domains ?? []).map((d) => ({ d, r: results.find((x) => x.targetId === d.id) }));
        return (
          <div key={p.path} className="ping-project">
            <div className="trepo-head">
              <b>{p.name}</b>
              <span className="muted">{list.length ? `раз в ${p.pingMinutes ?? 5} мин` : 'домены не указаны'}</span>
              <div className="grow" />
              <button className="btn small" onClick={() => set({ projectSettings: p.path })}>
                ⚙ Домены
              </button>
              {list.length > 0 && (
                <button className="btn small" disabled={!!busy} onClick={() => run(p.path)}>
                  {busy === p.path ? '…' : '▶ Сейчас'}
                </button>
              )}
            </div>
            {list.map(({ d, r }) => (
              <div key={d.id} className={`ping-row ${!r ? '' : r.ok ? 'up' : 'down'}`}>
                <span className={`ping-dot ${!r ? '' : r.ok ? 'up' : 'down'}`} />
                <span className="ping-name">{d.name || d.target}</span>
                {d.name && <span className="muted ping-target">{d.target}</span>}
                <span className="chip">{r ? KIND_LABEL[r.kind] : '—'}</span>
                <span className={r && !r.ok ? 'bad' : 'muted'}>
                  {!r ? 'ещё не проверялся' : r.ok ? `${r.ms ?? '?'} мс${r.status ? ` · ${r.status}` : ''}` : r.detail ?? 'нет ответа'}
                </span>
                {r?.certDays !== undefined && (
                  <span className={r.certDays < 14 ? 'bad' : 'muted'} title="Срок SSL-сертификата">
                    🔒 {r.certDays} дн.
                  </span>
                )}
                <div className="grow" />
                {r && <History h={r.history} />}
                {r && <span className="muted small">{formatTime(r.at)}</span>}
              </div>
            ))}
          </div>
        );
      })}
      {!withDomains.length && (
        <div className="empty">
          Продакшен-домены задаются в настройках проекта (⚙ у проекта в дереве или кнопка «⚙ Домены»). Поддерживаются https://сайт (HTTP + срок SSL), host:port (TCP) и
          IP/хост (ping).
        </div>
      )}
    </PanelFrame>
  );
}
