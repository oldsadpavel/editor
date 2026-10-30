import { marked } from 'marked';
import { useMemo } from 'react';
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
const isPath = (raw: string) => (PATH_RE.test(raw) && /[\\/.]/.test(raw)) || ABS_PATH_RE.test(raw);

const RUN_RE = /^\s*!\s*(\S.*)$/;
const unescapeHtml = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e as string]!);

/** Absolute paths in plain text (E:\\dir\\file.ext, /home/…/file.ext) become links too. */
const TEXT_PATH_RE = /(?<![\p{L}\p{N}])((?:[A-Za-z]:[\\/]|(?<=\s|^)\/)[^\s<>"'`|?*,;]*[\\/][^\s<>"'`|?*,;]*\.[\p{L}\p{N}]{1,8})(?=[\s,.;:)!?»]*(?:\s|$|<))/gu;
const linkPaths = (html: string) => html.replace(TEXT_PATH_RE, (m) => `<span class="path-link" data-path="${m}">${m}</span>`);

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
      if (isPath(raw)) return `<code class="path-link" data-path="${escapeHtml(raw)}">${text}</code>`;
      return `<code>${text}</code>`;
    },
    link: ({ href, text }) => `<a href="${escapeHtml(href)}" target="_blank">${text}</a>`,
    // like marked's own text renderer (nested tokens, escaping) plus clickable absolute paths
    text(this: any, t: any) {
      if (t.tokens) return this.parser.parseInline(t.tokens);
      return linkPaths(t.escaped ? t.text : escapeHtml(t.text));
    },
  },
});

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
  let found = false;
  for (const el of Array.from(root.children)) {
    if (isTitle(el) || el.tagName === 'HR') {
      const kind = el.tagName === 'HR' ? undefined : sectionKind(el.textContent ?? '');
      box = null;
      if (kind) {
        box = doc.createElement('div');
        box.className = `md-sec sec-${kind}`;
        el.replaceWith(box);
        box.appendChild(el);
        found = true;
      }
      continue;
    }
    if (box) box.appendChild(el);
  }
  return found ? root.innerHTML : html;
}

export function Markdown({ text, cwd }: { text: string; cwd: string }) {
  const html = useMemo(() => markSections(marked.parse(text, { async: false }) as string), [text]);
  return (
    <div
      className="md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
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
