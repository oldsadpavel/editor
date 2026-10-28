import { useState } from 'react';
import type { DeployTarget, ProdTarget, ProjectRef } from '../../shared/types';
import { call } from '../api';
import { get, saveApp, set, toast, useStore } from '../store';

/** Modal with per-project settings: name, production domains for Ping, ping interval, deploy site. */
export function ProjectSettings() {
  const path = useStore((s) => s.projectSettings);
  const project = useStore((s) => s.app!.projects.find((p) => p.path === path));
  if (!path || !project) return null;
  return <Form key={path} project={project} />;
}

function Form({ project }: { project: ProjectRef }) {
  const targets = useStore((s) => s.app!.deployTargets);
  const existingSite = targets[project.path.toLowerCase()];
  const [name, setName] = useState(project.name);
  const [domains, setDomains] = useState<ProdTarget[]>(project.domains ?? []);
  const [minutes, setMinutes] = useState(project.pingMinutes ?? 5);
  const [site, setSite] = useState(existingSite?.url ?? '');
  const [mode, setMode] = useState<DeployTarget['mode']>(existingSite?.mode ?? 'change');
  const [draft, setDraft] = useState('');
  const close = () => set({ projectSettings: undefined });

  // A bare domain is most useful as an HTTPS check (status + certificate).
  const normalize = (raw: string) => {
    const t = raw.trim();
    return /^[\w.-]+\.[a-z]{2,}$/i.test(t) ? 'https://' + t : t;
  };
  const sameTarget = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

  const add = () => {
    const t = normalize(draft);
    if (!t) return;
    setDomains([...domains, { id: crypto.randomUUID(), target: t }]);
    setDraft('');
  };

  const save = async () => {
    // Text left in the "add" field counts as added, and the deploy site is always pinged too.
    let list = domains.filter((d) => d.target.trim());
    for (const extra of [normalize(draft), site.trim()]) {
      if (extra && !list.some((d) => sameTarget(d.target, extra))) list = [...list, { id: crypto.randomUUID(), target: extra }];
    }
    const projects = get().app!.projects.map((p) => (p.path === project.path ? { ...p, name: name.trim() || p.name, domains: list, pingMinutes: minutes } : p));
    await saveApp({ projects });
    if (site.trim() !== (existingSite?.url ?? '') || mode !== existingSite?.mode) {
      const t: DeployTarget = { url: site.trim(), mode, tests: existingSite?.tests ?? [] };
      const root = await call<string>('deploys:setTarget', project.path, site.trim() ? t : null);
      const next = { ...get().app!.deployTargets };
      if (site.trim()) next[root.toLowerCase()] = t;
      else delete next[root.toLowerCase()];
      await saveApp({ deployTargets: next });
    }
    close();
    toast('Настройки проекта сохранены');
    if (list.length) set({ ping: await call('ping:now', project.path) });
  };

  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal project-settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Настройки проекта</b>
          <span className="muted" style={{ marginLeft: 8 }}>
            {project.path}
          </span>
          <div className="grow" />
          <button className="icon-btn" onClick={close}>
            ×
          </button>
        </div>

        <label className="field">
          <span>Название</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <div className="field">
          <span>Продакшен-домены и серверы (блок «Пинг»)</span>
          <div className="muted small">https://сайт.ru — HTTP-ответ и срок SSL · host:port — TCP-порт (например db.site.ru:5432) · IP или хост — ping</div>
          {domains.map((d, i) => (
            <div key={d.id} className="domain-row">
              <input
                value={d.target}
                onChange={(e) => setDomains(domains.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))}
                placeholder="https://site.ru"
              />
              <input
                className="dname"
                value={d.name ?? ''}
                onChange={(e) => setDomains(domains.map((x, j) => (j === i ? { ...x, name: e.target.value || undefined } : x)))}
                placeholder="Название (необязательно)"
              />
              <button className="icon-btn" title="Удалить" onClick={() => setDomains(domains.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          <div className="domain-row">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder="Добавить: site.ru, https://api.site.ru/health, 10.0.0.5, db.site.ru:5432"
              autoFocus
            />
            <button className="btn small" disabled={!draft.trim()} onClick={add}>
              ＋ Добавить
            </button>
          </div>
        </div>

        <label className="field inline">
          <span>Проверять каждые</span>
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {[1, 2, 5, 10, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m} мин
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span>Сайт, который обновляется после git push (блок «Деплои»)</span>
          <div className="domain-row">
            <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://site.ru" list="project-domains" />
            <datalist id="project-domains">
              {domains.filter((d) => /^https?:/.test(d.target)).map((d) => (
                <option key={d.id} value={d.target} />
              ))}
            </datalist>
            <select value={mode} onChange={(e) => setMode(e.target.value as DeployTarget['mode'])}>
              <option value="change">изменение страницы</option>
              <option value="sha">хэш коммита на странице</option>
            </select>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={close}>
            Отмена
          </button>
          <button className="btn primary" onClick={save}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}
