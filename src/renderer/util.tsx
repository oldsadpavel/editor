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

const PATH_RE = /^(?:[A-Za-z]:)?[\w.\-\\/@]+\.[A-Za-z0-9]{1,8}(?::\d+)?$/;

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    // Raw HTML from the model is shown as text, never executed.
    html: ({ text }) => escapeHtml(text),
    codespan: ({ text }) => {
      const raw = text.replace(/&amp;/g, '&');
      if (PATH_RE.test(raw) && /[\\/.]/.test(raw)) return `<code class="path-link" data-path="${escapeHtml(raw)}">${text}</code>`;
      return `<code>${text}</code>`;
    },
    link: ({ href, text }) => `<a href="${escapeHtml(href)}" target="_blank">${text}</a>`,
  },
});

/** Opens `path` or `path:line` relative to the chat's project. */
export async function openPathLink(raw: string, cwd: string) {
  const m = raw.match(/^(.*?)(?::(\d+))?$/)!;
  const found = await call<string | null>('fs:resolve', cwd, m[1]);
  if (found) void openFile(found, m[2] ? Number(m[2]) : undefined);
  else toast(`Файл не найден: ${m[1]}`, 'error');
}

export function Markdown({ text, cwd }: { text: string; cwd: string }) {
  const html = useMemo(() => marked.parse(text, { async: false }) as string, [text]);
  return (
    <div
      className="md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
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
