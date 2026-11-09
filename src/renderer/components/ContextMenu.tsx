import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  action: () => unknown;
  danger?: boolean;
  /** A submenu (opens on hover, like «Git ▸»). */
  sub?: MenuItem[];
  /** A separator line. */
  sep?: boolean;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 4), y: Math.min(y, window.innerHeight - r.height - 4) });
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (!(e.target as HTMLElement | null)?.closest?.('.ctx-menu')) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      <Items items={items} onClose={onClose} />
    </div>
  );
}

function Items({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const [open, setOpen] = useState<{ label: string; x: number; y: number } | null>(null);
  return (
    <>
      {items.map((it, i) =>
        it.sep ? (
          <div key={`sep${i}`} className="ctx-sep" />
        ) : (
          <div
            key={it.label}
            className={`ctx-item ${it.danger ? 'danger' : ''} ${it.sub ? 'has-sub' : ''} ${open?.label === it.label ? 'open' : ''}`}
            onMouseEnter={(e) => {
              if (!it.sub) return setOpen(null);
              const r = e.currentTarget.getBoundingClientRect();
              setOpen({ label: it.label, x: r.right - 2, y: r.top - 5 });
            }}
            onClick={() => {
              if (it.sub) return;
              onClose();
              void it.action();
            }}
          >
            {it.label}
            {it.sub && <span className="ctx-arrow">▸</span>}
          </div>
        ),
      )}
      {open && <SubMenu {...open} items={items.find((i) => i.label === open.label)?.sub ?? []} onClose={onClose} />}
    </>
  );
}

function SubMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    // no room on the right: open to the left of the parent menu
    const left = x + r.width > window.innerWidth - 4 ? Math.max(4, x - r.width - (ref.current!.parentElement?.getBoundingClientRect().width ?? 0) + 4) : x;
    setPos({ x: left, y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
  }, [x, y]);
  return (
    <div className="ctx-menu ctx-sub" ref={ref} style={{ left: pos.x, top: pos.y }}>
      <Items items={items} onClose={onClose} />
    </div>
  );
}
