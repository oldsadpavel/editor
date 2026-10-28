import { useEffect, useState } from 'react';
import type { DeployEvent, DeployTarget, PanelId, Problem, ProblemSource, SmokeTest } from '../../shared/types';
import { call } from '../api';
import { get, openChat, openFile, saveApp, setUi, toast, togglePanel, useStore, type Store } from '../store';
import { Help, basename, formatTime } from '../util';
import { CachePanel } from './CachePanel';
import { SetupPanel } from './SetupPanel';
import { PingPanel } from './PingPanel';

const PANEL_SOURCES: Record<string, ProblemSource[] | null> = {
  problems: null,
  keys: ['keys'],
  deploys: ['deploy'],
  tests: ['tests'],
  cache: ['cache'],
  ping: ['ping'],
};

/** Unread problems that belong to a panel; drives header/toolbar highlighting. */
export function panelAlerts(s: Store, panel: PanelId): number {
  if (panel === 'setup') return 0;
  const sources = PANEL_SOURCES[panel];
  if (sources === undefined) return 0;
  return s.problems.filter((p) => !p.acknowledged && (!sources || sources.includes(p.source))).length;
}

function ackPanel(panel: PanelId) {
  const sources = PANEL_SOURCES[panel];
  for (const p of get().problems) if (!p.acknowledged && (!sources || sources.includes(p.source))) void call('problems:ack', p.id);
}

export function PanelFrame({ id, title, children, actions }: { id: PanelId; title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  const alerts = useStore((s) => panelAlerts(s, id));
  const max = useStore((s) => !!s.app!.ui.bottomMax);
  const toggleMax = () => setUi({ bottomMax: !max });
  return (
    <div className={`panel bottom-panel ${alerts ? 'alerting' : ''}`}>
      <div className="panel-head" onDoubleClick={(e) => (e.target as HTMLElement).closest('button, input, select') || toggleMax()} title="Двойной клик — развернуть / вернуть">
        <span className="panel-title">{title}</span>
        {alerts > 0 && (
          <button className="alert-chip" title="Отметить прочитанным" onClick={() => ackPanel(id)}>
            {alerts} {alerts === 1 ? 'проблема' : 'проблем'} · прочитано ✓
          </button>
        )}
        <div className="grow" />
        {actions}
        <Help id={id} />
        <button className="icon-btn" title={max ? 'Вернуть обычный размер' : 'Развернуть на всю центральную часть'} onClick={toggleMax}>
          {max ? '⤡' : '⤢'}
        </button>
        <button className="icon-btn" title="Скрыть" onClick={() => togglePanel(id, false)}>
          ×
        </button>
      </div>
      <div className="panel-body">{children}</div>
    </div>
  );
}

// --- problems -----------------------------------------------------------------------------

const SOURCE_LABEL: Record<ProblemSource, string> = {
  chat: 'Чат',
  deploy: 'Деплой',
  keys: 'Ключи',
  auth: 'Claude',
  fs: 'Файлы',
  app: 'Редактор',
  tests: 'Тесты',
  cache: 'Кеш',
  ping: 'Пинг',
};

function ProblemRow({ p }: { p: Problem }) {
  const chatTitle = useStore((s) => (p.sessionId ? s.chats[p.sessionId]?.title : undefined));
  return (
    <div className={`problem ${p.severity} ${p.acknowledged ? 'read' : ''}`}>
      <span className="sev">{p.severity === 'error' ? '⛔' : '⚠'}</span>
      <div className="pmain">
        <div className="ptitle">
          <span className="src">{SOURCE_LABEL[p.source]}</span> {p.title}
        </div>
        {p.detail && <div className="pdetail">{p.detail}</div>}
        <div className="plinks">
          {p.sessionId && (
            <span className="path-link" onClick={() => openChat(p.sessionId!)}>
              💬 {chatTitle ?? 'открыть чат'}
            </span>
          )}
          {p.path && (
            <span className="path-link" onClick={() => openFile(p.path!)}>
              📄 {basename(p.path)}
            </span>
          )}
        </div>
      </div>
      <span className="ptime">{formatTime(p.at)}</span>
      <button className="icon-btn" title="Удалить" onClick={() => call('problems:remove', p.id)}>
        ×
      </button>
    </div>
  );
}

export function ProblemsPanel() {
  const problems = useStore((s) => s.problems);
  return (
    <PanelFrame
      id="problems"
      title="Ошибки"
      actions={
        problems.length > 0 && (
          <button className="btn small" onClick={() => confirm('Удалить все записи?') && call('problems:remove')}>
            Очистить
          </button>
        )
      }
    >
      {problems.map((p) => (
        <ProblemRow key={p.id} p={p} />
      ))}
      {!problems.length && <div className="empty ok">✓ Важных проблем нет</div>}
    </PanelFrame>
  );
}

// --- keys ---------------------------------------------------------------------------------

const KEY_STATUS: Record<string, string> = {
  expired: 'просрочен',
  expiring: 'истекает',
  valid: 'действует',
  invalid: 'недействителен',
  unknown: 'срок неизвестен',
};

export function KeysPanel() {
  const keys = useStore((s) => s.keys);
  const patterns = useStore((s) => s.app!.keyPatterns);
  const [draft, setDraft] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [showFiles, setShowFiles] = useState(false);

  const scan = async () => {
    setScanning(true);
    try {
      await call('keys:scan');
    } finally {
      setScanning(false);
    }
  };

  const order = { expired: 0, invalid: 1, expiring: 2, unknown: 3, valid: 4 };
  const list = [...(keys?.keys ?? [])].sort((a, b) => order[a.status] - order[b.status]);
  return (
    <PanelFrame
      id="keys"
      title="Ключи"
      actions={
        <button className="btn small" disabled={scanning} onClick={scan}>
          {scanning ? 'Сканирую…' : '⟳ Сканировать'}
        </button>
      }
    >
      <div className="keys-where">
        <div className="kw-head">
          <b>Где ищу:</b> {keys?.roots.length ?? 0} {keys?.roots.length === 1 ? 'проект' : 'проектов'}, файлов найдено:{' '}
          <span className="path-link" onClick={() => setShowFiles(!showFiles)}>
            {keys?.filesScanned.length ?? 0}
          </span>
          {keys && <span className="muted"> · проверено {formatTime(keys.scannedAt)}</span>}
          <button className="btn small" onClick={() => setDraft(draft === null ? patterns.join('\n') : null)}>
            {draft === null ? 'Шаблоны путей ✎' : 'Отмена'}
          </button>
        </div>
        {draft === null ? (
          <div className="patterns">
            {patterns.map((p) => (
              <code key={p}>{p}</code>
            ))}
          </div>
        ) : (
          <div className="pattern-edit">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={6} />
            <button
              className="btn primary small"
              onClick={async () => {
                const list = draft.split('\n').map((x) => x.trim()).filter(Boolean);
                await call('keys:setPatterns', list);
                await saveApp({ keyPatterns: list });
                setDraft(null);
                void scan();
              }}
            >
              Сохранить и пересканировать
            </button>
          </div>
        )}
        {showFiles && (
          <div className="scanned-files">
            {keys?.filesScanned.map((f) => (
              <div key={f} className="path-link" onClick={() => openFile(f)}>
                {f}
              </div>
            ))}
          </div>
        )}
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Статус</th>
            <th>Имя</th>
            <th>Тип</th>
            <th>Значение</th>
            <th>Истекает</th>
            <th>Где</th>
          </tr>
        </thead>
        <tbody>
          {list.map((k) => (
            <tr key={k.id} className={`k-${k.status}`}>
              <td>
                <span className={`chip ${k.status}`}>{KEY_STATUS[k.status]}</span>
              </td>
              <td>{k.name}</td>
              <td className="muted">{k.kind}</td>
              <td>
                <code>{k.masked}</code>
              </td>
              <td>{k.expiresAt ? new Date(k.expiresAt).toLocaleDateString('ru-RU') : <span className="muted">{k.note ?? '—'}</span>}</td>
              <td>
                <span className="path-link" onClick={() => openFile(k.file, k.line)} title={k.file}>
                  {basename(k.file)}:{k.line}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {keys && !list.length && <div className="empty">Ключей по шаблонам не найдено.</div>}
      {!keys && <div className="empty">Сканирование ещё не выполнялось.</div>}
    </PanelFrame>
  );
}

// --- deploys ------------------------------------------------------------------------------

const DEPLOY_STATE: Record<DeployEvent['state'], string> = {
  pushed: 'Запушено',
  building: 'Сборка / CI',
  deploying: 'Ждём сайт',
  live: 'На сайте',
  failed: 'Ошибка',
  stuck: 'Завис',
};

function Stage({ label, state, title }: { label: string; state: 'ok' | 'wait' | 'fail' | 'skip'; title?: string }) {
  return (
    <span className={`stage ${state}`} title={title}>
      {state === 'ok' ? '✓' : state === 'fail' ? '✕' : state === 'wait' ? <span className="spinner" /> : '–'} {label}
    </span>
  );
}

export function DeployCard({ d }: { d: DeployEvent }) {
  const chatTitle = useStore((s) => (d.sessionId ? s.chats[d.sessionId]?.title : undefined));
  const ci = d.ci?.state;
  const site = d.site?.state;
  const done = d.state === 'live' || d.state === 'failed' || d.state === 'stuck';
  return (
    <div className={`deploy ${d.state}`}>
      <div className="dhead">
        <span className={`chip ${d.state}`}>{DEPLOY_STATE[d.state]}</span>
        <b>{basename(d.repo)}</b>
        <span className="muted">
          {d.branch} @ <code>{d.sha.slice(0, 7)}</code>
        </span>
        <div className="grow" />
        <span className="muted">{formatTime(d.pushedAt)}</span>
      </div>
      <div className="stages">
        <Stage label="Push" state="ok" />
        <Stage
          label="CI"
          state={ci === 'success' ? 'ok' : ci === 'failure' ? 'fail' : ci === 'none' || !ci ? 'skip' : done ? 'fail' : 'wait'}
          title={d.ci?.detail}
        />
        <Stage
          label="Сайт"
          state={site === 'updated' ? 'ok' : site === 'none' || !site ? 'skip' : site === 'unreachable' && done ? 'fail' : done ? 'fail' : 'wait'}
          title={d.site?.detail}
        />
        <Stage
          label={d.tests ? `Тесты ${d.tests.passed}/${d.tests.passed + d.tests.failed}` : 'Тесты'}
          state={!d.tests ? 'skip' : d.tests.failed ? 'fail' : 'ok'}
        />
      </div>
      <div className="ddetail">
        {d.ci?.detail && (
          <div>
            CI: {d.ci.detail}{' '}
            {d.ci.url && (
              <a href={d.ci.url} target="_blank">
                GitHub ↗
              </a>
            )}
          </div>
        )}
        {d.checks && d.checks.length > 0 && (
          <div className="checks">
            {d.checks.map((c) => (
              <a key={c.name} className={`check ${c.state}`} href={c.url} target="_blank">
                {c.state === 'success' ? '✓' : c.state === 'failure' ? '✕' : '…'} {c.name}
              </a>
            ))}
          </div>
        )}
        {d.site && d.site.state !== 'none' && (
          <div>
            Сайт:{' '}
            <a href={d.site.url} target="_blank">
              {d.site.url}
            </a>{' '}
            — {d.site.state === 'updated' ? 'новая версия загружена' : d.site.state === 'unreachable' ? 'недоступен' : 'ждём новую версию'}
            {d.site.checkedAt && <span className="muted"> (проверено {formatTime(d.site.checkedAt)})</span>}
          </div>
        )}
        {d.site?.state === 'none' && <div className="muted">Сайт не привязан — укажите URL в настройках деплоя ниже, чтобы видеть, что версия реально выкатилась.</div>}
        {d.sessionId && (
          <span className="path-link" onClick={() => openChat(d.sessionId!)}>
            💬 {chatTitle ?? 'чат'}
          </span>
        )}
      </div>
    </div>
  );
}

function TargetEditor({ repo }: { repo: string }) {
  const target = useStore((s) => s.app!.deployTargets[repo.toLowerCase()]);
  const [url, setUrl] = useState(target?.url ?? '');
  const [mode, setMode] = useState<DeployTarget['mode']>(target?.mode ?? 'change');
  useEffect(() => {
    setUrl(target?.url ?? '');
    setMode(target?.mode ?? 'change');
  }, [target?.url, target?.mode]);
  const save = async () => {
    const t: DeployTarget = { url: url.trim(), mode, tests: target?.tests ?? [] };
    await call('deploys:setTarget', repo, t);
    await saveApp({ deployTargets: { ...get().app!.deployTargets, [repo.toLowerCase()]: t } });
    toast('Сохранено');
  };
  return (
    <div className="target-row">
      <span className="repo" title={repo}>
        {basename(repo)}
      </span>
      <input placeholder="https://сайт.ru — что должно обновиться после push" value={url} onChange={(e) => setUrl(e.target.value)} />
      <select value={mode} onChange={(e) => setMode(e.target.value as DeployTarget['mode'])}>
        <option value="change">изменение страницы</option>
        <option value="sha">хэш коммита на странице</option>
      </select>
      <button className="btn small" onClick={save}>
        Сохранить
      </button>
    </div>
  );
}

export function DeploysPanel() {
  const deploys = useStore((s) => s.deploys);
  const token = useStore((s) => s.app!.githubToken ?? '');
  const fromGit = useStore((s) => !!s.app!.githubFromGit);
  const [repos, setRepos] = useState<string[]>([]);
  const [settings, setSettings] = useState(false);
  useEffect(() => {
    if (settings) void call<string[]>('deploys:repos').then(setRepos);
  }, [settings]);
  return (
    <PanelFrame
      id="deploys"
      title="Деплои"
      actions={
        <button className={`btn small ${settings ? 'primary' : ''}`} onClick={() => setSettings(!settings)}>
          ⚙ Сайты и доступ
        </button>
      }
    >
      {settings && (
        <div className="deploy-settings">
          <div className="muted">Отслеживаемые репозитории ({repos.length}). Укажите сайт, который обновляется после push:</div>
          {repos.map((r) => (
            <TargetEditor key={r} repo={r} />
          ))}
          <div className="target-row">
            <span className="repo">GitHub токен</span>
            <input
              type="password"
              placeholder="нужен для приватных репозиториев (scope: repo / checks:read)"
              defaultValue={token}
              onBlur={(e) => saveApp({ githubToken: e.target.value.trim() || undefined })}
            />
          </div>
          <label className="check-row">
            <input type="checkbox" checked={fromGit} onChange={(e) => saveApp({ githubFromGit: e.target.checked })} />
            Если токен не указан — брать учётные данные github.com, которые уже сохранил git (Credential Manager). Используются только для запросов к api.github.com.
          </label>
        </div>
      )}
      {deploys.map((d) => (
        <DeployCard key={d.id} d={d} />
      ))}
      {!deploys.length && <div className="empty">Пушей пока не было. Редактор следит за репозиториями проектов и тех, где ИИ правил файлы.</div>}
    </PanelFrame>
  );
}

// --- tests --------------------------------------------------------------------------------

function NewTest({ repo, onDone }: { repo: string; onDone: () => void }) {
  const [t, setT] = useState<Partial<SmokeTest>>({ expectStatus: 200 });
  const save = async () => {
    if (!t.name || !t.url) return toast('Нужны имя и URL', 'error');
    const key = repo.toLowerCase();
    const target: DeployTarget = get().app!.deployTargets[key] ?? { url: '', mode: 'change', tests: [] };
    const next = { ...target, tests: [...target.tests, { ...(t as SmokeTest), id: crypto.randomUUID() }] };
    await call('deploys:setTarget', repo, next);
    await saveApp({ deployTargets: { ...get().app!.deployTargets, [key]: next } });
    onDone();
  };
  return (
    <div className="new-test">
      <input placeholder="Название" onChange={(e) => setT({ ...t, name: e.target.value })} />
      <input placeholder="https://…" onChange={(e) => setT({ ...t, url: e.target.value })} className="wide" />
      <input type="number" title="Ожидаемый код" value={t.expectStatus} onChange={(e) => setT({ ...t, expectStatus: Number(e.target.value) })} className="num" />
      <input placeholder="Текст в ответе" onChange={(e) => setT({ ...t, contains: e.target.value || undefined })} />
      <input type="number" placeholder="макс. мс" onChange={(e) => setT({ ...t, maxMs: Number(e.target.value) || undefined })} className="num" />
      <button className="btn primary small" onClick={save}>
        Добавить
      </button>
    </div>
  );
}

export function TestsPanel() {
  const targets = useStore((s) => s.app!.deployTargets);
  const results = useStore((s) => s.tests);
  const projects = useStore((s) => s.app!.projects);
  const [adding, setAdding] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const repos = [...new Set([...Object.keys(targets), ...projects.map((p) => p.path.toLowerCase())])];

  const remove = async (repo: string, id: string) => {
    const t = targets[repo];
    const next = { ...t, tests: t.tests.filter((x) => x.id !== id) };
    await call('deploys:setTarget', repo, next);
    await saveApp({ deployTargets: { ...targets, [repo]: next } });
  };

  return (
    <PanelFrame id="tests" title="Тесты">
      {repos.map((repo) => {
        const tests = targets[repo]?.tests ?? [];
        const name = projects.find((p) => p.path.toLowerCase() === repo)?.name ?? basename(repo);
        return (
          <div key={repo} className="test-repo">
            <div className="trepo-head">
              <b>{name}</b>
              <span className="muted">{tests.length} тестов</span>
              <div className="grow" />
              <button className="btn small" onClick={() => setAdding(adding === repo ? null : repo)}>
                ＋ Тест
              </button>
              <button
                className="btn small"
                disabled={!tests.length || running === repo}
                onClick={async () => {
                  setRunning(repo);
                  try {
                    await call('tests:run', repo);
                  } finally {
                    setRunning(null);
                  }
                }}
              >
                {running === repo ? 'Выполняю…' : '▶ Запустить'}
              </button>
            </div>
            {adding === repo && <NewTest repo={repo} onDone={() => setAdding(null)} />}
            {tests.map((t) => {
              const r = results.find((x) => x.testId === t.id);
              return (
                <div key={t.id} className={`test-row ${r ? (r.ok ? 'pass' : 'fail') : ''}`}>
                  <span className="tstate">{!r ? '○' : r.ok ? '✓' : '✕'}</span>
                  <span className="tname">{t.name}</span>
                  <a className="turl" href={t.url} target="_blank">
                    {t.url}
                  </a>
                  <span className="muted">
                    ждём {t.expectStatus}
                    {t.contains ? ` + «${t.contains}»` : ''}
                    {t.maxMs ? ` ≤ ${t.maxMs} мс` : ''}
                  </span>
                  {r && (
                    <span className={r.ok ? 'ok' : 'bad'}>
                      {r.status ?? '—'} · {r.ms} мс {r.detail ? `· ${r.detail}` : ''} · {formatTime(r.at)}
                    </span>
                  )}
                  <button className="icon-btn" title="Удалить тест" onClick={() => remove(repo, t.id)}>
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        );
      })}
      {!repos.length && <div className="empty">Добавьте проект — для него можно будет завести тесты.</div>}
    </PanelFrame>
  );
}

export const BOTTOM_PANELS: { id: PanelId; C: () => React.ReactElement }[] = [
  { id: 'setup', C: SetupPanel },
  { id: 'ping', C: PingPanel },
  { id: 'problems', C: ProblemsPanel },
  { id: 'deploys', C: DeploysPanel },
  { id: 'tests', C: TestsPanel },
  { id: 'keys', C: KeysPanel },
  { id: 'cache', C: CachePanel },
];

