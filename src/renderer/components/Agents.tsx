import { useEffect, useRef, useState } from 'react';
import type { AgentId, AgentInfo, ChatSnapshot } from '../../shared/types';
import { call } from '../api';
import { closeChat, get, loadAgents, newChat, openFile, saveApp, set, toast, useStore } from '../store';

export const AGENT_SHORT: Record<AgentId, string> = { claude: 'Claude', codex: 'GPT', gemini: 'Gemini', opencode: 'OC', aider: 'Aider' };
export const AGENT_NAME: Record<AgentId, string> = { claude: 'Claude Code', codex: 'Codex (OpenAI)', gemini: 'Gemini CLI (Google)', opencode: 'OpenCode', aider: 'Aider' };

const CLAUDE_MODELS = [
  { id: '', name: 'по умолчанию' },
  { id: 'fable', name: 'Fable — самая сильная' },
  { id: 'opus', name: 'Opus — сложные задачи' },
  { id: 'sonnet', name: 'Sonnet — быстро и умно' },
  { id: 'haiku', name: 'Haiku — быстрее всех' },
];

/** Short label of a model for the closed select. */
function shortModel(agent: AgentId, model: string, agents: AgentInfo[]) {
  if (agent === 'claude' && model.startsWith('or:')) return 'OR · ' + model.slice(3).split('/').pop()!.replace(/\[1m\]$/, '');
  if (agent === 'claude') return model ? model[0].toUpperCase() + model.slice(1) : 'Модель';
  const m = agents.find((a) => a.id === agent)?.models.find((x) => x.id === model);
  return `${AGENT_SHORT[agent]}${model ? ` · ${(m?.name ?? model).replace(/ \(бесплатно\)$/, '').split('/').pop()}` : ''}`;
}

/**
 * One model list for all connected agents (grouped by agent). A model of the chat's own agent switches in place; one
 * of another agent asks first (AgentSwitchModal), since agents don't share history.
 */
export function ModelPicker({ chat, model, onModel }: { chat: ChatSnapshot; model: string; onModel: (m: string) => void }) {
  const agents = useStore((s) => s.agents);
  useEffect(() => void loadAgents(), []);
  const agent = chat.agent ?? 'claude';
  const value = `${agent}|${model}`;
  // only agents that can answer now (logged in / have a key); the rest are one line pointing to ⚙ Агенты
  const usable = agents.filter((a) => a.installed && a.ready);
  const orModels = useStore((s) => s.app?.openrouterModels ?? NO_MODELS);
  const waiting = agents.filter((a) => a.installed && !a.ready);
  return (
    <select
      className="model-picker"
      value={value}
      title={`Модель и агент этого чата: ${AGENT_NAME[agent]}. Модель своего агента меняется на лету; модель другого агента — в новом чате`}
      onChange={(e) => {
        const v = e.target.value;
        if (v === '__agents') return set({ showAgents: true });
        if (v === '__openrouter') return set({ showOpenRouter: true });
        const [a, ...rest] = v.split('|');
        const m = rest.join('|');
        if (a === agent) return onModel(m);
        set({ agentSwitch: { sessionId: chat.sessionId, cwd: chat.cwd, agent: a as AgentId, model: m } });
      }}
    >
      <option value={value} hidden>
        {shortModel(agent, model, agents)}
      </option>
      <optgroup label="Claude Code">
        {CLAUDE_MODELS.map((m) => (
          <option key={m.id} value={`claude|${m.id}`}>
            {m.id ? m.name : 'Claude: по умолчанию'}
          </option>
        ))}
      </optgroup>
      <optgroup label="OpenRouter (через Claude Code)">
        {orModels.map((id) => (
          <option key={id} value={`claude|or:${id}`}>
            {id}
          </option>
        ))}
        <option value="__openrouter">⚙ OpenRouter…</option>
      </optgroup>
      {usable.map((a) => (
        <optgroup key={a.id} label={a.name}>
          <option value={`${a.id}|`}>{AGENT_SHORT[a.id]}: по умолчанию</option>
          {a.models.map((m) => (
            <option key={m.id} value={`${a.id}|${m.id}`}>
              {m.name}
            </option>
          ))}
        </optgroup>
      ))}
      <option value="__agents">⚙ Агенты…{waiting.length ? ` (нужен вход: ${waiting.map((a) => AGENT_SHORT[a.id]).join(', ')})` : ''}</option>
    </select>
  );
}

const NO_MODELS: string[] = [];

/** OpenRouter in the account menu: key there or not, how many models are in the list; opens ⚙ OpenRouter. */
function OpenRouterRow({ onOpen }: { onOpen: () => void }) {
  const chosen = useStore((s) => s.app?.openrouterModels ?? NO_MODELS);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  useEffect(() => void call<{ hasKey: boolean }>('openrouter:status').then((s) => setHasKey(s.hasKey), () => setHasKey(false)), []);
  return (
    <div className="acc-agent">
      <div className="acc-row">
        <span className={`acc-dot ${hasKey ? (chosen.length ? 'ok' : 'warn') : 'off'}`} />
        <div className="acc-main">
          <b>OpenRouter</b>
          <span className="muted small">{hasKey === null ? '…' : hasKey ? `ключ задан · моделей в списке: ${chosen.length}` : 'модели openrouter.ai в чатах Claude Code — нужен ключ'}</span>
        </div>
        <div className="acc-actions inline">
          <button className="btn small" onClick={onOpen}>
            {hasKey ? 'Модели и ключ' : 'Добавить ключ'}
          </button>
        </div>
      </div>
    </div>
  );
}

type OrStatus = { hasKey: boolean; label?: string; usage?: number; limit?: number | null; error?: string };
type OrModel = { id: string; name: string; context?: number };

/**
 * ⚙ OpenRouter: the key (kept encrypted on this PC, never shown again) and which OpenRouter models are in the model
 * list. A chat with such a model is the same Claude Code — tools, files, MCP — answered through openrouter.ai.
 */
export function OpenRouterModal() {
  const open = useStore((s) => s.showOpenRouter);
  const chosen = useStore((s) => s.app?.openrouterModels ?? NO_MODELS);
  const [st, setSt] = useState<OrStatus | null>(null);
  const [key, setKey] = useState('');
  const [list, setList] = useState<OrModel[] | null>(null);
  const [q, setQ] = useState('');
  const [custom, setCustom] = useState('');
  const refresh = () => {
    void call<OrStatus>('openrouter:status').then(setSt);
    void call<OrModel[]>('openrouter:models').then(setList, (e) => (setList([]), toast(e.message, 'error')));
  };
  useEffect(() => {
    if (open) refresh();
  }, [open]);
  if (!open) return null;
  const close = () => set({ showOpenRouter: undefined });
  const toggle = (id: string) => void saveApp({ openrouterModels: chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id] });
  const shown = (list ?? []).filter((m) => !q || (m.id + ' ' + m.name).toLowerCase().includes(q.toLowerCase()));
  const extra: OrModel[] = chosen.filter((id) => !(list ?? []).some((m) => m.id === id)).map((id) => ({ id, name: id }));
  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal or-modal" onMouseDown={(e) => e.stopPropagation()}>
        <button className="icon-btn git-x" title="Закрыть" onClick={close}>
          ×
        </button>
        <h3 style={{ marginTop: 0 }}>OpenRouter</h3>
        <p className="muted small">
          Модели с openrouter.ai в чатах Claude Code: те же инструменты, файлы и MCP, ответ — через OpenRouter (оплата с вашего счёта OpenRouter, лимиты Claude не тратятся). Полную совместимость OpenRouter гарантирует только для моделей Anthropic; другие могут хуже работать с инструментами.
        </p>
        <div className="or-key">
          <b>Ключ API:</b>{' '}
          {st?.hasKey ? (
            <>
              <span>сохранён{st.label ? ` (${st.label})` : ''}</span>
              {st.usage !== undefined && (
                <span className="muted small">
                  {' '}
                  · потрачено ${st.usage.toFixed(2)}
                  {st.limit ? ` из $${st.limit}` : ''}
                </span>
              )}
              {st.error && <span className="err small"> · {st.error}</span>}{' '}
              <button className="btn small" onClick={() => void call('openrouter:setKey', null).then(refresh)}>
                Удалить
              </button>
            </>
          ) : (
            <span className="muted">нет — создайте на openrouter.ai/keys и вставьте сюда</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, margin: '6px 0 10px' }}>
          <input type="password" placeholder="sk-or-v1-…" value={key} onChange={(e) => setKey(e.target.value)} style={{ flex: 1 }} autoComplete="off" />
          <button
            className="btn primary"
            disabled={!key.trim()}
            onClick={() =>
              void call('openrouter:setKey', key.trim()).then(() => {
                setKey('');
                refresh();
                toast('Ключ OpenRouter сохранён (зашифрован на этом компьютере)');
              })
            }
          >
            Сохранить ключ
          </button>
        </div>
        <div>
          <b>Модели в списке</b> <span className="muted small">— отмеченные появятся в выборе модели чата</span>
        </div>
        <input className="search" placeholder="Поиск модели…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', margin: '6px 0' }} />
        <div className="or-list">
          {!list && <div className="muted">Загружаю список…</div>}
          {[...extra, ...shown].map((m) => (
            <label key={m.id} className="or-row">
              <input type="checkbox" checked={chosen.includes(m.id)} onChange={() => toggle(m.id)} />
              <span className="grow">{m.name}</span>
              <code className="muted small">{m.id}</code>
              {m.context ? <span className="muted small">{Math.round(m.context / 1000)}k</span> : null}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <input placeholder="или id модели вручную, например anthropic/claude-sonnet-5.5" value={custom} onChange={(e) => setCustom(e.target.value)} style={{ flex: 1 }} />
          <button
            className="btn"
            disabled={!custom.trim()}
            onClick={() => {
              if (!chosen.includes(custom.trim())) void saveApp({ openrouterModels: [...chosen, custom.trim()] });
              setCustom('');
            }}
          >
            Добавить
          </button>
        </div>
      </div>
    </div>
  );
}

/** A model of another agent was picked: what happens, and a new chat or this one cleared. */
export function AgentSwitchModal() {
  const sw = useStore((s) => s.agentSwitch);
  const agents = useStore((s) => s.agents);
  const chat = useStore((s) => (s.agentSwitch ? s.chats[s.agentSwitch.sessionId] : undefined));
  if (!sw) return null;
  const from = chat?.agent ?? 'claude';
  const info = agents.find((a) => a.id === sw.agent);
  const modelName = sw.agent === 'claude' ? CLAUDE_MODELS.find((m) => m.id === sw.model)?.name.split(' — ')[0] : info?.models.find((m) => m.id === sw.model)?.name;
  const label = `${AGENT_SHORT[sw.agent]}${modelName || sw.model ? ' · ' + (modelName ?? sw.model) : ''}`;
  const close = () => set({ agentSwitch: undefined });
  const start = async (replace: boolean) => {
    close();
    const id = await newChat(sw.cwd, sw.agent, sw.model || undefined);
    if (id && replace) await closeChat(sw.sessionId);
  };
  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal agent-switch" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Сменить агента: {AGENT_NAME[from]} → {AGENT_NAME[sw.agent]}</h3>
        <p>
          Модель <b>{label}</b> работает через агента <b>{AGENT_NAME[sw.agent]}</b>, а этот чат — с <b>{AGENT_NAME[from]}</b>. У агентов своя
          история, и друг друга они не видят: продолжить этот разговор с другой моделью нельзя — новый агент начнёт с чистого листа.
        </p>
        <ul>
          <li>Файлы проекта, CLAUDE.md и память проекта остаются — их новый агент прочитает сам, если попросить.</li>
          <li>Этот чат не пропадает: он остаётся во вкладках или в «Истории», к нему можно вернуться.</li>
          {sw.agent !== 'claude' && <li>У {AGENT_SHORT[sw.agent]} нет /RC, отката ответов и разрешений по одному действию — доступ задаётся режимом и «Подтверждать всё».</li>}
        </ul>
        {info && !info.ready && (
          <p className="warn-line">
            {info.name}: {info.status}.{' '}
            {info.login && (
              <button className="btn small" onClick={() => void call('agents:login', info.id).then(() => toast('Войдите в открывшемся окне терминала, затем нажмите «Обновить» в ⚙ Агенты'))}>
                Войти
              </button>
            )}
          </p>
        )}
        <div className="modal-actions">
          <button className="btn primary" onClick={() => void start(false)}>
            Новый чат с {label}
          </button>
          <button className="btn" onClick={() => void start(true)} title="Этот чат закроется (он останется в «Истории»), на его месте — новый с другим агентом">
            Очистить этот чат и продолжить с {label}
          </button>
          <button className="btn" onClick={close}>
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}

const AIDER_KEYS_TEMPLATE = `# Ключи для Aider (MPI). Уберите «# » у нужных строк и вставьте свой ключ.
# DeepSeek: https://platform.deepseek.com/api_keys
# api-key:
#   - deepseek=sk-...
#   - openai=sk-...
#   - openrouter=sk-or-...
`;

/**
 * The account button's menu: every agent's login in one place — Claude Code (its own sign-in options), Codex, Gemini,
 * OpenCode, Aider — plus the settings cloud and the agents window.
 */
export function AccountsPopover({ x, y, claudeItems, onClose }: { x: number; y: number; claudeItems: { label: string; action: () => unknown; danger?: boolean }[]; onClose: () => void }) {
  const auth = useStore((s) => s.auth);
  const agents = useStore((s) => s.agents);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void loadAgents(true);
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, []);
  const act = (f: () => unknown) => () => {
    onClose();
    void f();
  };
  const login = (a: AgentInfo) => act(() => call('agents:login', a.id).then(() => toast(`${a.name}: войдите в открывшемся окне терминала`), (e) => toast(e.message, 'error')));
  const keysFile = async (a: AgentInfo) => {
    if (!a.keysFile) return;
    if (!(await call<boolean>('fs:exists', a.keysFile))) await call('fs:write', a.keysFile, AIDER_KEYS_TEMPLATE);
    await openFile(a.keysFile);
  };
  const [first, ...restClaude] = claudeItems;
  return (
    <div className="accounts-pop" ref={box} style={{ left: Math.max(8, Math.min(x - 300, window.innerWidth - 400)), top: y }}>
      <div className="acc-row">
        <span className={`acc-dot ${auth?.loggedIn ? 'ok' : 'off'}`} />
        <div className="acc-main">
          <b>Claude Code</b>
          <span className="muted small">{auth?.loggedIn ? `${auth.email ?? ''}${auth.method ? ' · ' + auth.method : ''}` : 'вход не выполнен'}</span>
        </div>
      </div>
      <div className="acc-actions">
        {[first, ...restClaude].filter(Boolean).map((it) => (
          <button key={it.label} className={`btn small ${it.danger ? 'danger' : ''}`} onClick={act(it.action)}>
            {it.label.replace(/ \(.*\)$/, '')}
          </button>
        ))}
      </div>
      {agents.map((a) => (
        <div key={a.id} className="acc-agent">
          <div className="acc-row">
            <span className={`acc-dot ${!a.installed ? 'off' : a.ready ? 'ok' : 'warn'}`} />
            <div className="acc-main">
              <b>{a.name}</b>
              <span className="muted small">{a.installed ? a.status : 'не установлен'}</span>
            </div>
            <div className="acc-actions inline">
              {!a.installed && (
                <button className="btn small" onClick={act(() => set({ showAgents: true }))}>
                  Установить…
                </button>
              )}
              {a.installed && a.login && (
                <button className="btn small" onClick={login(a)}>
                  {a.id === 'opencode' ? 'Добавить ключ' : a.ready ? 'Сменить' : 'Войти'}
                </button>
              )}
              {a.installed && a.id === 'codex' && a.ready && (
                <button className="btn small danger" onClick={act(() => call('agents:logout', 'codex').then(() => loadAgents(true)))}>
                  Выйти
                </button>
              )}
              {a.installed && a.keysFile && (
                <button className="btn small" onClick={act(() => keysFile(a))}>
                  Ключи
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
      <OpenRouterRow onOpen={act(() => set({ showOpenRouter: true }))} />
      <div className="acc-footer">
        <button className="btn small" onClick={act(() => set({ showCloud: true }))}>
          ☁ Облако настроек…
        </button>
        <button className="btn small" onClick={act(() => set({ showAgents: true }))}>
          ⚙ Агенты…
        </button>
        <button className="btn small" onClick={() => void loadAgents(true).then(() => call('auth:status').then((a: any) => set({ auth: a })))}>
          ⟳ Обновить
        </button>
      </div>
    </div>
  );
}

/** ⚙ Агенты: which coding agents are installed and logged in; install, log in, keys. */
export function AgentsModal() {
  const open = useStore((s) => s.showAgents);
  const agents = useStore((s) => s.agents);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (open) void loadAgents(true);
  }, [open]);
  if (!open) return null;
  const close = () => set({ showAgents: false });
  const install = async (a: AgentInfo) => {
    setBusy(a.id);
    try {
      await call('agents:install', a.id);
      toast(`${a.name} установлен`);
      await loadAgents(true);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const keys = async (a: AgentInfo) => {
    if (!a.keysFile) return;
    if (!(await call<boolean>('fs:exists', a.keysFile))) await call('fs:write', a.keysFile, AIDER_KEYS_TEMPLATE);
    close();
    await openFile(a.keysFile);
  };
  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal agents-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Агенты</h3>
        <p className="muted">
          Модели всех установленных агентов есть в выборе модели под полем вопроса. Чат работает с одним агентом; модель другого агента открывает новый чат.
        </p>
        <div className="agent-row">
          <b>Claude Code</b>
          <span className="agent-status ok">основной</span>
          <span className="muted small">модели Claude: Fable, Opus, Sonnet, Haiku</span>
        </div>
        {agents.map((a) => (
          <div key={a.id} className="agent-row">
            <b>{a.name}</b>
            <span className={`agent-status ${!a.installed ? 'off' : a.ready ? 'ok' : 'warn'}`}>{a.installed ? `${a.version ? 'v' + a.version + ' · ' : ''}${a.status}` : 'не установлен'}</span>
            <span className="muted small">{a.installed ? `моделей: ${a.models.length}` : a.install}</span>
            <div className="grow" />
            {!a.installed && a.install && (
              <button className="btn small primary" disabled={busy === a.id} onClick={() => void install(a)}>
                {busy === a.id ? 'Устанавливаю…' : 'Установить'}
              </button>
            )}
            {a.installed && a.login && (
              <button className="btn small" onClick={() => void call('agents:login', a.id).then(() => toast('Войдите в открывшемся окне терминала, затем нажмите «Обновить»'))}>
                {a.id === 'opencode' ? 'Добавить ключ' : a.ready ? 'Сменить вход' : 'Войти'}
              </button>
            )}
            {a.installed && a.keysFile && (
              <button className="btn small" onClick={() => void keys(a)} title={a.keysFile}>
                Ключи
              </button>
            )}
          </div>
        ))}
        <p className="muted small">
          DeepSeek: бесплатно — в OpenCode (модель «deepseek-…» с пометкой «бесплатно»), по своему ключу — в Aider (кнопка «Ключи») или в OpenCode (Войти →
          DeepSeek).
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={() => void loadAgents(true)}>
            ⟳ Обновить
          </button>
          <button className="btn primary" onClick={close}>
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}

export const agentsReady = () => get().agents;
