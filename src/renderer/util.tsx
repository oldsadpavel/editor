import { marked } from 'marked';
import { useContext, useMemo } from 'react';
import { TurnContext, parseDue, remindFrom } from './components/Tasks';
import { call } from './api';
import { openFile, set, toast } from './store';

export const basename = (p: string) => p.split(/[\\/]/).pop() || p;
export const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, '');

export function relPath(p: string, root?: string) {
  if (root && p.toLowerCase().startsWith(root.toLowerCase())) return p.slice(root.length).replace(/^[\\/]/, '') || basename(p);
  return p;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** «сегодня 14:32», «вчера 09:10», «27.10 18:01», «27.10.2025 18:01». */
export function formatTime(ms?: number) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86_400_000;
  if (diff === 0) return `сегодня ${hm}`;
  if (diff === 1) return `вчера ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${hm}`;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${hm}`;
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} мс`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} мин ${s % 60} с` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

export const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * A file path in `code`: any letters (Cyrillic file names too), an extension, optional :line. Spaces only in
 * absolute paths (E:\\…, /…), so ordinary code with spaces isn't taken for a path.
 */
const PATH_RE = /^(?:[A-Za-z]:)?[\p{L}\p{N}_.\-\\/@()+]+\.[\p{L}\p{N}]{1,8}(?::\d+)?$/u;
const ABS_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/|~\/)[^<>"|?*\n]+\.[\p{L}\p{N}]{1,8}(?::\d+)?$/u;
/**
 * Extensions a bare name (no folder) must have to count as a file — so smtp.office365.com, mail.ru or a version
 * like v1.2 stay text. With a folder in it (src/a.ts, app/1с/x.txt) any extension goes.
 */
const FILE_EXT = new Set(
  ('txt md mdx log csv tsv json jsonl yml yaml toml ini cfg conf env xml html htm css scss less sass js mjs cjs jsx ts tsx ' +
    'vue svelte php phtml blade py rb go rs java kt kts cs cpp cc c h hpp swift sql sh bash zsh ps1 psm1 bat cmd ' +
    'lock gradle properties dockerfile makefile bsl os epf erf cf cfe mxl xlsx xls docx doc pdf odt ods pptx png jpg jpeg ' +
    'gif webp svg ico bmp zip rar 7z gz tar exe dll msi apk ipa').split(' '),
);
const isPath = (raw: string) => {
  if (ABS_PATH_RE.test(raw)) return true;
  if (!PATH_RE.test(raw) || !/[\\/.]/.test(raw) || raw.includes('@')) return false;
  if (/[\\/]/.test(raw)) return true;
  const ext = raw.replace(/:\d+$/, '').split('.').pop()!.toLowerCase();
  return FILE_EXT.has(ext);
};

const RUN_RE = /^\s*!\s*(\S.*)$/;
const unescapeHtml = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e as string]!);

/** Absolute paths in plain text (E:\\dir\\file.ext, /home/…/file.ext) become links too. */
const TEXT_PATH_RE = /(?<![\p{L}\p{N}])((?:[A-Za-z]:[\\/]|(?<=\s|^)\/)[^\s<>"'`|?*,;]*[\\/][^\s<>"'`|?*,;]*\.[\p{L}\p{N}]{1,8})(?=[\s,.;:)!?»]*(?:\s|$|<))/gu;
const copyButton = (path: string) => `<button class="copy-file" data-copy="${path}" title="Скопировать весь текст файла в буфер">⧉</button>`;
/** ⧉ after inline code that isn't a file: copies the text itself (a host, an address, a command, a hash). */
const copyTextButton = (text: string) => `<button class="copy-file" data-copy-text="${text}" title="Скопировать в буфер">⧉</button>`;
const linkPaths = (html: string) => html.replace(TEXT_PATH_RE, (m) => `<span class="path-link" data-path="${m}">${m}</span>${copyButton(m)}`);

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    // Raw HTML from the model is shown as text, never executed.
    html: ({ text }) => escapeHtml(text),
    // a command Claude asks the user to run (`! cmd`, Claude Code's bash mode): ▶ runs it in this chat
    code: ({ text }) => {
      if (!text.split('\n').some((l) => RUN_RE.test(l))) return false;
      const body = text
        .split('\n')
        .map((l) => {
          const m = l.match(RUN_RE);
          return m ? `<span class="run-line">${escapeHtml(l)}<button class="run-cmd" data-run="${escapeHtml(m[1].trim())}" title="Выполнить в этом чате">▶ выполнить</button></span>` : escapeHtml(l);
        })
        .join('\n');
      return `<pre><code>${body}</code></pre>\n`;
    },
    codespan: ({ text }) => {
      const raw = unescapeHtml(text);
      const run = raw.match(RUN_RE);
      if (run) return `<code class="run-inline" data-run="${escapeHtml(run[1].trim())}" title="Клик — выполнить в этом чате">${text}</code>`;
      if (isPath(raw)) return `<code class="path-link" data-path="${escapeHtml(raw)}">${text}</code>${copyButton(escapeHtml(raw))}`;
      return raw.trim().length >= 3 ? `<code>${text}</code>${copyTextButton(escapeHtml(raw))}` : `<code>${text}</code>`;
    },
    image: ({ href, text }) => {
      let path = href;
      try {
        path = decodeURIComponent(href);
      } catch {
        /* as is */
      }
      const src = /^(?:[A-Za-z]:[\\/]|\/)/.test(path) ? `efile:///${encodeURIComponent(path)}` : href;
      return `<img class="md-img" src="${escapeHtml(src)}" alt="${escapeHtml(text)}">`;
    },
    link: ({ href, text }) => `<a href="${escapeHtml(href)}" target="_blank">${text}</a>`,
    // like marked's own text renderer (nested tokens, escaping) plus clickable absolute paths
    text(this: any, t: any) {
      if (t.tokens) return this.parser.parseInline(t.tokens);
      return linkPaths(t.escaped ? t.text : escapeHtml(t.text));
    },
  },
});

/** The whole text of a file from an answer's link goes to the clipboard. */
export async function copyFileText(raw: string, cwd: string) {
  const rel = raw.replace(/:\d+$/, '');
  const found = await call<string | null>('fs:resolve', cwd, rel);
  if (!found) return toast(`Файл не найден: ${rel}`, 'error');
  try {
    const f = await call<{ text: string; binary: boolean }>('fs:read', found);
    if (f.binary) return toast(`${basename(found)} — не текстовый файл, скопировать текст нельзя`, 'error');
    await navigator.clipboard.writeText(f.text);
    const lines = f.text ? f.text.split('\n').length : 0;
    toast(`Скопировано в буфер: ${basename(found)} — ${lines} ${plural(lines, 'строка', 'строки', 'строк')}`);
  } catch (e: any) {
    toast(e.message, 'error');
  }
}

/** Opens `path` or `path:line` relative to the chat's project. */
export async function openPathLink(raw: string, cwd: string) {
  const m = raw.match(/^(.*?)(?::(\d+))?$/)!;
  const found = await call<string | null>('fs:resolve', cwd, m[1]);
  if (found) void openFile(found, m[2] ? Number(m[2]) : undefined);
  else toast(`Файл не найден: ${m[1]}`, 'error');
}

/** Section headings in answers: what the user has to do, what's left / unchecked, what was done. */
const SECTION_KINDS: [string, RegExp][] = [
  ['warn', /не сделано|не проверено|не провер|осталось|риски|внимание|ограничени|не работает|не удалось|известные проблемы/],
  ['action', /тебе|вам |вам$|от вас|от тебя|что делать|что сделать|нужно сделать|сделать вручную|ваши действия|твои действия|ваш ход|твой ход|запусти|выполни|проверь(те)? сам|на вашей стороне|ручн/],
  ['done', /что сделано|^сделано|итог|готово|что изменено|изменения/],
];
const sectionKind = (title: string) => {
  const t = title.toLowerCase().replace(/[^\p{L}\p{N} /]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return t.length <= 60 ? SECTION_KINDS.find(([, re]) => re.test(t))?.[0] : undefined;
};

/**
 * Wraps "👉 Тебе сделать" / "Что нужно от вас:", "Не сделано / не проверено", "Что сделано" (a heading, or a short
 * paragraph ending with ":" / all in bold) together with what follows, up to the next heading, into a coloured block.
 */
function markSections(html: string) {
  if (!/<h\d|<p>/.test(html)) return html;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild!;
  const isTitle = (el: Element) => {
    if (/^H[1-6]$/.test(el.tagName)) return true;
    if (el.tagName !== 'P') return false;
    const text = el.textContent?.trim() ?? '';
    const onlyBold = el.children.length === 1 && el.firstElementChild!.tagName === 'STRONG' && el.firstElementChild!.textContent?.trim() === text;
    return text.length <= 60 && (text.endsWith(':') || onlyBold);
  };
  let box: Element | null = null;
  /** How strong the title that opened the box is: h1 = 1 … h6 = 6, a bold / «…:» paragraph = 7. */
  let boxLevel = 0;
  let found = false;
  for (const el of Array.from(root.children)) {
    if (isTitle(el) || el.tagName === 'HR') {
      const kind = el.tagName === 'HR' ? undefined : sectionKind(el.textContent ?? '');
      const level = /^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : 7;
      // a sub-title of its own ("Способ 1 — по ссылке:") stays inside the block it belongs to
      if (box && !kind && el.tagName !== 'HR' && (level > boxLevel || level === 7)) {
        box.appendChild(el);
        continue;
      }
      box = null;
      if (kind) {
        boxLevel = level;
        box = doc.createElement('div');
        box.className = `md-sec sec-${kind}`;
        el.replaceWith(box);
        box.appendChild(el);
        // what the user has to do can become a task with a reminder
        if (kind === 'action') {
          const b = doc.createElement('button');
          b.className = 'sec-remind';
          b.dataset.remind = '1';
          b.title = 'Создать задачу с напоминанием из этого блока';
          b.textContent = '⏰ Напомнить';
          box.appendChild(b);
        }
        found = true;
      }
      continue;
    }
    if (box) box.appendChild(el);
  }
  // «⏰ Напомнить» only where the block names a time («завтра», «05.11», «в 18:00»): the heading and the first lines
  root.querySelectorAll('.sec-action').forEach((sec) => {
    const lines = [...sec.children].filter((c) => !c.classList.contains('sec-remind')).slice(0, 2).map((c) => c.textContent ?? '');
    if (!parseDue(lines.join(' '))) sec.querySelector('.sec-remind')?.remove();
  });
  return found ? root.innerHTML : html;
}

export function Markdown({ text, cwd }: { text: string; cwd: string }) {
  const turnCtx = useContext(TurnContext);
  const html = useMemo(() => markSections(marked.parse(text, { async: false }) as string), [text]);
  return (
    <div
      className="md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const remind = (e.target as HTMLElement).closest('[data-remind]') as HTMLElement | null;
        if (remind) {
          // the block on screen (a detached copy would lose its line breaks in innerText)
          const sec = remind.closest('.md-sec') as HTMLElement;
          return remindFrom(turnCtx, sec.innerText.replace('⏰ Напомнить', '').replace(/\n{3,}/g, '\n\n').trim(), sec);
        }
        const copyText = (e.target as HTMLElement).closest('[data-copy-text]') as HTMLElement | null;
        if (copyText) return void navigator.clipboard.writeText(copyText.dataset.copyText!).then(() => toast(`Скопировано: ${copyText.dataset.copyText!.slice(0, 60)}`));
        const copy = (e.target as HTMLElement).closest('[data-copy]') as HTMLElement | null;
        if (copy) return void copyFileText(copy.dataset.copy!, cwd);
        const run = (e.target as HTMLElement).closest('[data-run]') as HTMLElement | null;
        if (run) return void window.dispatchEvent(new CustomEvent('chat-run', { detail: run.dataset.run }));
        const el = (e.target as HTMLElement).closest('[data-path]') as HTMLElement | null;
        if (el) void openPathLink(el.dataset.path!, cwd);
      }}
    />
  );
}

export function Help({ id }: { id: string }) {
  return (
    <button className="icon-btn help-btn" title="Инструкция" onClick={(e) => {
        e.stopPropagation();
        set({ help: id });
      }}>
      ?
    </button>
  );
}
