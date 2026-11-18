import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../renderer/styles.css';
import './mobile.css';
import { finishLogin, logout, signedIn, startLogin, who } from './auth';
import { onLink, start, type LinkState } from './ws-bridge';

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
        <span className="m-pc">{link.pc ? link.pc.name : link.state === 'connecting' ? 'Подключение…' : 'Нет связи'}</span>
        <span className="grow" />
        <button className="icon-btn" title={`Выйти${me?.email ? ' (' + me.email + ')' : ''}`} onClick={onLogout}>
          ⎋
        </button>
      </div>
      {link.state !== 'online' && link.error && <div className="m-banner">{link.error}</div>}
      {Main ? <Main /> : <div className="m-wait muted">{link.state === 'online' ? 'Загружаю…' : 'Жду компьютер…'}</div>}
    </div>
  );
}

export function mount() {
  createRoot(document.getElementById('root')!).render(<Root />);
}
