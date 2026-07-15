import { useEffect, useRef, useState } from 'react';
import type { BoardItem } from '../../types';
import { noteBg, priorityMeta } from './boardConfig';
import { api } from '../../lib/bridge';

// Image assets are loaded once per session; newly pasted/imported images are
// primed here so they render without a round-trip to disk.
const assetCache = new Map<string, string>();

export function primeAssetCache(projectId: string, assetId: string, dataUrl: string): void {
  assetCache.set(`${projectId}/${assetId}`, dataUrl);
}

function useAsset(projectId: string, assetId?: string): string | null {
  const key = `${projectId}/${assetId}`;
  const [url, setUrl] = useState<string | null>(assetId ? (assetCache.get(key) ?? null) : null);

  useEffect(() => {
    if (!assetId) return;
    const cached = assetCache.get(key);
    if (cached) {
      setUrl(cached);
      return;
    }
    let alive = true;
    api.pbGetAsset(projectId, assetId).then((u) => {
      if (u) assetCache.set(key, u);
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [projectId, assetId, key]);

  return url;
}

interface DragState {
  pointerId: number;
  kind: 'move' | 'resize';
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
  moved: boolean;
}

// One item on the board: a text note or an image. Drag the body to move,
// drag the corner handle to resize, double-click a note to edit it.
export function BoardItemView({
  projectId,
  item,
  selected,
  editing,
  onSelect,
  onPatch,
  onStartEdit,
  onStopEdit,
}: {
  projectId: string;
  item: BoardItem;
  selected: boolean;
  editing: boolean;
  onSelect: () => void;
  onPatch: (patch: Partial<BoardItem>, commit?: boolean) => void;
  onStartEdit: () => void;
  onStopEdit: () => void;
}) {
  const url = useAsset(projectId, item.type === 'image' ? item.assetId : undefined);
  const outerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);

  const beginDrag = (e: React.PointerEvent, kind: DragState['kind']) => {
    if (e.button !== 0) return;
    onSelect();
    if (editing) return;
    outerRef.current?.setPointerCapture(e.pointerId);
    drag.current = {
      pointerId: e.pointerId,
      kind,
      startX: e.clientX,
      startY: e.clientY,
      origX: item.x,
      origY: item.y,
      origW: item.w,
      origH: item.h,
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    if (!d.moved) return;
    if (d.kind === 'move') {
      onPatch({ x: Math.max(0, d.origX + dx), y: Math.max(0, d.origY + dy) }, false);
    } else {
      const minW = item.type === 'image' ? 60 : 140;
      onPatch({ w: Math.max(minW, d.origW + dx), h: Math.max(60, d.origH + dy) }, false);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    if (d.moved) onPatch({}, true); // commit the final position/size
  };

  const meta = priorityMeta(item.priority);
  const tint = item.type === 'text' ? noteBg(item.color) : '';

  return (
    <div
      ref={outerRef}
      className={`absolute select-none rounded-lg border shadow-sm ${
        selected ? 'border-accent ring-1 ring-accent/40' : 'border-edge'
      } ${item.type === 'text' ? 'bg-raised' : 'bg-raised/40'}`}
      style={{
        left: item.x,
        top: item.y,
        width: item.w,
        height: item.h,
        zIndex: item.z,
        backgroundColor: tint || undefined,
        // Let touch drags move the item instead of scrolling the canvas
        // (scroll by dragging the empty background instead).
        touchAction: editing ? 'auto' : 'none',
      }}
      onPointerDown={(e) => beginDrag(e, 'move')}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => {
        if (item.type === 'text') onStartEdit();
      }}
    >
      {(item.category || item.priority !== 'none') && (
        <div className="pointer-events-none absolute -top-2.5 left-2 z-10 flex max-w-[90%] gap-1">
          {item.category && (
            <span className="truncate rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-medium text-accent">
              {item.category}
            </span>
          )}
          {item.priority !== 'none' && (
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${meta.chip}`}>
              {meta.label}
            </span>
          )}
        </div>
      )}

      {item.type === 'text' ? (
        editing ? (
          <textarea
            autoFocus
            value={item.text ?? ''}
            placeholder="Type your idea…"
            onChange={(e) => onPatch({ text: e.target.value })}
            onBlur={onStopEdit}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
            className="h-full w-full select-text resize-none rounded-lg bg-transparent p-3 text-sm outline-none"
          />
        ) : (
          <div className="h-full w-full overflow-hidden whitespace-pre-wrap p-3 text-sm">
            {item.text || (
              <span className="text-muted">Empty note — double-click to edit</span>
            )}
          </div>
        )
      ) : url ? (
        <img src={url} draggable={false} className="h-full w-full rounded-lg object-contain" alt="" />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-muted">
          Loading image…
        </div>
      )}

      {selected && !editing && (
        <div
          title="Drag to resize"
          onPointerDown={(e) => {
            e.stopPropagation();
            beginDrag(e, 'resize');
          }}
          className="absolute -bottom-1.5 -right-1.5 h-4 w-4 cursor-nwse-resize rounded-sm border border-accent bg-bg"
        />
      )}
    </div>
  );
}
