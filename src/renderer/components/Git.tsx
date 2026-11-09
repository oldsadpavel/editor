import { useEffect, useMemo, useState } from 'react';
import { call } from '../api';
import { get, set, toast, useStore } from '../store';
import { formatTime } from '../util';
import type { MenuItem } from './ContextMenu';

/**
 * Git like in PhpStorm: «Git ▸» in the tree's right-click menu, file colours by status, and dialogs for commit,
 * diff, history and branches.
 */

export type GitCode = 'M' | 'A' | 'D' | 'R' | 'U' | 'C' | 'I';
interface GitFile {
  path: string;
  code: GitCode;
  staged: boolean;
}
interface GitStatus {
  root: string;
  branch: string;
  ahead: number;
  behind: number;
  files: GitFile[];
}
interface Commit {
  hash: string;
  author: string;
  at: number;
  subject: string;
}
export type GitDialog = { mode: 'commit' | 'diff' | 'history' | 'branches'; root: string; path: string; hash?: string };

const CODE_LABEL: Record<GitCode, string> = { M: 'изменён', A: 'добавлен', D: 'удалён', R: 'переименован', U: 'новый, не в git', C: 'конфликт', I: 'игнорируется' };
const key = (p: string) => p.toLowerCase().replace(/[\\/]+$/, '');
const rel = (root: string, p: string) => p.slice(root.length).replace(/^[\\/]/, '') || '.';
const g = <T,>(op: string, ...args: unknown[]) => call<T>('git', op, ...args);

/** Repository of each project (null: not a repository), found once. */
const roots = new Map<string, string | null>();
export async function repoOf(p: string): Promise<string | null> {
  const k = key(p);
  for (const [r, root] of roots) if (root && (k === key(root) || k.startsWith(key(root) + '\\') || k.startsWith(key(root) + '/'))) return root;
  if (!roots.has(k)) roots.set(k, await g<string | null>('repoRoot', p).catch(() => null));
  return roots.get(k) ?? null;
}

/** Status of the projects' repositories → colours in the tree and the branch next to each project. */
export async function refreshGit() {
  const projects = get().app?.projects ?? [];
  const files: Record<string, GitCode> = {};
  const branches: Record<string, string> = {};
  const done = new Set<string>();
  for (const p of projects) {
    const root = await repoOf(p.path);
    if (!root || done.has(key(root))) {
      if (root) branches[key(p.path)] = branches[key(root)];
      continue;
    }
    done.add(key(root));
    try {
      const st = await g<GitStatus>('status', root);
      for (const f of st.files) {
        files[key(f.path)] = f.code;
        // folders with changes inside are coloured too
        for (let d = f.path.replace(/[\\/][^\\/]+$/, ''); d.length > root.length; d = d.replace(/[\\/][^\\/]+$/, '')) files[key(d)] ??= 'M';
      }
      const b = st.branch + (st.ahead ? ` ↑${st.ahead}` : '') + (st.behind ? ` ↓${st.behind}` : '');
      branches[key(root)] = b;
      branches[key(p.path)] = b;
    } catch {
      /* not now */
    }
  }
  set({ gitFiles: files, gitBranches: branches });
}

export function useGitRefresh() {
  const projects = useStore((s) => s.app?.projects);
  useEffect(() => {
    void refreshGit();
    const t = setInterval(() => document.visibilityState === 'visible' && void refreshGit(), 10_000);
    const focus = () => void refreshGit();
    window.addEventListener('focus', focus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', focus);
    };
  }, [projects]);
}

async function run(label: string, op: string, ...args: unknown[]) {
  toast(`${label}…`);
  try {
    const out = await g<string>(op, ...args);
    const text = String(out ?? '').trim();
    toast(`${label}: готово${text ? ' — ' + text.split('\n').slice(-2).join(' ').slice(0, 160) : ''}`);
  } catch (e: any) {
    toast(`${label}: ${e.message}`, 'error');
  }
  void refreshGit();
}

/** The «Git ▸» submenu for a file or folder of a repository. */
export function gitMenu(root: string, path: string, isDir: boolean): MenuItem[] {
  const code = get().gitFiles[key(path)];
  const open = (mode: GitDialog['mode']) => set({ gitDialog: { mode, root, path } });
  return [
    { label: 'Коммит…', action: () => open('commit') },
    ...(code === 'U' || isDir ? [{ label: 'Добавить в git (git add)', action: () => run('git add', 'add', root, [path]) }] : []),
    { label: 'Показать изменения (diff)', action: () => open('diff') },
    { label: 'История', action: () => open('history') },
    {
      label: 'Откатить изменения…',
      danger: true,
      action: () => confirm(`Вернуть «${rel(root, path)}» к последнему коммиту? Изменения пропадут. Новые файлы, ещё не добавленные в git, останутся как есть.`) && run('Откат', 'rollback', root, [path]),
    },
    { label: '—', sep: true, action: () => {} },
    { label: 'Ветки…', action: () => open('branches') },
    { label: 'Pull (забрать с сервера)', action: () => run('Pull', 'pull', root) },
    { label: 'Push (отправить коммиты)', action: () => run('Push', 'push', root) },
    { label: 'Fetch', action: () => run('Fetch', 'fetch', root) },
    { label: '—', sep: true, action: () => {} },
    { label: 'Спрятать изменения (stash)…', action: () => {
        const m = prompt('Название для stash (необязательно)', '');
        if (m !== null) void run('Stash', 'stash', root, m);
      } },
    { label: 'Вернуть спрятанное (stash pop)', action: () => run('Unstash', 'unstash', root) },
  ];
}

export function GitDialogHost() {
  const d = useStore((s) => s.gitDialog);
  useEffect(() => {
    if (!d) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && set({ gitDialog: undefined });
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [!!d]);
  if (!d) return null;
  const close = () => set({ gitDialog: undefined });
  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className={`modal git-modal git-${d.mode}`} onMouseDown={(e) => e.stopPropagation()}>
        <button className="icon-btn git-x" title="Закрыть (Esc)" onClick={close}>
          ×
        </button>
        {d.mode === 'commit' && <CommitView d={d} />}
        {d.mode === 'diff' && <DiffView d={d} />}
        {d.mode === 'history' && <HistoryView d={d} />}
        {d.mode === 'branches' && <BranchesView d={d} />}
      </div>
    </div>
  );
}

function CommitView({ d }: { d: GitDialog }) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState('');
  const [diffOf, setDiffOf] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void g<GitStatus>('status', d.root, rel(d.root, d.path)).then((s) => {
      setSt(s);
      setChecked(new Set(s.files.filter((f) => f.code !== 'I').map((f) => f.path)));
      setDiffOf(s.files[0]?.path ?? null);
    }, (e) => toast(e.message, 'error'));
  }, [d.root, d.path]);
  const doCommit = async (push: boolean) => {
    setBusy(true);
    try {
      const out = await g<string>('commit', d.root, [...checked], msg, push);
      toast(`${push ? 'Коммит и push' : 'Коммит'}: ${out.split('\n')[0].slice(0, 120)}`);
      set({ gitDialog: undefined });
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
      void refreshGit();
    }
  };
  if (!st) return <div className="muted">Загрузка…</div>;
  return (
    <>
      <h3>
        Коммит — {rel(d.root, d.path) === '.' ? d.root : rel(d.root, d.path)} <span className="muted small">⎇ {st.branch}</span>
      </h3>
      {!st.files.length ? (
        <div className="empty">Изменений нет</div>
      ) : (
        <div className="git-commit">
          <div className="git-files">
            <label className="git-file all">
              <input type="checkbox" checked={checked.size === st.files.length} onChange={(e) => setChecked(new Set(e.target.checked ? st.files.map((f) => f.path) : []))} /> Все ({st.files.length})
            </label>
            {st.files.map((f) => (
              <label key={f.path} className={`git-file git-${f.code} ${diffOf === f.path ? 'on' : ''}`} title={`${CODE_LABEL[f.code]} — ${f.path}`} onClick={() => setDiffOf(f.path)}>
                <input
                  type="checkbox"
                  checked={checked.has(f.path)}
                  onChange={(e) => {
                    const n = new Set(checked);
                    if (e.target.checked) n.add(f.path);
                    else n.delete(f.path);
                    setChecked(n);
                  }}
                />
                <span className="git-code">{f.code}</span> {rel(d.root, f.path)}
              </label>
            ))}
          </div>
          <div className="git-side">{diffOf ? <DiffText root={d.root} path={diffOf} /> : null}</div>
        </div>
      )}
      <textarea className="git-msg" rows={3} placeholder="Сообщение коммита" value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && void doCommit(false)} autoFocus />
      <div className="modal-actions">
        <button className="btn" onClick={() => set({ gitDialog: undefined })}>
          Отмена
        </button>
        <button className="btn" disabled={busy || !checked.size || !msg.trim()} onClick={() => void doCommit(true)}>
          Коммит и Push
        </button>
        <button className="btn primary" disabled={busy || !checked.size || !msg.trim()} onClick={() => void doCommit(false)} title="Ctrl+Enter">
          {busy ? '…' : 'Коммит'}
        </button>
      </div>
    </>
  );
}

function DiffText({ root, path, hash }: { root: string; path: string; hash?: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    void (hash ? g<string>('show', root, hash, path) : g<string>('diff', root, path)).then(setText, (e) => setText(`Ошибка: ${e.message}`));
  }, [root, path, hash]);
  return <Diff text={text} />;
}

function Diff({ text }: { text: string | null }) {
  const lines = useMemo(() => (text ?? '').split('\n'), [text]);
  if (text === null) return <div className="muted">Загрузка…</div>;
  if (!text.trim()) return <div className="empty">Нет изменений</div>;
  return (
    <pre className="git-diff">
      {lines.map((l, i) => {
        const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'h' : l.startsWith('@@') ? 'at' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
        return (
          <div key={i} className={cls}>
            {l || ' '}
          </div>
        );
      })}
    </pre>
  );
}

function DiffView({ d }: { d: GitDialog }) {
  return (
    <>
      <h3>Изменения — {rel(d.root, d.path)}</h3>
      <DiffText root={d.root} path={d.path} />
    </>
  );
}

function HistoryView({ d }: { d: GitDialog }) {
  const [list, setList] = useState<Commit[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    void g<Commit[]>('log', d.root, d.path).then((l) => {
      setList(l);
      setSel(l[0]?.hash ?? null);
    }, (e) => toast(e.message, 'error'));
  }, [d.root, d.path]);
  return (
    <>
      <h3>История — {rel(d.root, d.path)}</h3>
      {!list ? (
        <div className="muted">Загрузка…</div>
      ) : !list.length ? (
        <div className="empty">Коммитов нет</div>
      ) : (
        <div className="git-commit">
          <div className="git-files">
            {list.map((c) => (
              <div key={c.hash} className={`git-log ${sel === c.hash ? 'on' : ''}`} onClick={() => setSel(c.hash)} title={c.hash}>
                <div>{c.subject}</div>
                <div className="muted small">
                  {c.hash.slice(0, 8)} · {c.author} · {formatTime(c.at)}
                </div>
              </div>
            ))}
          </div>
          <div className="git-side">{sel && <DiffText root={d.root} path={d.path} hash={sel} />}</div>
        </div>
      )}
    </>
  );
}

function BranchesView({ d }: { d: GitDialog }) {
  const [list, setList] = useState<{ name: string; current: boolean; remote: boolean; at: number; upstream: string }[] | null>(null);
  const [name, setName] = useState('');
  const load = () => void g<typeof list>('branches', d.root).then(setList, (e) => toast(e.message, 'error'));
  useEffect(load, [d.root]);
  const act = async (label: string, op: string, ...args: unknown[]) => {
    try {
      await g(op, d.root, ...args);
      toast(label);
      set({ gitDialog: undefined });
    } catch (e: any) {
      toast(e.message, 'error');
      load();
    }
    void refreshGit();
  };
  const local = list?.filter((b) => !b.remote) ?? [];
  const remote = list?.filter((b) => b.remote) ?? [];
  const row = (b: NonNullable<typeof list>[number]) => (
    <div key={(b.remote ? 'r:' : '') + b.name} className={`git-branch ${b.current ? 'on' : ''}`}>
      <span>
        {b.current ? '● ' : ''}
        {b.name}
        {b.upstream && <span className="muted small"> → {b.upstream}</span>}
      </span>
      <span className="muted small">{b.at ? formatTime(b.at) : ''}</span>
      {!b.current && (
        <button className="btn small" onClick={() => void act(`Переключено на ${b.name}`, 'checkout', b.name, b.remote)}>
          Переключиться
        </button>
      )}
    </div>
  );
  return (
    <>
      <h3>Ветки — {d.root}</h3>
      <div className="git-newbranch">
        <input placeholder="Новая ветка от текущей" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void act(`Создана ветка ${name.trim()}`, 'newBranch', name.trim())} />
        <button className="btn small primary" disabled={!name.trim()} onClick={() => void act(`Создана ветка ${name.trim()}`, 'newBranch', name.trim())}>
          Создать и переключиться
        </button>
      </div>
      {!list ? (
        <div className="muted">Загрузка…</div>
      ) : (
        <div className="git-branches">
          <div className="muted small">Локальные</div>
          {local.map(row)}
          {remote.length > 0 && <div className="muted small">Удалённые</div>}
          {remote.map(row)}
        </div>
      )}
    </>
  );
}
