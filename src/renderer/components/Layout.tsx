import { useState } from 'react';
import type { ColumnId, MainBlock } from '../../shared/types';
import { LAYOUT_PRESETS, get, moveBlock, setToolDock, setUi, useStore } from '../store';
import { ContextMenu, type MenuItem } from './ContextMenu';

const COLUMN_LABEL: Record<ColumnId, string> = { left: 'слева', center: 'в центр (самое большое место)', right: 'справа' };
export const BLOCK_LABEL: Record<MainBlock, string> = { tree: 'Проекты', chat: 'ИИ-чат', editor: 'Редактор' };
const DRAG_TYPE = 'application/x-editor-block';

export function presetItems(): MenuItem[] {
  const docked = get().app!.ui.toolDock === 'right';
  return [
    ...LAYOUT_PRESETS.map((p) => ({ label: `Раскладка: ${p.label}`, action: () => setUi({ layout: p.layout }) })),
    docked
      ? { label: 'Блоки (Ошибки, Настройка…) — вниз', action: () => setToolDock('bottom') }
      : { label: 'Блоки (Ошибки, Настройка…) — в правую колонку', action: () => setToolDock('right') },
  ];
}

/**
 * Grip in a main block's header: drag it onto another column to swap blocks, or click for a menu with the
 * target columns and layout presets.
 */
export function BlockHandle({ block }: { block: MainBlock }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const column = useStore((s) => (Object.keys(s.app!.ui.layout) as ColumnId[]).find((c) => s.app!.ui.layout[c] === block)!);
  const items: MenuItem[] = [
    ...(Object.keys(COLUMN_LABEL) as ColumnId[])
      .filter((c) => c !== column)
      .map((c) => ({ label: `Поставить ${COLUMN_LABEL[c]} (поменяться с «${BLOCK_LABEL[get().app!.ui.layout[c]]}»)`, action: () => moveBlock(block, c) })),
    ...presetItems(),
  ];
  return (
    <>
      <span
        className="block-handle"
        draggable
        title={`«${BLOCK_LABEL[block]}»: перетащите на другую колонку или нажмите, чтобы переставить`}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, block);
          e.dataTransfer.effectAllowed = 'move';
          document.body.classList.add('dragging-block');
        }}
        onDragEnd={() => document.body.classList.remove('dragging-block')}
        onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}
      >
        ⇄
      </span>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </>
  );
}

/** Wraps a layout column so a dragged block handle can be dropped onto it. */
export function DropColumn({ column, className, style, children }: { column: ColumnId; className: string; style?: React.CSSProperties; children: React.ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`${className} ${over ? 'drop-over' : ''}`}
      style={style}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        const block = e.dataTransfer.getData(DRAG_TYPE) as MainBlock;
        setOver(false);
        document.body.classList.remove('dragging-block');
        if (block) {
          e.preventDefault();
          moveBlock(block, column);
        }
      }}
    >
      {children}
    </div>
  );
}

export function LayoutButton() {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button className="tb-btn" title="Переставить блоки: пресеты раскладки" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY + 12 })}>
        <span className="tb-icon">▦</span>Раскладка ▾
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={presetItems()} onClose={() => setMenu(null)} />}
    </>
  );
}
