import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { FileChange, Turn } from '../shared/types';
import { dataDir } from './store';

type Op = { kind: ' ' | '-' | '+'; text: string };

/** Line diff (LCS). Edit hunks are small, so the quadratic table is fine; big inputs fall back to old/new blocks. */
function lineDiff(a: string, b: string): Op[] {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > 4_000_000) return [...x.map((t) => ({ kind: '-' as const, text: t })), ...y.map((t) => ({ kind: '+' as const, text: t }))];
  const n = x.length;
  const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) (out.push({ kind: ' ', text: x[i] }), i++, j++);
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: '-', text: x[i++] });
    else out.push({ kind: '+', text: y[j++] });
  }
  while (i < n) out.push({ kind: '-', text: x[i++] });
  while (j < m) out.push({ kind: '+', text: y[j++] });
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Line number where a replaced fragment sits in the file now (best effort: the new text may have changed again). */
function lineOf(current: string | null, fragment: string): number | null {
  if (!current || !fragment.trim()) return null;
  const at = current.indexOf(fragment);
  return at < 0 ? null : current.slice(0, at).split('\n').length;
}

function block(ops: Op[], startLine: number | null) {
  let ln = startLine ?? 0;
  return ops
    .map((o) => {
      const num = startLine !== null && o.kind !== '-' ? String(ln++) : '';
      return `<div class="l ${o.kind === '+' ? 'add' : o.kind === '-' ? 'del' : ''}"><span class="n">${num}</span><span class="s">${o.kind}</span><span class="t">${esc(o.text) || ' '}</span></div>`;
    })
    .join('');
}

function render(file: string, items: { turn: Turn; change: FileChange }[], title: string) {
  let current: string | null = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    /* deleted since */
  }
  const time = (t: number) => new Date(t).toLocaleString('ru-RU');
  let adds = 0;
  let dels = 0;
  const parts = items.map(({ turn, change }, k) => {
    const head = `<div class="ch-head">${k + 1}. ${esc(change.tool)} · ${time(change.at)}${items.some((x) => x.turn !== turn) ? ` · вопрос «${esc(turn.prompt.slice(0, 80))}»` : ''}</div>`;
    if (change.content !== undefined) {
      const lines = change.content.split('\n');
      adds += lines.length;
      return `${head}<div class="note">Файл записан целиком (${lines.length} строк) — показано новое содержимое.</div><div class="hunk">${block(
        lines.map((t) => ({ kind: '+' as const, text: t })),
        1,
      )}</div>`;
    }
    return (
      head +
      (change.edits ?? [])
        .map((e) => {
          const ops = lineDiff(e.old, e.new);
          adds += ops.filter((o) => o.kind === '+').length;
          dels += ops.filter((o) => o.kind === '-').length;
          const line = lineOf(current, e.new);
          return `<div class="hunk">${line ? `<div class="at">строка ${line}${e.all ? ' · заменены все вхождения' : ''}</div>` : e.all ? '<div class="at">заменены все вхождения</div>' : ''}${block(ops, line)}</div>`;
        })
        .join('')
    );
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
  body{margin:0;background:#1e1f22;color:#dfe1e5;font:13px system-ui,sans-serif}
  header{position:sticky;top:0;background:#2b2d30;padding:10px 16px;border-bottom:1px solid #393b40;z-index:1}
  header b{font-size:14px} .path{color:#9da0a8;font-size:12px;margin-top:2px;word-break:break-all}
  .stat{margin-left:10px}.stat .a{color:#5fb865}.stat .d{color:#f75464}
  main{padding:8px 16px 40px}
  .ch-head{margin:18px 0 6px;color:#d97757;font-weight:600}
  .note,.at{color:#9da0a8;font-size:12px;margin:4px 0}
  .hunk{border:1px solid #393b40;border-radius:6px;margin:6px 0 12px;overflow:auto;font:12.5px 'JetBrains Mono',Consolas,monospace}
  .l{display:flex;white-space:pre;line-height:1.5}
  .l .n{width:48px;flex:none;text-align:right;padding-right:8px;color:#6f737a;user-select:none}
  .l .s{width:16px;flex:none;color:#6f737a;user-select:none}
  .l.add{background:rgba(95,184,101,.16)} .l.add .s{color:#5fb865}
  .l.del{background:rgba(247,84,100,.16)} .l.del .s{color:#f75464}
  </style></head><body><header><b>${esc(path.basename(file))}</b><span class="stat"><span class="a">+${adds}</span> <span class="d">−${dels}</span></span>
  <div class="path">${esc(file)}</div></header><main>${parts.join('') || '<p>Нет данных об изменениях.</p>'}</main></body></html>`;
}

/** Opens a separate window with what the given answers changed in the file. */
export function openDiffWindow(file: string, items: { turn: Turn; change: FileChange }[]) {
  const title = `Изменения: ${path.basename(file)}`;
  const dir = path.join(dataDir(), 'diffs');
  fs.mkdirSync(dir, { recursive: true });
  // Old diff pages are throwaway.
  for (const f of fs.readdirSync(dir)) {
    try {
      if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 24 * 3600_000) fs.rmSync(path.join(dir, f));
    } catch {
      /* in use */
    }
  }
  const page = path.join(dir, `diff-${Date.now()}.html`);
  fs.writeFileSync(page, render(file, items, title));
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    title,
    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: false },
  });
  void win.loadFile(page);
  return page;
}
