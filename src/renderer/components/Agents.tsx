import { useEffect, useState } from 'react';
import type { AgentId, AgentInfo, ChatSnapshot } from '../../shared/types';
import { call } from '../api';
import { closeChat, get, loadAgents, newChat, openFile, set, toast, useStore } from '../store';

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
  const usable = agents.filter((a) => a.installed);
  return (
    <select
      className="model-picker"
      value={value}
      title={`Модель и агент этого чата: ${AGENT_NAME[agent]}. Модель своего агента меняется на лету; модель другого агента — в новом чате`}
      onChange={(e) => {
        const v = e.target.value;
        if (v === '__agents') return set({ showAgents: true });
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
      {usable.map((a) => (
        <optgroup key={a.id} label={`${a.name}${a.ready ? '' : ' — ' + a.status}`}>
          <option value={`${a.id}|`}>{AGENT_SHORT[a.id]}: по умолчанию</option>
          {a.models.map((m) => (
            <option key={m.id} value={`${a.id}|${m.id}`}>
              {m.name}
            </option>
          ))}
        </optgroup>
      ))}
      <option value="__agents">⚙ Агенты…</option>
    </select>
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
                {a.ready ? 'Сменить вход' : 'Войти'}
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
