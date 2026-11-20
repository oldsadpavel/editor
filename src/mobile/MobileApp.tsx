import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../renderer/styles.css';
import './mobile.css';
import { finishLogin, logout, signedIn, startLogin, who } from './auth';
import { log, setAppVersion, startLogging } from './log';
import { check, currentBuild, install, type Available } from './update';
import { onLink, resync, start, type LinkState } from './ws-bridge';

/** MPI Remote: sign-in → connection to the PC → the editor's own chats / tree / editor, one screen at a time. */
function Root() {
  const [authed, setAuthed] = useState(signedIn());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const done = (url: string) => {
      setBusy(true);
      finishLogin(url)
        .then(() => setAuthed(true))
        .catch((e) => setErr(e.message))
        .finally(() => setBusy(false));
    };
    // web build / test: the code comes back in the query
    if (/[?&]code=/.test(location.search)) {
      const url = location.href;
      history.replaceState(null, '', location.pathname);
      done(url);
    }
    const cap = (window as any).Capacitor;
    if (cap?.isNativePlatform?.()) {
      void import('@capacitor/app').then(({ App }) => {
        void App.addListener('appUrlOpen', ({ url }) => {
          if (!url.startsWith('mpiremote://callback')) return;
          void import('@capacitor/browser').then(({ Browser }) => Browser.close().catch(() => {}));
          done(url);
        });
      });
    }
  }, []);

  if (!authed)
    return (
      <div className="m-login">
        <div className="m-logo">MPI</div>
        <div className="muted">Управление редактором на компьютере</div>
        <button
          className="btn primary"
          disabled={busy}
          onClick={() => {
            setErr(null);
            setBusy(true);
            startLogin()
              .catch((e) => setErr(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Вход…' : 'Войти через Microsoft 365'}
        </button>
        <div className="muted small">Тот же аккаунт Insider, что в редакторе. На компьютере должна стоять галочка «📱 Телефон».</div>
        {err && <div className="m-err">{err}</div>}
      </div>
    );
  return <Connected onLogout={() => (logout(), location.reload())} />;
}

let started = false;
function Connected({ onLogout }: { onLogout: () => void }) {
  const [link, setLink] = useState<LinkState>({ state: 'connecting' });
  const [Main, setMain] = useState<null | (() => React.JSX.Element)>(null);
  useEffect(() => {
    if (!started) {
      started = true;
      start();
    }
    return onLink(setLink);
  }, []);
  // the editor UI is loaded (and its store initialised) once the PC answered the first time
  useEffect(() => {
    if (link.state !== 'online' || Main) return;
    void import('./MobileMain').then((m) => m.initMain().then(() => setMain(() => m.MobileMain)));
  }, [link.state, Main]);
  const me = who();
  return (
    <div className="m-app">
      <div className="m-head">
        <span className={`m-dot ${link.state}`} />
        <span className="m-pc" title="Нажмите — заново загрузить открытые чаты с компьютера" onClick={() => void resync()}>{link.pc ? link.pc.name : link.state === 'connecting' ? 'Подключение…' : 'Нет связи'}</span>
        <span className="grow" />
        <UpdateButton />
        <button className="icon-btn" title={`Выйти${me?.email ? ' (' + me.email + ')' : ''}`} onClick={onLogout}>
          ⎋
        </button>
      </div>
      {link.state !== 'online' && link.error && <div className="m-banner">{link.error}</div>}
      {Main ? <Main /> : <div className="m-wait muted">{link.state === 'online' ? 'Загружаю…' : 'Жду компьютер…'}</div>}
    </div>
  );
}

/** ⟳ — checks GitHub for a newer APK; found — downloads it and opens the installer. Checked by itself too. */
function UpdateButton() {
  const [avail, setAvail] = useState<Available | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mine, setMine] = useState('');
  useEffect(() => {
    void currentBuild().then((c) => setMine(c.build ? `${c.version} (b${c.build})` : c.version));
    const look = () => void check().then(setAvail).catch(() => {});
    look();
    const t = setInterval(look, 3 * 3600_000);
    return () => clearInterval(t);
  }, []);
  const run = async () => {
    setBusy('Проверяю…');
    try {
      const a = avail ?? (await check());
      if (!a) {
        setBusy('Установлена последняя версия');
        setTimeout(() => setBusy(null), 2500);
        return;
      }
      setAvail(a);
      setBusy(`Скачиваю b${a.build} (${(a.size / 1048576).toFixed(1)} МБ)…`);
      const r = await install(a);
      setBusy(r === 'permission' ? 'Разрешите установку из этого приложения и нажмите «Обновить» ещё раз' : 'Открыл установку');
      setTimeout(() => setBusy(null), r === 'permission' ? 8000 : 4000);
    } catch (e: any) {
      setBusy('Ошибка: ' + (e?.message ?? e));
      setTimeout(() => setBusy(null), 6000);
    }
  };
  return (
    <>
      <button className={`m-upd ${avail ? 'new' : ''}`} title={`Версия ${mine}`} onClick={() => void run()}>
        {avail ? `⬆ b${avail.build}` : '⟳'}
      </button>
      {busy && <div className="m-upd-note">{busy}</div>}
    </>
  );
}

export function mount() {
  startLogging();
  void currentBuild().then((c) => setAppVersion(`${c.version} b${c.build}`));
  // the editor's error toasts are logged too
  (window as any).__mpiLog = (text: string) => log('error', 'Сообщение: ' + text);
  createRoot(document.getElementById('root')!).render(<Root />);
}
