import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ContextMenu } from './ContextMenu';

/**
 * Middle-click closes a tab. Chromium starts auto-scroll on a middle mousedown and then swallows the click,
 * so mousedown is cancelled and the tab closes on mouseup.
 */
export function middleClose(close: () => void) {
  return {
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    },
    onMouseUp: (e: React.MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    },
  };
}

/**
 * A row of tabs that scrolls horizontally (mouse wheel too). When some tabs don't fit, a narrow «»N» button at the
 * end lists the hidden ones; picking one activates it and scrolls it into view. Tabs are the children and must carry
 * `data-tab-key` and `data-tab-label`.
 */
export function TabStrip({
  className,
  activeKey,
  onPick,
  lead,
  children,
}: {
  className: string;
  activeKey?: string;
  onPick: (key: string) => void;
  /** Fixed content before the scrolling row (e.g. a block handle). */
  lead?: React.ReactNode;
  children: React.ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<{ key: string; label: string }[]>([]);
  const [all, setAll] = useState<{ key: string; label: string; sort: number; hidden: boolean; unseen: boolean }[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const measure = () => {
    const el = row.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const out: { key: string; label: string }[] = [];
    const every: typeof all = [];
    for (const t of Array.from(el.querySelectorAll<HTMLElement>('[data-tab-key]'))) {
      const r = t.getBoundingClientRect();
      const off = r.left < box.left - 1 || r.right > box.right + 1;
      const item = { key: t.dataset.tabKey!, label: t.dataset.tabLabel ?? t.dataset.tabKey! };
      if (off) out.push(item);
      every.push({ ...item, sort: Number(t.dataset.tabSort ?? 0), hidden: off, unseen: t.classList.contains('unseen') });
    }
    setHidden((prev) => (prev.length === out.length && prev.every((p, i) => p.key === out[i].key) ? prev : out));
    setAll((prev) =>
      prev.length === every.length && prev.every((p, i) => p.key === every[i].key && p.label === every[i].label && p.sort === every[i].sort && p.hidden === every[i].hidden)
        ? prev
        : every,
    );
  };

  useLayoutEffect(measure);
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The active tab is always scrolled into view.
  useEffect(() => {
    if (!activeKey) return;
    const t = row.current?.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(activeKey)}"]`);
    t?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeKey]);

  return (
    <div className={`tabs tab-strip ${className}`}>
      {lead}
      <div
        className="tab-strip-row"
        ref={row}
        onScroll={measure}
        onWheel={(e) => {
          if (!e.deltaY || !row.current) return;
          row.current.scrollLeft += e.deltaY;
        }}
      >
        {children}
      </div>
      {(hidden.length > 0 || all.some((t) => t.unseen && t.hidden)) && (
        <button
          className={`tab-more ${all.some((t) => t.unseen && t.hidden) ? 'unseen' : ''}`}
          title={`Все открытые (недавно изменённые сверху). Не поместились: ${hidden.length}`}
          onClick={(e) => setMenu({ x: e.clientX, y: e.clientY + 10 })}
        >
          »{hidden.length}
        </button>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          // Recently changed first, then the rest in tab order; tabs out of view are marked.
          items={[...all]
            .sort((a, b) => b.sort - a.sort)
            .map((t) => ({ label: `${t.label}${t.hidden ? '' : '  ·  на экране'}`, action: () => onPick(t.key) }))}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
