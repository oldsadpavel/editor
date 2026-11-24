import { useEffect, useState } from 'react';
import type { UsageWindow } from '../../shared/types';
import { call } from '../api';

type OrBalance = { remaining?: number; credits?: number; usage?: number; keyRemaining?: number | null; keyLimit?: number | null; error?: string } | null;

/**
 * Instead of the claude.ai meters while the active chat is on OpenRouter: how much money is left there. Refreshed when
 * the tab switches to such a chat, after each of its answers and every 2 minutes; click — refresh and open ⚙ OpenRouter.
 */
function OpenRouterBalance() {
  const [b, setB] = useState<OrBalance | undefined>(undefined);
  const active = useStore((s) => s.app?.activeChat);
  const done = useStore((s) => (s.app?.activeChat ? s.app.chatMeta[s.app.activeChat]?.completedAt : undefined));
  const load = () => void call<OrBalance>('openrouter:balance').then(setB, () => setB({ error: 'нет связи' }));
  useEffect(load, [active, done]);
  useEffect(() => {
    const t = setInterval(load, 120_000);
    return () => clearInterval(t);
  }, []);
  const left = b?.keyRemaining ?? b?.remaining;
  const money = (x?: number | null) => (typeof x === 'number' ? `$${x.toFixed(2)}` : '?');
  const low = typeof left === 'number' && left < 2;
  const tip =
    b === undefined
      ? 'Загружаю…'
      : b === null
        ? 'Нет ключа OpenRouter — «⚙ OpenRouter…» в списке моделей'
        : b.error
          ? `OpenRouter: ${b.error}`
          : `OpenRouter — активный чат отвечает через него\nНа счёте: ${money(b.remaining)} (пополнено ${money(b.credits)}, потрачено ${money(b.usage)})${b.keyLimit ? `\nЛимит ключа: ${money(b.keyLimit)}, осталось ${money(b.keyRemaining)}` : ''}\nКлик — обновить и открыть настройки OpenRouter`;
  return (
    <div className={`meters or-balance ${low ? 'bad' : ''}`} title={tip} onClick={() => (load(), set({ showOpenRouter: true }))}>
      <span className="meter-label">OpenRouter</span>
      <span className="meter-val">{b === undefined ? '…' : b === null ? 'нет ключа' : b.error ? '⚠' : `${money(left)} осталось`}</span>
    </div>
  );
}
import { set, useStore } from '../store';

function untilText(ms?: number) {
  if (!ms) return 'время сброса неизвестно';
  const left = ms - Date.now();
  if (left <= 0) return 'сбрасывается сейчас';
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  const d = Math.floor(h / 24);
  const when = new Date(ms).toLocaleString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `сброс через ${d ? `${d} д ${h % 24} ч` : h ? `${h} ч ${m} мин` : `${m} мин`} (${when})`;
}

function Meter({ label, w, tip }: { label: string; w: UsageWindow; tip: string }) {
  const used = Math.max(0, Math.min(100, w.percent));
  const level = used >= 90 ? 'bad' : used >= 70 ? 'warn' : '';
  return (
    <div className={`meter ${level}`} title={tip}>
      <span className="meter-label">{label}</span>
      <span className="meter-bar">
        <span className="meter-fill" style={{ width: `${used}%` }} />
      </span>
      <span className="meter-val">{Math.round(used)}%</span>
    </div>
  );
}

/**
 * claude.ai plan limits in the top bar: the current 5-hour session window and the week.
 * The bar and the number show how much is used. Hover for exact values, what is left and reset times.
 */
export function UsageMeters() {
  const u = useStore((s) => s.usage);
  // the active chat answers through OpenRouter: its money matters, not the claude.ai limits
  const orChat = useStore((s) => {
    const id = s.app?.activeChat;
    return id ? !!s.chats[id]?.model?.startsWith('or:') : false;
  });
  if (orChat) return <OpenRouterBalance />;
  if (!u?.available || (!u.session && !u.week)) return null;
  const checked = u.checkedAt ? `\nОбновлено: ${new Date(u.checkedAt).toLocaleTimeString('ru-RU')} (клик — расход по чатам)` : '';
  const models = (u.models ?? []).map((m) => `\n  ${m.name}: использовано ${Math.round(m.percent)}%, ${untilText(m.resetsAt)}`).join('');
  const extra = u.extra ? `\nДоп. использование: ${u.extra.used ?? '?'} из ${u.extra.limit ?? '?'} ${u.extra.currency ?? ''}` : '';
  return (
    <div
      className="meters"
      onClick={async () => {
        set({ statsOpen: 'spend' });
        set({ usage: await call('usage:refresh') });
      }}
    >
      {u.session && (
        <Meter
          label="Сессия"
          w={u.session}
          tip={`Лимит текущей 5-часовой сессии${u.plan ? ` (план ${u.plan})` : ''}\nИспользовано: ${u.session.percent.toFixed(1)}%\nОсталось: ${(100 - u.session.percent).toFixed(1)}%\n${untilText(u.session.resetsAt)}${checked}`}
        />
      )}
      {u.week && (
        <Meter
          label="Неделя"
          w={u.week}
          tip={`Недельный лимит${u.plan ? ` (план ${u.plan})` : ''}\nИспользовано: ${u.week.percent.toFixed(1)}%\nОсталось: ${(100 - u.week.percent).toFixed(1)}%\n${untilText(u.week.resetsAt)}${models ? `\nПо моделям:${models}` : ''}${extra}${checked}`}
        />
      )}
    </div>
  );
}
