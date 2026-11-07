import { useEffect, useState } from 'react';
import type { ChatSnapshot } from '../../shared/types';
import { call } from '../api';
import { get, newChat, saveApp, set, toast, useStore } from '../store';

/** Where new projects go by default: the folder most existing projects live in (E:\sites). */
function defaultParent(): string {
  const counts = new Map<string, number>();
  for (const p of get().app?.projects ?? []) {
    const parent = p.path.replace(/[\\/][^\\/]+[\\/]?$/, '');
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

/** «Новый проект»: a folder (optionally a git repository) added to the projects, with a chat in it. */
export function NewProjectModal() {
  const open = useStore((s) => s.newProject);
  if (!open) return null;
  return <Form />;
}

function Form() {
  const [parent, setParent] = useState(defaultParent);
  const [name, setName] = useState('');
  const [git, setGit] = useState(true);
  const [chat, setChat] = useState(true);
  const [about, setAbout] = useState('');
  const [busy, setBusy] = useState(false);
  const close = () => set({ newProject: false });
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);
  const sep = parent.includes('/') && !parent.includes('\\') ? '/' : '\\';
  const full = parent && name.trim() ? `${parent.replace(/[\\/]+$/, '')}${sep}${name.trim()}` : '';
  const pick = async () => {
    const dirs = await call<string[]>('dialog:folder');
    if (dirs[0]) setParent(dirs[0]);
  };
  const create = async () => {
    if (!full || busy) return;
    setBusy(true);
    try {
      const dir = await call<string>('project:create', parent, name.trim(), git);
      const app = get().app!;
      await saveApp({ projects: [...app.projects, { path: dir, name: name.trim() }], chatProject: dir, ui: { ...app.ui, visible: { ...app.ui.visible, chat: true } } });
      close();
      toast(`Проект «${name.trim()}» создан: ${dir}${git ? ' (git init)' : ''}`);
      if (!chat && !about.trim()) return;
      const sid = await newChat(dir);
      if (sid && about.trim()) {
        const snap = get().chats[sid] as ChatSnapshot | undefined;
        await call('chat:send', sid, about.trim(), { model: snap?.model, effort: snap?.effort, permissionMode: snap?.permissionMode });
      }
    } catch (e: any) {
      toast(e.message ?? String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal new-project" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Новый проект</h3>
        <label>
          Название (имя папки)
          <input autoFocus value={name} placeholder="my-site" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && void create()} />
        </label>
        <label>
          Где создать
          <div className="row">
            <input value={parent} onChange={(e) => setParent(e.target.value)} />
            <button className="btn small" onClick={() => void pick()}>
              Выбрать…
            </button>
          </div>
        </label>
        {full && <div className="muted small">Папка: {full}</div>}
        <label className="check">
          <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} /> git init (репозиторий, ветка main)
        </label>
        <label className="check">
          <input type="checkbox" checked={chat} onChange={(e) => setChat(e.target.checked)} /> Открыть чат в новом проекте
        </label>
        <label>
          Что за проект (необязательно — уйдёт первым вопросом в чат)
          <textarea rows={4} value={about} placeholder="Лендинг для … на Vite + React; начни с каркаса и README" onChange={(e) => setAbout(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={close}>
            Отмена
          </button>
          <button className="btn primary" disabled={!full || busy} onClick={() => void create()}>
            {busy ? 'Создаю…' : 'Создать'}
          </button>
        </div>
      </div>
    </div>
  );
}
