import type { UsageWindow } from '../../shared/types';
import { call } from '../api';
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
      <span className="meter-val">{Math.round(100 - used)}%</span>
    </div>
  );
}

/**
 * Remaining claude.ai plan limits in the top bar: the current 5-hour session window and the week.
 * The bar fills with what is used; the number shows what is left. Hover for exact values and reset times.
 */
export function UsageMeters() {
  const u = useStore((s) => s.usage);
  if (!u?.available || (!u.session && !u.week)) return null;
  const checked = u.checkedAt ? `\nОбновлено: ${new Date(u.checkedAt).toLocaleTimeString('ru-RU')} (клик — обновить)` : '';
  const models = (u.models ?? []).map((m) => `\n  ${m.name}: использовано ${Math.round(m.percent)}%, ${untilText(m.resetsAt)}`).join('');
  const extra = u.extra ? `\nДоп. использование: ${u.extra.used ?? '?'} из ${u.extra.limit ?? '?'} ${u.extra.currency ?? ''}` : '';
  return (
    <div className="meters" onClick={async () => set({ usage: await call('usage:refresh') })}>
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
