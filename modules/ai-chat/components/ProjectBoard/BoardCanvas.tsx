import { useEffect, useMemo, useRef, useState } from 'react';
import type { BoardData, BoardItem, BoardPriority, BoardStroke } from '../../types';
import { useProjectBoardStore } from '../../store/projectBoardStore';
import { BoardItemView, primeAssetCache } from './BoardItemView';
import { NOTE_COLORS, PEN_COLORS, PEN_SIZES, PRIORITIES } from './boardConfig';
import { api } from '../../lib/bridge';

type Tool = 'select' | 'text' | 'draw' | 'erase';

// The canvas grows to fit whatever is placed on it, with room to keep going.
const MIN_W = 2400;
const MIN_H = 1600;
const MARGIN = 600;

function measureImage(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 320, h: img.naturalHeight || 240 });
    img.onerror = () => resolve({ w: 320, h: 240 });
    img.src = dataUrl;
  });
}

// A freeform OneNote-style surface: notes and images live anywhere, ink is
// drawn on an SVG overlay above them. Double-click empty space for a note,
// paste (Ctrl+V) for screenshots.
export function BoardCanvas({ projectId, board }: { projectId: string; board: BoardData }) {
  const updateBoard = useProjectBoardStore((s) => s.updateBoard);
  const setOpen = useProjectBoardStore((s) => s.setOpen);

  const [tool, setTool] = useState<Tool>('select');
  const [penColor, setPenColor] = useState(PEN_COLORS[0]);
  const [penSize, setPenSize] = useState(PEN_SIZES[1]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [currentStroke, setCurrentStroke] = useState<BoardStroke | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inkingRef = useRef(false);
  const erasedRef = useRef(false);

  const size = useMemo(() => {
    let w = MIN_W;
    let h = MIN_H;
    for (const i of board.items) {
      w = Math.max(w, i.x + i.w + MARGIN);
      h = Math.max(h, i.y + i.h + MARGIN);
    }
    for (const s of board.strokes) {
      for (const [x, y] of s.points) {
        w = Math.max(w, x + MARGIN);
        h = Math.max(h, y + MARGIN);
      }
    }
    return { w, h };
  }, [board]);

  const selectedItem = board.items.find((i) => i.id === selectedId) ?? null;
  const nextZ = () => board.items.reduce((m, i) => Math.max(m, i.z), 0) + 1;

  const patchItem = (id: string, patch: Partial<BoardItem>, commit = true) =>
    updateBoard(
      (b) => ({ ...b, items: b.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }),
      commit
    );

  const removeItem = (id: string) => {
    updateBoard((b) => ({ ...b, items: b.items.filter((i) => i.id !== id) }));
    setSelectedId((cur) => (cur === id ? null : cur));
    setEditingId((cur) => (cur === id ? null : cur));
  };

  const addTextNote = (x: number, y: number, text = '') => {
    const item: BoardItem = {
      id: crypto.randomUUID(),
      type: 'text',
      x: Math.max(0, x),
      y: Math.max(0, y),
      w: 240,
      h: 130,
      z: nextZ(),
      text,
      color: 'default',
      category: '',
      priority: 'none',
    };
    updateBoard((b) => ({ ...b, items: [...b.items, item] }));
    setSelectedId(item.id);
    if (!text) setEditingId(item.id);
  };

  const addImageItem = async (assetId: string, dataUrl: string, cx: number, cy: number) => {
    primeAssetCache(projectId, assetId, dataUrl);
    const dims = await measureImage(dataUrl);
    const k = Math.min(1, 480 / dims.w, 380 / dims.h);
    const w = Math.max(60, Math.round(dims.w * k));
    const h = Math.max(60, Math.round(dims.h * k));
    const item: BoardItem = {
      id: crypto.randomUUID(),
      type: 'image',
      assetId,
      x: Math.max(0, cx - w / 2),
      y: Math.max(0, cy - h / 2),
      w,
      h,
      z: nextZ(),
      category: '',
      priority: 'none',
    };
    updateBoard((b) => ({ ...b, items: [...b.items, item] }));
    setSelectedId(item.id);
  };

  const viewportCenter = () => {
    const el = scrollRef.current;
    if (!el) return { x: 300, y: 300 };
    return { x: el.scrollLeft + el.clientWidth / 2, y: el.scrollTop + el.clientHeight / 2 };
  };

  const importImage = async () => {
    const res = await api.pbImportImage(projectId);
    if (!res) return;
    const c = viewportCenter();
    await addImageItem(res.assetId, res.dataUrl, c.x, c.y);
  };

  // Remember a category so it shows in the datalist next time.
  const commitCategory = (value: string) => {
    const v = value.trim();
    if (!v) return;
    updateBoard((b) => (b.categories.includes(v) ? b : { ...b, categories: [...b.categories, v] }));
  };

  // Paste: screenshots become image items, plain text becomes a note.
  // Re-registered every render so the handlers never close over stale state.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea')) return;
      const data = e.clipboardData;
      if (!data) return;
      const image = Array.from(data.items).find((i) => i.type.startsWith('image/'));
      if (image) {
        e.preventDefault();
        const file = image.getAsFile();
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result as string;
          const { assetId } = await api.pbSaveAsset(projectId, dataUrl);
          const c = viewportCenter();
          await addImageItem(assetId, dataUrl, c.x, c.y);
        };
        reader.readAsDataURL(file);
        return;
      }
      const text = data.getData('text/plain');
      if (text.trim()) {
        e.preventDefault();
        const c = viewportCenter();
        addTextNote(c.x - 120, c.y - 65, text.trim());
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[data-pb-modal]')) return;
      const target = e.target as HTMLElement | null;
      const typing = target?.closest('input, textarea, select');
      if (e.key === 'Escape') {
        if (typing) return;
        if (editingId) setEditingId(null);
        else if (selectedId) setSelectedId(null);
        else setOpen(false);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !editingId && !typing) {
        removeItem(selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ----- Ink (draw / erase) -----

  const svgPoint = (e: React.PointerEvent<SVGSVGElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [Math.round(e.clientX - rect.left), Math.round(e.clientY - rect.top)];
  };

  const eraseAt = ([x, y]: [number, number]) => {
    updateBoard((b) => {
      const keep = b.strokes.filter(
        (s) => !s.points.some(([px, py]) => Math.hypot(px - x, py - y) <= Math.max(14, s.size * 2))
      );
      if (keep.length === b.strokes.length) return b;
      erasedRef.current = true;
      return { ...b, strokes: keep };
    }, false);
  };

  const svgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    inkingRef.current = true;
    const pt = svgPoint(e);
    if (tool === 'draw') {
      setCurrentStroke({ id: crypto.randomUUID(), color: penColor, size: penSize, points: [pt] });
    } else if (tool === 'erase') {
      erasedRef.current = false;
      eraseAt(pt);
    }
  };

  const svgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!inkingRef.current) return;
    const pt = svgPoint(e);
    if (tool === 'draw') setCurrentStroke((s) => (s ? { ...s, points: [...s.points, pt] } : s));
    else if (tool === 'erase') eraseAt(pt);
  };

  const svgPointerUp = () => {
    if (!inkingRef.current) return;
    inkingRef.current = false;
    if (tool === 'draw' && currentStroke) {
      // A click without movement still leaves a visible dot.
      const stroke =
        currentStroke.points.length === 1
          ? {
              ...currentStroke,
              points: [
                ...currentStroke.points,
                [currentStroke.points[0][0] + 0.5, currentStroke.points[0][1]] as [number, number],
              ],
            }
          : currentStroke;
      updateBoard((b) => ({ ...b, strokes: [...b.strokes, stroke] }));
      setCurrentStroke(null);
    } else if (tool === 'erase' && erasedRef.current) {
      updateBoard((b) => ({ ...b }), true); // commit the erasures
    }
  };

  // ----- Background (empty canvas space) -----

  const backgroundPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // ignore events bubbling from items
    if (tool === 'text') {
      const rect = e.currentTarget.getBoundingClientRect();
      addTextNote(e.clientX - rect.left, e.clientY - rect.top - 16);
      setTool('select');
      return;
    }
    setSelectedId(null);
    setEditingId(null);
  };

  const backgroundDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    addTextNote(e.clientX - rect.left, e.clientY - rect.top - 16);
  };

  const inkMode = tool === 'draw' || tool === 'erase';

  const toolButton = (t: Tool, label: string) => (
    <button
      key={t}
      onClick={() => setTool(t)}
      className={`rounded-lg px-2.5 py-1.5 text-sm ${
        tool === t ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-raised hover:text-ink'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-edge bg-surface px-3 py-2">
        {toolButton('select', '✥ Select')}
        {toolButton('text', '📝 Note')}
        {toolButton('draw', '✏️ Draw')}
        {toolButton('erase', '🧽 Erase')}
        <div className="mx-1 h-5 w-px bg-edge" />
        <button
          onClick={importImage}
          className="rounded-lg px-2.5 py-1.5 text-sm text-muted hover:bg-raised hover:text-ink"
        >
          🖼 Add image
        </button>
        {tool === 'draw' && (
          <>
            <div className="mx-1 h-5 w-px bg-edge" />
            {PEN_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setPenColor(c)}
                title="Pen color"
                className={`h-5 w-5 rounded-full border-2 ${
                  penColor === c ? 'border-accent' : 'border-transparent'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
            <div className="mx-1 h-5 w-px bg-edge" />
            {PEN_SIZES.map((s) => (
              <button
                key={s}
                onClick={() => setPenSize(s)}
                title={`Pen size ${s}`}
                className={`flex h-7 w-7 items-center justify-center rounded-lg ${
                  penSize === s ? 'bg-accent/20' : 'hover:bg-raised'
                }`}
              >
                <span
                  className="rounded-full"
                  style={{ width: s + 3, height: s + 3, backgroundColor: penColor }}
                />
              </button>
            ))}
          </>
        )}
        <span className="ml-auto hidden text-xs text-muted xl:block">
          Double-click the canvas for a note · Ctrl+V pastes screenshots
        </span>
      </div>

      {/* Canvas */}
      <div ref={scrollRef} className="relative flex-1 overflow-auto">
        <div
          className="relative"
          style={{
            width: size.w,
            height: size.h,
            cursor: tool === 'text' ? 'text' : 'default',
            backgroundImage: 'radial-gradient(circle, rgb(var(--c-edge) / 0.7) 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
          onPointerDown={backgroundPointerDown}
          onDoubleClick={backgroundDoubleClick}
        >
          {board.items.map((item) => (
            <BoardItemView
              key={item.id}
              projectId={projectId}
              item={item}
              selected={selectedId === item.id}
              editing={editingId === item.id}
              onSelect={() => setSelectedId(item.id)}
              onPatch={(patch, commit) => patchItem(item.id, patch, commit)}
              onStartEdit={() => {
                setSelectedId(item.id);
                setEditingId(item.id);
              }}
              onStopEdit={() => setEditingId((cur) => (cur === item.id ? null : cur))}
            />
          ))}

          {/* Ink overlay — above items so you can draw on anything. */}
          <svg
            width={size.w}
            height={size.h}
            className="absolute left-0 top-0"
            style={{
              zIndex: 9000,
              pointerEvents: inkMode ? 'auto' : 'none',
              cursor: tool === 'erase' ? 'cell' : 'crosshair',
              // Without this, touch devices pan/scroll instead of drawing.
              touchAction: inkMode ? 'none' : 'auto',
            }}
            onPointerDown={svgPointerDown}
            onPointerMove={svgPointerMove}
            onPointerUp={svgPointerUp}
          >
            {[...board.strokes, ...(currentStroke ? [currentStroke] : [])].map((s) => (
              <polyline
                key={s.id}
                points={s.points.map((p) => p.join(',')).join(' ')}
                stroke={s.color}
                strokeWidth={s.size}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          </svg>

          {/* Floating toolbar for the selected item */}
          {selectedItem && !editingId && tool === 'select' && (
            <div
              className="absolute flex items-center gap-1.5 rounded-lg border border-edge bg-surface p-1 shadow-lg"
              style={{ left: selectedItem.x, top: Math.max(4, selectedItem.y - 46), zIndex: 9500 }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <select
                title="Priority"
                value={selectedItem.priority}
                onChange={(e) =>
                  patchItem(selectedItem.id, { priority: e.target.value as BoardPriority })
                }
                className="rounded border border-edge bg-raised px-1 py-1 text-xs outline-none"
              >
                {PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.value === 'none' ? 'Priority…' : p.label}
                  </option>
                ))}
              </select>
              <input
                list="pb-categories"
                value={selectedItem.category}
                placeholder="Category"
                onChange={(e) => patchItem(selectedItem.id, { category: e.target.value })}
                onBlur={(e) => commitCategory(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitCategory((e.target as HTMLInputElement).value);
                }}
                className="w-28 rounded border border-edge bg-raised px-1.5 py-1 text-xs outline-none"
              />
              {selectedItem.type === 'text' &&
                NOTE_COLORS.map((c) => (
                  <button
                    key={c.key}
                    title={c.label}
                    onClick={() => patchItem(selectedItem.id, { color: c.key })}
                    className={`h-4 w-4 flex-shrink-0 rounded-full border ${
                      (selectedItem.color ?? 'default') === c.key ? 'border-accent' : 'border-edge'
                    }`}
                    style={{ backgroundColor: c.dot }}
                  />
                ))}
              <button
                title="Bring to front"
                onClick={() => patchItem(selectedItem.id, { z: nextZ() })}
                className="rounded px-1.5 py-0.5 text-xs hover:bg-raised"
              >
                ⬆️
              </button>
              <button
                title="Delete"
                onClick={() => removeItem(selectedItem.id)}
                className="rounded px-1.5 py-0.5 text-xs hover:bg-raised"
              >
                🗑
              </button>
            </div>
          )}
          <datalist id="pb-categories">
            {board.categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
      </div>
    </div>
  );
}
