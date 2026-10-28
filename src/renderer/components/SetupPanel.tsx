import { useEffect, useState } from 'react';
import type { DeployTarget, SetupAction, SetupItem } from '../../shared/types';
import { call } from '../api';
import { addProjects, get, refreshSetup, saveApp, set, toast, togglePanel, useStore } from '../store';
import { MODES } from './ChatView';
import { PanelFrame } from './Panels';

async function saveTarget(repo: string, patch: Partial<DeployTarget>) {
  const key = repo.toLowerCase();
  const prev: DeployTarget = get().app!.deployTargets[key] ?? { url: '', mode: 'change', tests: [] };
  const next = { ...prev, ...patch };
  await call('deploys:setTarget', repo, next);
  await saveApp({ deployTargets: { ...get().app!.deployTargets, [key]: next } });
}

function ActionControl({ a }: { a: SetupAction }) {
  const [v, setV] = useState('');
  const [mode, setMode] = useState<DeployTarget['mode']>('change');
  switch (a.kind) {
    case 'login':
      return (
        <button className="btn primary small" onClick={async () => set({ auth: await call('auth:login') })}>
          Войти через claude.ai
        </button>
      );
    case 'addProject':
      return (
        <button className="btn primary small" onClick={() => addProjects()}>
          Открыть папку
        </button>
      );
    case 'githubAccess':
      return (
        <div className="setup-form">
          <input type="password" placeholder="GitHub токен (ghp_… / github_pat_…)" value={v} onChange={(e) => setV(e.target.value)} />
          <button className="btn primary small" disabled={!v.trim()} onClick={() => saveApp({ githubToken: v.trim() })}>
            Сохранить токен
          </button>
          <span className="muted">или</span>
          <button className="btn small" title="Учётные данные github.com, которые git уже хранит для push" onClick={() => saveApp({ githubFromGit: true })}>
            Взять из git
          </button>
          <a className="small" href="https://github.com/settings/personal-access-tokens/new" target="_blank">
            создать токен ↗
          </a>
        </div>
      );
    case 'deployTarget':
      return (
        <div className="setup-form">
          <input placeholder="https://сайт.ru" value={v} onChange={(e) => setV(e.target.value)} />
          <select value={mode} onChange={(e) => setMode(e.target.value as DeployTarget['mode'])}>
            <option value="change">изменение страницы</option>
            <option value="sha">хэш коммита на странице</option>
          </select>
          <button className="btn primary small" disabled={!/^https?:\/\//.test(v.trim())} onClick={() => saveTarget(a.repo, { url: v.trim(), mode })}>
            Сохранить
          </button>
        </div>
      );
    case 'addTest': {
      const url = get().app!.deployTargets[a.repo.toLowerCase()]?.url ?? '';
      return (
        <div className="setup-form">
          <input placeholder="Текст, который должен быть на странице (необязательно)" value={v} onChange={(e) => setV(e.target.value)} />
          <button
            className="btn primary small"
            onClick={async () => {
              const prev = get().app!.deployTargets[a.repo.toLowerCase()];
              await saveTarget(a.repo, {
                tests: [...(prev?.tests ?? []), { id: crypto.randomUUID(), name: 'Главная страница', url, expectStatus: 200, contains: v.trim() || undefined, maxMs: 5000 }],
              });
              toast('Тест добавлен: главная отдаёт 200 быстрее 5 с');
            }}
          >
            Добавить тест главной
          </button>
          <button className="btn small" onClick={() => togglePanel('tests', true)}>
            Свой тест…
          </button>
        </div>
      );
    }
    case 'permissionMode':
      return (
        <div className="setup-form">
          <select defaultValue={a.current ?? ''} onChange={(e) => saveApp({ defaultPermissionMode: e.target.value || undefined, setupDismissed: [...(get().app!.setupDismissed ?? []), 'mode'] })}>
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id ? m.label : `Как в настройках Claude${a.fromClaude ? ` (${MODES.find((x) => x.id === a.fromClaude)?.label ?? a.fromClaude})` : ''}`}
              </option>
            ))}
          </select>
        </div>
      );
    case 'projectSettings':
      return (
        <button className="btn primary small" onClick={() => set({ projectSettings: a.project })}>
          Настройки проекта…
        </button>
      );
    case 'openPanel':
      return (
        <button className="btn small" onClick={() => togglePanel(a.panel, true)}>
          {a.label}
        </button>
      );
  }
}

function Row({ item, showGroup }: { item: SetupItem; showGroup?: boolean }) {
  const dismissed = useStore((s) => s.app!.setupDismissed?.includes(item.id));
  const toggleDismiss = () => {
    const list = get().app!.setupDismissed ?? [];
    void saveApp({ setupDismissed: dismissed ? list.filter((x) => x !== item.id) : [...list, item.id] });
  };
  return (
    <div className={`setup-row ${item.level}`}>
      <span className="setup-icon">{item.level === 'ok' ? '✓' : item.level === 'todo' ? '!' : 'i'}</span>
      <div className="setup-main">
        <div className="setup-title">
          {showGroup && <span className="src">{item.group}</span>} {item.title}
        </div>
        {item.detail && <div className="setup-detail">{item.detail}</div>}
        {item.action && (item.level === 'todo' || item.action.kind === 'permissionMode' || item.action.kind === 'openPanel' || item.action.kind === 'projectSettings') && <ActionControl a={item.action} />}
      </div>
      {item.dismissable && (item.level === 'todo' || dismissed) && (
        <button className="btn small" onClick={toggleDismiss} title={dismissed ? 'Вернуть в список дел' : 'Скрыть из списка дел'}>
          {dismissed ? 'Вернуть' : 'Не нужно'}
        </button>
      )}
    </div>
  );
}

export function SetupPanel() {
  const items = useStore((s) => s.setup);
  useEffect(() => refreshSetup(), []);
  const todo = items.filter((i) => i.level === 'todo');
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <PanelFrame
      id="setup"
      title={todo.length ? `Настроить сейчас: ${todo.length}` : 'Всё настроено'}
      actions={
        <button className="btn small" onClick={() => refreshSetup()}>
          ⟳ Проверить
        </button>
      }
    >
      {todo.length > 0 && (
        <div className="setup-group">
          <div className="setup-group-title todo">Сделать сейчас</div>
          {todo.map((i) => (
            <Row key={i.id} item={i} showGroup />
          ))}
        </div>
      )}
      {groups.map((g) => {
        const rest = items.filter((i) => i.group === g && i.level !== 'todo');
        if (!rest.length) return null;
        return (
          <div key={g} className="setup-group">
            <div className="setup-group-title">{g}</div>
            {rest.map((i) => (
              <Row key={i.id} item={i} />
            ))}
          </div>
        );
      })}
      {!items.length && <div className="empty">Проверяю…</div>}
    </PanelFrame>
  );
}
