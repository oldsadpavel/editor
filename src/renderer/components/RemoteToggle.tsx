import { useEffect, useState } from 'react';
import type { MainEvent, RemoteLinkStatus } from '../../shared/types';
import { bridge, call } from '../api';
import { toast } from '../store';

/**
 * 📱 The phone switch in the top bar: allows MPI Remote (Android, through Insider) to control this editor. Unchecked —
 * the link is cut completely: no socket, nothing from the phone is accepted.
 */
export function RemoteToggle() {
  const [st, setSt] = useState<RemoteLinkStatus | null>(null);
  useEffect(() => {
    void call<RemoteLinkStatus>('remote:status').then(setSt);
    return bridge.on((e: MainEvent) => e.type === 'remoteLink' && setSt(e.status));
  }, []);
  if (!st) return null;
  const phones = st.phones.length;
  const cls = !st.enabled ? '' : st.state === 'online' ? (phones ? 'phone' : 'online') : st.state === 'error' ? 'error' : 'connecting';
  const title = !st.enabled
    ? 'Управление с телефона выключено — доступа к компьютеру нет.\nВключить: приложение MPI Remote сможет работать с чатами и файлами проектов (вход тем же аккаунтом Insider).'
    : st.state === 'online'
      ? `Телефон может подключиться.${phones ? '\nСейчас: ' + st.phones.map((p) => p.name).join(', ') : ''}\nСнять галочку — сразу отрезать доступ.`
      : st.state === 'error'
        ? `Нет связи: ${st.error ?? ''}\nПовторяю автоматически. Снять галочку — выключить.`
        : 'Подключаюсь к Insider…';
  return (
    <label className={`tb-btn remote-toggle ${cls}`} title={title}>
      <input
        type="checkbox"
        checked={st.enabled}
        onChange={(e) => {
          const on = e.target.checked;
          setSt({ ...st, enabled: on, state: on ? 'connecting' : 'off', phones: on ? st.phones : [] });
          call('remote:set', on).catch((err) => toast(err.message, 'error'));
        }}
      />
      📱 Телефон{st.enabled && phones ? ` · ${phones}` : ''}
    </label>
  );
}
