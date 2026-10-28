import { useEffect, useState } from 'react';
import type { CloudVersion } from '../../shared/types';
import { call } from '../api';
import { set, toast, useStore } from '../store';
import { formatTime } from '../util';

const INSIDER = 'https://parts.mrkt.ru';

const kb = (n: number) => (n < 1024 ? `${n} Б` : `${(n / 1024).toFixed(1)} КБ`);

/**
 * Cloud settings storage: sign in (Insider via Microsoft 365, or your own server from server/), automatic upload,
 * the last 10 versions with apply/delete. On a new machine it asks which way to sync first.
 */
export function CloudModal() {
  const open = useStore((s) => s.showCloud);
  const st = useStore((s) => s.cloud);
  const [server, setServer] = useState(st?.server ?? INSIDER);
  const [own, setOwn] = useState(!!st && st.server.replace(/\/+$/, '') !== INSIDER);
  const [list, setList] = useState<CloudVersion[] | null>(null);
  const [err, setErr] = useState<string>();

  useEffect(() => {
    if (st?.server) {
      setServer(st.server);
      setOwn(st.server.replace(/\/+$/, '') !== INSIDER);
    }
  }, [st?.server]);

  const reload = () =>
    call<CloudVersion[]>('cloud:versions').then(
      (v) => (setList(v), setErr(undefined)),
      (e) => setErr(e.message),
    );
  useEffect(() => {
    if (open && st?.signedIn) void reload();
  }, [open, st?.signedIn, st?.lastSyncAt]);

  if (!open || !st) return null;
  const close = () => set({ showCloud: false });
  const run = async <T,>(channel: string, ...args: unknown[]) => {
    try {
      return await call<T>(channel, ...args);
    } catch (e) {
      toast((e as Error).message, 'error');
      return null;
    }
  };

  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal cloud-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>☁ Облако настроек</b>
          <div className="grow" />
          <button className="icon-btn" onClick={close}>
            ×
          </button>
        </div>
        <p className="muted">
          Проекты, группы, избранное, домены, деплой, тесты, ключи, раскладка и умолчания чатов хранятся онлайн — на другом компьютере достаточно войти.
          Хранятся последние 10 версий. Открытые вкладки, черновики, токены и отметки прочитанного остаются на этом компьютере.
        </p>

        <div className="cloud-row">
          <label>
            <input type="radio" checked={!own} disabled={st.signedIn} onChange={() => (setOwn(false), setServer(INSIDER))} /> Insider (вход через Microsoft 365)
          </label>
          <label>
            <input type="radio" checked={own} disabled={st.signedIn} onChange={() => setOwn(true)} /> Свой сервер
          </label>
          {own && (
            <input
              className="cloud-url"
              placeholder="https://config.example.com"
              value={server === INSIDER ? '' : server}
              disabled={st.signedIn}
              onChange={(e) => setServer(e.target.value)}
            />
          )}
        </div>
        {own && !st.signedIn && (
          <div className="muted small">
            Свой сервер — папка <code>server/</code> в репозитории редактора (Node без зависимостей, вход через любой OIDC: Microsoft, Google…). Инструкция — в
            её README.
          </div>
        )}

        <div className="cloud-account">
          {st.signedIn ? (
            <>
              <span className="chip valid">✓ {st.name || st.email}</span>
              <span className="muted">{st.email}</span>
              <span className="muted">· {st.server}</span>
              <div className="grow" />
              <button className="btn small" onClick={() => void run('cloud:logout')}>
                Выйти
              </button>
            </>
          ) : (
            <>
              <span className="muted">Не выполнен вход</span>
              <div className="grow" />
              <button className="btn primary" disabled={!!st.busy || (own && !server.trim())} onClick={() => void run('cloud:login', own ? server : INSIDER)}>
                {st.busy ?? 'Войти через браузер'}
              </button>
            </>
          )}
        </div>
        {st.busy && st.signedIn && (
          <div className="muted">
            <span className="spinner" /> {st.busy}
          </div>
        )}
        {st.lastError && <div className="turn-error">{st.lastError}</div>}

        {st.signedIn && st.needsChoice && (
          <div className="cloud-choice">
            <b>В облаке уже есть настройки</b>
            {st.remote && (
              <span className="muted">
                {' '}
                — от {st.remote.created_at ? formatTime(Date.parse(st.remote.created_at)) : '?'}
                {st.remote.device ? `, ${st.remote.device}` : ''}
              </span>
            )}
            <div>Этот компьютер ещё не синхронизировался. Что сделать?</div>
            <div className="cloud-actions">
              <button
                className="btn primary"
                onClick={() => confirm('Заменить настройки этого компьютера настройками из облака? Открытые вкладки и чаты останутся.') && void run('cloud:download')}
              >
                ⇩ Взять из облака
              </button>
              <button className="btn" onClick={() => void run('cloud:upload')}>
                ⇪ Отправить мои (станут новой версией)
              </button>
            </div>
          </div>
        )}

        {st.signedIn && !st.needsChoice && (
          <>
            <div className="cloud-actions">
              <label title="Через ~20 секунд после изменения настроек — новая версия в облаке">
                <input type="checkbox" checked={st.auto} onChange={(e) => void run('cloud:options', { auto: e.target.checked })} /> Сохранять автоматически
              </label>
              <div className="grow" />
              <span className="muted">{st.lastSyncAt ? `синхронизировано ${formatTime(st.lastSyncAt)}` : 'ещё не синхронизировано'}</span>
              <button className="btn small" disabled={!!st.busy} onClick={() => void run('cloud:upload')}>
                ⇪ Сохранить сейчас
              </button>
              <button
                className="btn small"
                disabled={!!st.busy}
                onClick={() => confirm('Заменить настройки этого компьютера последней версией из облака?') && void run('cloud:download')}
              >
                ⇩ Загрузить последнюю
              </button>
            </div>
            <div className="st-sub">Версии в облаке</div>
            {err && <div className="turn-error">{err}</div>}
            {!list && !err && <div className="muted">Загрузка…</div>}
            {list && !list.length && <div className="muted">Пока пусто</div>}
            {list?.map((v, i) => (
              <div key={v.id} className="cloud-version">
                <span>{v.created_at ? formatTime(Date.parse(v.created_at)) : '—'}</span>
                <span className="muted">{v.device ?? ''}</span>
                <span className="muted">{kb(v.size)}</span>
                {i === 0 && <span className="chip valid">последняя</span>}
                <div className="grow" />
                <button
                  className="btn small"
                  onClick={() => confirm('Применить эту версию настроек? Текущие настройки станут такими, как в ней.') && void run('cloud:download', v.id)}
                >
                  Применить
                </button>
                <button
                  className="btn small danger"
                  onClick={async () => {
                    if (!confirm('Удалить эту версию из облака?')) return;
                    const r = await run<CloudVersion[]>('cloud:delete', v.id);
                    if (r) setList(r);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
