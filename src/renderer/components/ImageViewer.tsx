import { useEffect, useState } from 'react';
import { call, fileUrl } from '../api';
import { openInSystem, set, toast, useStore, type LightboxItem } from '../store';
import { basename } from '../util';
import { formatBytes } from './CachePanel';

/** Path of the picture on disk; an image known only from a transcript is saved first so Paint can open it. */
async function ensurePath(item: LightboxItem): Promise<string | null> {
  if (item.path) return item.path;
  try {
    return await call<string>('attach:saveDataUrl', item.src);
  } catch (e: any) {
    toast(e.message, 'error');
    return null;
  }
}

function Toolbar({ item, info }: { item: LightboxItem; info?: string }) {
  const run = async (fn: (p: string) => Promise<unknown>) => {
    const p = await ensurePath(item);
    if (p) await fn(p).catch((e: any) => toast(e.message, 'error'));
  };
  return (
    <div className="iv-toolbar">
      {item.path && <span className="iv-name" title={item.path}>{basename(item.path)}</span>}
      {info && <span className="muted">{info}</span>}
      <div className="grow" />
      <button className="btn primary small" onClick={() => run((p) => call('image:edit', p))} title="Открыть в Paint; после сохранения картинка обновится здесь">
        🖌 Редактировать в Paint
      </button>
      <button className="btn small" onClick={() => run((p) => openInSystem(p))}>
        Открыть в системе
      </button>
      <button className="btn small" onClick={() => run((p) => call('shell:reveal', p))}>
        Показать в проводнике
      </button>
      <button className="btn small" onClick={() => run((p) => call('image:copy', p).then(() => toast('Картинка скопирована в буфер')))}>
        Копировать
      </button>
    </div>
  );
}

/** Picture with fit / 100% / Ctrl+wheel zoom on a checkerboard background. */
function Picture({ src, onInfo }: { src: string; onInfo?: (w: number, h: number) => void }) {
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  useEffect(() => setZoom('fit'), [src]);
  return (
    <div
      className={`iv-stage ${zoom === 'fit' ? 'fit' : ''}`}
      onWheel={(e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        setZoom((z) => Math.min(8, Math.max(0.1, (z === 'fit' ? 1 : z) * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
      }}
      onDoubleClick={() => setZoom((z) => (z === 'fit' ? 1 : 'fit'))}
      title="Двойной клик — 100% / вписать, Ctrl+колесо — масштаб"
    >
      <img
        src={src}
        alt=""
        style={zoom === 'fit' ? undefined : { width: `calc(var(--nw) * ${zoom})` }}
        onLoad={(e) => {
          const img = e.currentTarget;
          img.style.setProperty('--nw', img.naturalWidth + 'px');
          onInfo?.(img.naturalWidth, img.naturalHeight);
        }}
      />
      <div className="iv-zoom">
        <button className={`btn small ${zoom === 'fit' ? 'primary' : ''}`} onClick={() => setZoom('fit')}>
          Вписать
        </button>
        <button className={`btn small ${zoom === 1 ? 'primary' : ''}`} onClick={() => setZoom(1)}>
          100%
        </button>
        {zoom !== 'fit' && zoom !== 1 && <span className="muted">{Math.round(zoom * 100)}%</span>}
      </div>
    </div>
  );
}

/** Image file opened as an editor tab. */
export function ImageTab({ path, version, size }: { path: string; version: number; size?: number }) {
  const [dims, setDims] = useState<string>();
  const info = [dims, size !== undefined ? formatBytes(size) : undefined].filter(Boolean).join(' · ');
  return (
    <div className="image-tab">
      <Toolbar item={{ src: fileUrl(path, version), path }} info={info} />
      <Picture src={fileUrl(path, version)} onInfo={(w, h) => setDims(`${w}×${h}`)} />
    </div>
  );
}

/** Full-window viewer for chat attachments: ←/→ between pictures, Esc closes. */
export function ImageLightbox() {
  const lb = useStore((s) => s.lightbox);
  const [dims, setDims] = useState<string>();
  useEffect(() => {
    if (!lb) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') set({ lightbox: undefined });
      if (e.key === 'ArrowRight') set({ lightbox: { ...lb, index: (lb.index + 1) % lb.items.length } });
      if (e.key === 'ArrowLeft') set({ lightbox: { ...lb, index: (lb.index - 1 + lb.items.length) % lb.items.length } });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lb]);
  if (!lb) return null;
  const item = lb.items[lb.index];
  const many = lb.items.length > 1;
  return (
    <div className="modal-bg lightbox" onClick={() => set({ lightbox: undefined })}>
      <div className="lightbox-body" onClick={(e) => e.stopPropagation()}>
        <Toolbar item={item} info={[many ? `${lb.index + 1} из ${lb.items.length}` : '', dims].filter(Boolean).join(' · ')} />
        <div className="lightbox-stage">
          {many && (
            <button className="lb-nav prev" onClick={() => set({ lightbox: { ...lb, index: (lb.index - 1 + lb.items.length) % lb.items.length } })}>
              ‹
            </button>
          )}
          <Picture src={item.src} onInfo={(w, h) => setDims(`${w}×${h}`)} />
          {many && (
            <button className="lb-nav next" onClick={() => set({ lightbox: { ...lb, index: (lb.index + 1) % lb.items.length } })}>
              ›
            </button>
          )}
        </div>
        <button className="icon-btn lb-close" title="Закрыть (Esc)" onClick={() => set({ lightbox: undefined })}>
          ×
        </button>
      </div>
    </div>
  );
}
