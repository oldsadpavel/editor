import { useState } from 'react';
import type { CacheCategory } from '../../shared/types';
import { call } from '../api';
import { saveApp, toast, useStore } from '../store';
import { basename, formatTime, plural } from '../util';
import { PanelFrame } from './Panels';

export function formatBytes(b: number) {
  if (b < 1024) return `${b} Б`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} КБ`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0)} МБ`;
  return `${(b / 1024 ** 3).toFixed(2)} ГБ`;
}

function CategoryRow({ c, busy, onClean }: { c: CacheCategory; busy: boolean; onClean: () => void }) {
  return (
    <tr className={c.safety}>
      <td>
        <div className="cat-title">
          {c.title} {c.safety === 'caution' && <span className="chip expiring">осторожно</span>}
        </div>
        <div className="cat-note">{c.note}</div>
        <div className="cat-paths">
          {c.paths.slice(0, 3).map((p) => (
            <span key={p} className="path-link" onClick={() => call('shell:reveal', p)} title="Показать в проводнике">
              {p}
            </span>
          ))}
          {c.paths.length > 3 && <span className="muted">+{c.paths.length - 3}</span>}
        </div>
      </td>
      <td className="num">{c.files.toLocaleString('ru-RU')}</td>
      <td className="num">{formatBytes(c.bytes)}</td>
      <td className="num">
        {c.cleanableBytes > 0 ? (
          <b className={c.safety === 'safe' ? 'ok' : ''}>{formatBytes(c.cleanableBytes)}</b>
        ) : (
          <span className="muted">—</span>
        )}
        <div className="muted small">
          {c.cleanableFiles > 0 && `${c.cleanableFiles.toLocaleString('ru-RU')} ${plural(c.cleanableFiles, 'файл', 'файла', 'файлов')}`}
          {c.days > 0 ? ` · старше ${c.days} дн.` : ' · кроме текущей'}
        </div>
      </td>
      <td>
        <button className={`btn small ${c.safety === 'safe' ? 'primary' : 'danger'}`} disabled={!c.cleanableBytes || busy} onClick={onClean}>
          {busy ? 'Чищу…' : 'Очистить'}
        </button>
      </td>
    </tr>
  );
}

export function CachePanel() {
  const report = useStore((s) => s.cache);
  const days = useStore((s) => s.app!.cacheDays ?? 7);
  const chatDays = useStore((s) => s.app!.cacheChatDays ?? 60);
  const [busy, setBusy] = useState<string | null>(null);

  const scan = async () => {
    setBusy('scan');
    try {
      await call('cache:scan');
    } finally {
      setBusy(null);
    }
  };

  const clean = async (c: CacheCategory) => {
    const msg =
      c.safety === 'caution'
        ? `Удалить ${c.cleanableFiles} старых чатов (${formatBytes(c.cleanableBytes)})?\nИх больше нельзя будет открыть и продолжить. Открытые и работающие чаты не трогаются.`
        : `Удалить ${c.cleanableFiles} файлов «${c.title}» (${formatBytes(c.cleanableBytes)})?`;
    if (!confirm(msg)) return;
    setBusy(c.id);
    try {
      const r = await call<{ freed: number; deleted: number; failed: number }>('cache:clean', c.id);
      toast(`Освобождено ${formatBytes(r.freed)}, удалено ${r.deleted}${r.failed ? `, не удалось ${r.failed} (заняты)` : ''}`);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const setDays = async (patch: { cacheDays?: number; cacheChatDays?: number }) => {
    await saveApp(patch);
    void scan();
  };

  const safeTotal = report?.categories.filter((c) => c.safety === 'safe').reduce((s, c) => s + c.cleanableBytes, 0) ?? 0;
  const total = report?.categories.reduce((s, c) => s + c.bytes, 0) ?? 0;
  const disk = report?.disk;
  const usedPct = disk ? Math.round((1 - disk.free / disk.total) * 100) : 0;

  return (
    <PanelFrame
      id="cache"
      title="Кеш ИИ"
      actions={
        <button className="btn small" disabled={!!busy} onClick={scan}>
          {busy === 'scan' ? 'Считаю…' : '⟳ Пересчитать'}
        </button>
      }
    >
      <div className="cache-summary">
        {disk && (
          <div className="disk">
            <div>
              Диск <b>{disk.path}</b>: свободно <b className={usedPct >= 90 ? 'bad' : ''}>{formatBytes(disk.free)}</b> из {formatBytes(disk.total)}
            </div>
            <div className="bar">
              <div className={`fill ${usedPct >= 90 ? 'bad' : usedPct >= 80 ? 'warn' : ''}`} style={{ width: `${usedPct}%` }} />
            </div>
          </div>
        )}
        <div className="cache-totals">
          Данные ИИ: <b>{formatBytes(total)}</b> · безопасно удалить: <b className="ok">{formatBytes(safeTotal)}</b>
          {report && <span className="muted"> · посчитано {formatTime(report.scannedAt)}</span>}
        </div>
        <div className="cache-days">
          Мусор — файлы старше
          <select value={days} onChange={(e) => setDays({ cacheDays: Number(e.target.value) })}>
            {[1, 3, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {d} дн.
              </option>
            ))}
          </select>
          чаты — старше
          <select value={chatDays} onChange={(e) => setDays({ cacheChatDays: Number(e.target.value) })}>
            {[14, 30, 60, 90, 180, 365].map((d) => (
              <option key={d} value={d}>
                {d} дн.
              </option>
            ))}
          </select>
        </div>
      </div>
      {report ? (
        <>
          <table className="grid cache-grid">
            <thead>
              <tr>
                <th>Что</th>
                <th className="num">Файлов</th>
                <th className="num">Занимает</th>
                <th className="num">Можно удалить</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {report.categories.map((c) => (
                <CategoryRow key={c.id} c={c} busy={busy === c.id} onClean={() => clean(c)} />
              ))}
            </tbody>
          </table>
          <div className="biggest-head">Самые большие</div>
          {report.biggest.map((b) => (
            <div key={b.path} className="big-row">
              <span className="num big-size">{formatBytes(b.bytes)}</span>
              <span className="path-link" title={b.path} onClick={() => call('shell:reveal', b.path)}>
                {basename(b.path)}
              </span>
              <span className="muted big-dir">{b.path.slice(0, -basename(b.path).length)}</span>
              <span className="muted">{formatTime(b.mtime)}</span>
              {b.cleanable ? (
                <button
                  className="icon-btn"
                  title="Удалить"
                  onClick={async () => {
                    if (!confirm(`Удалить ${b.path} (${formatBytes(b.bytes)})?`)) return;
                    await call('cache:delete', b.path).catch((e) => toast(e.message, 'error'));
                  }}
                >
                  🗑
                </button>
              ) : (
                <span className="muted small" title="Свежий, открыт в редакторе или текущая версия">
                  нужен
                </span>
              )}
            </div>
          ))}
        </>
      ) : (
        <div className="empty">{busy === 'scan' ? 'Считаю…' : 'Ещё не посчитано. Нажмите «Пересчитать».'}</div>
      )}
    </PanelFrame>
  );
}
