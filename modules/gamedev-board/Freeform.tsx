import { useEffect, useRef, useState } from 'react'
import { GripVertical, ImagePlus, MousePointer2, MoveUpRight, Pencil, Trash2 } from 'lucide-react'
import { imgUrl, useBoard, type CanvasItem } from './store'
import { ConfirmModal } from './Modals'

/**
 * Freeform board: the one and only board view. Click anywhere to type, paste an
 * image where you last clicked, draw freehand with the pen, drop arrows and drag
 * their endpoints around. Text boxes are renameable (click the header label) and
 * support per-line styles (heading / subheading / body + color) via the "A" menu.
 * Every change persists to IndexedDB. All item fields are additive — updates
 * never migrate or wipe existing data.
 */

const MIN_W = 90
const MIN_H = 50

/** Stroke colors for pen + arrows. Ink follows the theme; the rest are fixed. */
const STROKE_COLORS = [
  { name: 'Ink', value: 'rgb(var(--wk-ink))' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Amber', value: '#f59e0b' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Purple', value: '#a855f7' }
]

/** Text colors offered by the "A" formatting menu. */
const TEXT_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#9ca3af']

export default function Freeform({ folderId }: { folderId: string }): React.JSX.Element {
  // Select the stable array reference, then filter in render. Filtering INSIDE
  // the selector returns a new array on every call, which makes zustand v5's
  // useSyncExternalStore see an ever-changing snapshot → infinite re-render
  // (React #185). Keep derived arrays out of the selector.
  const items = useBoard((s) => s.canvasItems).filter((i) => i.folderId === folderId)
  const addText = useBoard((s) => s.addCanvasText)
  const addImage = useBoard((s) => s.addCanvasImage)
  const addStroke = useBoard((s) => s.addCanvasStroke)
  const addArrow = useBoard((s) => s.addCanvasArrow)
  const del = useBoard((s) => s.deleteCanvasItem)
  const undo = useBoard((s) => s.undoCanvas)
  const redoAction = useBoard((s) => s.redoCanvas)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // where the last click / paste landed, so new items appear near the cursor
  const lastPoint = useRef({ x: 60, y: 60 })
  // id of a freshly-created note to auto-focus so you can type immediately
  const [focusId, setFocusId] = useState<string | null>(null)
  const [mode, setMode] = useState<'select' | 'draw'>('select')
  const [penColor, setPenColor] = useState(STROKE_COLORS[0].value)
  // live pen stroke while the pointer is down (canvas coordinates)
  const [liveStroke, setLiveStroke] = useState<number[] | null>(null)
  const strokePts = useRef<number[] | null>(null)
  const [confirmDel, setConfirmDel] = useState<CanvasItem | null>(null)

  // Click empty canvas → drop a note there and focus it.
  const addNoteAt = (clientX: number, clientY: number): void => {
    const p = pointFromEvent(clientX, clientY)
    lastPoint.current = p
    void addText(folderId, p.x, p.y).then((it) => setFocusId(it.id))
  }

  const pointFromEvent = (clientX: number, clientY: number): { x: number; y: number } => {
    const el = scrollRef.current
    if (!el) return { x: 60, y: 60 }
    const r = el.getBoundingClientRect()
    return { x: Math.max(0, clientX - r.left + el.scrollLeft), y: Math.max(0, clientY - r.top + el.scrollTop) }
  }

  // Escape leaves draw mode.
  useEffect(() => {
    if (mode !== 'draw') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMode('select')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mode])

  // Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y): undo / redo canvas actions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const k = e.key.toLowerCase()
      if (k !== 'z' && k !== 'y') return
      const isRedo = k === 'y' || e.shiftKey
      const ae = document.activeElement as HTMLElement | null
      const editable =
        !!ae && (ae.isContentEditable || ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')
      if (editable) {
        const cvId = ae.getAttribute('data-cv-id')
        if (!cvId) return // rename input, modals, other fields → native undo
        const it = useBoard.getState().canvasItems.find((i) => i.id === cvId)
        // Typing in a box that has content → the editor's native text undo.
        // An accidental still-empty box → fall through and remove it.
        if (it && (it.text ?? '').trim()) return
      }
      e.preventDefault()
      void (isRedo ? redoAction(folderId) : undo(folderId))
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [folderId, undo, redoAction])

  // Paste an image straight onto the canvas.
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent): Promise<void> => {
      // Look for an image on the clipboard. If there's none we do nothing, so a
      // plain text paste falls through to whatever editor currently has focus.
      let blob: File | null = null
      for (const it of Array.from(e.clipboardData?.items ?? [])) {
        if (it.type.startsWith('image/')) {
          const f = it.getAsFile()
          if (f) {
            blob = f
            break
          }
        }
      }
      if (!blob) return
      e.preventDefault()

      // Where the image lands: the last spot you clicked. If the caret is in a
      // fresh, still-empty note (you clicked a spot then pasted instead of
      // typing), reuse that note's spot and delete the empty note — so the image
      // lands exactly where you clicked with nothing left over.
      let { x, y } = lastPoint.current
      const active = document.activeElement as HTMLElement | null
      const activeId = active?.getAttribute('data-cv-id') ?? null
      if (activeId) {
        const note = useBoard.getState().canvasItems.find((i) => i.id === activeId)
        if (note && note.kind === 'text' && !note.title && !(note.text ?? '').trim()) {
          x = note.x
          y = note.y
          await del(activeId, { silent: true })
        }
      }
      await addImage(folderId, blob, x, y)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [folderId, addImage, del])

  /* ------------------------------ pen drawing ------------------------------ */

  const onDrawDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const p = pointFromEvent(e.clientX, e.clientY)
    strokePts.current = [p.x, p.y]
    setLiveStroke([p.x, p.y])
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onDrawMove = (e: React.PointerEvent): void => {
    const pts = strokePts.current
    if (!pts) return
    const p = pointFromEvent(e.clientX, e.clientY)
    const lx = pts[pts.length - 2]
    const ly = pts[pts.length - 1]
    if (Math.hypot(p.x - lx, p.y - ly) < 3) return
    pts.push(p.x, p.y)
    setLiveStroke([...pts])
  }
  const onDrawUp = (): void => {
    const pts = strokePts.current
    strokePts.current = null
    setLiveStroke(null)
    if (!pts || pts.length < 4) return
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i])
      maxX = Math.max(maxX, pts[i])
      minY = Math.min(minY, pts[i + 1])
      maxY = Math.max(maxY, pts[i + 1])
    }
    const pad = 8
    const rel = pts.map((v, i) => (i % 2 === 0 ? v - minX + pad : v - minY + pad))
    void addStroke(folderId, {
      x: minX - pad,
      y: minY - pad,
      w: maxX - minX + pad * 2,
      h: maxY - minY + pad * 2,
      points: rel,
      color: penColor,
      strokeWidth: 3
    })
  }

  const toolBtn = (active: boolean): string =>
    `flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${
      active ? 'border-accent bg-accent text-accent-ink' : 'border-edge bg-surface hover:border-accent/60'
    }`

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setMode('select')} title="Select / move" className={toolBtn(mode === 'select')}>
          <MousePointer2 size={14} /> Select
        </button>
        <button
          onClick={() => setMode(mode === 'draw' ? 'select' : 'draw')}
          title="Draw freehand (Esc to stop)"
          className={toolBtn(mode === 'draw')}
        >
          <Pencil size={14} /> Draw
        </button>
        <button
          onClick={() => {
            const p = lastPoint.current
            void addArrow(folderId, p.x, p.y, penColor)
          }}
          title="Add an arrow (drag its ends to point it)"
          className={toolBtn(false)}
        >
          <MoveUpRight size={14} /> Arrow
        </button>
        <div className="flex items-center gap-1 rounded-lg border border-edge bg-surface px-2 py-1.5">
          {STROKE_COLORS.map((c) => (
            <button
              key={c.name}
              title={c.name}
              onClick={() => setPenColor(c.value)}
              className={`h-4 w-4 rounded-full border ${
                penColor === c.value ? 'border-ink ring-1 ring-accent' : 'border-edge'
              }`}
              style={{ background: c.value }}
            />
          ))}
        </div>
        <button
          onClick={() => fileRef.current?.click()}
          className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface px-3 py-1.5 text-sm font-medium hover:border-accent/60"
        >
          <ImagePlus size={14} /> Add image
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={async (e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            let { x, y } = lastPoint.current
            for (const f of files) {
              if (!f.type.startsWith('image/')) continue
              await addImage(folderId, f, x, y)
              x += 24
              y += 24
            }
          }}
        />
        <span className="text-xs text-muted">
          Click anywhere to type · Ctrl+V pastes an image where you click · Ctrl+Z undoes · A styles
          lines
        </span>
      </div>

      {/* canvas */}
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-auto rounded-xl border border-dashed border-edge bg-raised/20"
        style={{ backgroundImage: 'radial-gradient(rgb(var(--wk-edge)/0.35) 1px, transparent 1px)', backgroundSize: '22px 22px' }}
      >
        {/* a big inner surface so items can live far out and the area scrolls.
            Clicking it (never a child item) drops a note at the cursor. */}
        <div
          className="relative min-h-full cursor-text"
          style={{ width: 3000, height: 2000 }}
          onClick={(e) => {
            if (mode !== 'select') return
            if (e.target !== e.currentTarget) return // ignore clicks on items
            addNoteAt(e.clientX, e.clientY)
          }}
        >
          {items.length === 0 && (
            <div className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 text-center text-sm text-muted">
              Empty canvas — click anywhere to start typing, paste an image, or grab the pen.
            </div>
          )}
          {items.map((it) =>
            it.kind === 'draw' ? (
              <StrokeNode key={it.id} item={it} onAskDelete={() => setConfirmDel(it)} />
            ) : it.kind === 'arrow' ? (
              <ArrowNode key={it.id} item={it} onAskDelete={() => setConfirmDel(it)} />
            ) : (
              <CanvasNode
                key={it.id}
                item={it}
                autoFocus={it.id === focusId}
                onAskDelete={() => setConfirmDel(it)}
              />
            )
          )}

          {/* draw-mode overlay captures the pointer and previews the stroke */}
          {mode === 'draw' && (
            <div
              className="absolute inset-0 cursor-crosshair"
              style={{ zIndex: 100000 }}
              onPointerDown={onDrawDown}
              onPointerMove={onDrawMove}
              onPointerUp={onDrawUp}
            >
              {liveStroke && liveStroke.length >= 4 && (
                <svg className="pointer-events-none absolute inset-0 h-full w-full">
                  <path
                    d={polyPath(liveStroke)}
                    fill="none"
                    stroke={penColor}
                    strokeWidth={3}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </div>
          )}
        </div>
      </div>

      {confirmDel && (
        <ConfirmModal
          title="Delete this?"
          message={`${itemLabel(confirmDel)} will be removed. This cannot be undone.`}
          danger
          onDone={(ok) => {
            setConfirmDel(null)
            if (ok) void del(confirmDel.id)
          }}
        />
      )}
    </div>
  )
}

function itemLabel(it: CanvasItem): string {
  if (it.title) return `"${it.title}"`
  switch (it.kind) {
    case 'image':
      return 'This image'
    case 'draw':
      return 'This drawing'
    case 'arrow':
      return 'This arrow'
    default:
      return 'This text box'
  }
}

function polyPath(pts: number[]): string {
  let d = ''
  for (let i = 0; i + 1 < pts.length; i += 2) d += `${i === 0 ? 'M' : 'L'}${pts[i]} ${pts[i + 1]} `
  return d
}

/** Delayed-hide hover state so chrome stays up while moving onto its buttons. */
function useHover(): { hover: boolean; enter: () => void; leave: () => void } {
  const [hover, setHover] = useState(false)
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  const enter = (): void => {
    if (t.current) clearTimeout(t.current)
    setHover(true)
  }
  const leave = (): void => {
    if (t.current) clearTimeout(t.current)
    t.current = setTimeout(() => setHover(false), 250)
  }
  useEffect(() => () => {
    if (t.current) clearTimeout(t.current)
  }, [])
  return { hover, enter, leave }
}

/* ------------------------------ text & image ------------------------------ */

function CanvasNode({
  item,
  autoFocus,
  onAskDelete
}: {
  item: CanvasItem
  autoFocus?: boolean
  onAskDelete: () => void
}): React.JSX.Element {
  const patch = useBoard((s) => s.patchCanvasItem)
  const persist = useBoard((s) => s.persistCanvasItem)
  const front = useBoard((s) => s.bringCanvasItemFront)
  const del = useBoard((s) => s.deleteCanvasItem)
  const record = useBoard((s) => s.recordCanvasUndo)
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  const resize = useRef<{ px: number; py: number; w: number; h: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const fmtRef = useRef<HTMLDivElement>(null)
  const [editTitle, setEditTitle] = useState(false)
  const [showFmt, setShowFmt] = useState(false)

  // Seed the rich editor once; after that the DOM owns the content (resetting
  // innerHTML on every store patch would throw the caret away).
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (item.html) el.innerHTML = item.html
    else if (item.text) el.textContent = item.text
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Focus a just-created note so the user can type immediately.
  useEffect(() => {
    if (autoFocus) bodyRef.current?.focus()
  }, [autoFocus])

  // Close the format menu on any press outside it.
  useEffect(() => {
    if (!showFmt) return
    const onDoc = (e: PointerEvent): void => {
      if (!fmtRef.current?.contains(e.target as Node)) setShowFmt(false)
    }
    document.addEventListener('pointerdown', onDoc)
    return () => document.removeEventListener('pointerdown', onDoc)
  }, [showFmt])

  const syncBody = (): void => {
    const el = bodyRef.current
    if (el) patch(item.id, { html: el.innerHTML, text: el.innerText })
  }

  /** Apply an editing command to the current selection/caret line, then save. */
  const exec = (cmd: string, val?: string): void => {
    document.execCommand('styleWithCSS', false, 'true')
    document.execCommand(cmd, false, val)
    syncBody()
    void persist(item.id)
  }

  const onDragDown = (e: React.PointerEvent): void => {
    e.stopPropagation()
    void front(item.id)
    drag.current = { px: e.clientX, py: e.clientY, x: item.x, y: item.y }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onDragMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    patch(item.id, { x: Math.max(0, d.x + (e.clientX - d.px)), y: Math.max(0, d.y + (e.clientY - d.py)) })
  }
  const onDragUp = (): void => {
    const d = drag.current
    if (!d) return
    drag.current = null
    const cur = useBoard.getState().canvasItems.find((i) => i.id === item.id)
    if (cur && (cur.x !== d.x || cur.y !== d.y)) record(item.id, { x: d.x, y: d.y })
    void persist(item.id)
  }

  const onResizeDown = (e: React.PointerEvent): void => {
    e.stopPropagation()
    resize.current = { px: e.clientX, py: e.clientY, w: item.w, h: item.h }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onResizeMove = (e: React.PointerEvent): void => {
    const r = resize.current
    if (!r) return
    patch(item.id, {
      w: Math.max(MIN_W, r.w + (e.clientX - r.px)),
      h: Math.max(MIN_H, r.h + (e.clientY - r.py))
    })
  }
  const onResizeUp = (): void => {
    const r = resize.current
    if (!r) return
    resize.current = null
    const cur = useBoard.getState().canvasItems.find((i) => i.id === item.id)
    if (cur && (cur.w !== r.w || cur.h !== r.h)) record(item.id, { w: r.w, h: r.h })
    void persist(item.id)
  }

  const url = item.kind === 'image' && item.imageId ? imgUrl(item.imageId) : null

  return (
    <div
      ref={rootRef}
      className="group absolute rounded-lg border border-edge bg-surface shadow-lg"
      style={{ left: item.x, top: item.y, width: item.w, height: item.h, zIndex: item.z }}
      onPointerDown={() => void front(item.id)}
    >
      {/* grip / header */}
      <div
        onPointerDown={onDragDown}
        onPointerMove={onDragMove}
        onPointerUp={onDragUp}
        className="flex h-6 cursor-grab items-center gap-1 rounded-t-lg border-b border-edge bg-raised/70 px-1.5 active:cursor-grabbing"
      >
        <GripVertical size={13} className="shrink-0 text-muted" />
        {editTitle ? (
          <input
            autoFocus
            defaultValue={item.title ?? ''}
            placeholder={item.kind}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditTitle(false)
            }}
            onBlur={(e) => {
              setEditTitle(false)
              const prev = useBoard.getState().canvasItems.find((i) => i.id === item.id)?.title
              const next = e.target.value.trim() || undefined
              if (prev === next) return
              patch(item.id, { title: next })
              void persist(item.id)
              record(item.id, { title: prev })
            }}
            className="min-w-0 flex-1 border-b border-accent bg-transparent text-[11px] text-ink outline-none"
          />
        ) : (
          <button
            title="Rename"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setEditTitle(true)}
            className={`min-w-0 flex-1 truncate text-left text-[10px] tracking-wide text-muted hover:text-ink ${
              item.title ? '' : 'uppercase'
            }`}
          >
            {item.title || item.kind}
          </button>
        )}
        {item.kind === 'text' && (
          <div ref={fmtRef} className="relative shrink-0">
            <button
              title="Text style (heading, body, color)"
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setShowFmt((v) => !v)}
              className={`rounded px-1 text-[11px] font-bold ${
                showFmt ? 'bg-accent text-accent-ink' : 'text-muted hover:bg-raised hover:text-ink'
              }`}
            >
              A
            </button>
            {showFmt && (
              <div
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.preventDefault()}
                className="absolute right-0 top-6 z-50 w-44 cursor-default rounded-lg border border-edge bg-raised p-2 shadow-xl"
              >
                <div className="px-1 pb-1 text-[10px] uppercase tracking-wider text-muted/70">
                  Line style
                </div>
                <button
                  onClick={() => exec('formatBlock', 'H1')}
                  className="w-full rounded px-2 py-1 text-left text-[15px] font-bold hover:bg-surface"
                >
                  Heading
                </button>
                <button
                  onClick={() => exec('formatBlock', 'H2')}
                  className="w-full rounded px-2 py-1 text-left text-[13px] font-semibold hover:bg-surface"
                >
                  Subheading
                </button>
                <button
                  onClick={() => exec('formatBlock', 'P')}
                  className="w-full rounded px-2 py-1 text-left text-[12.5px] hover:bg-surface"
                >
                  Body
                </button>
                <div className="px-1 pb-1 pt-2 text-[10px] uppercase tracking-wider text-muted/70">
                  Text color
                </div>
                <div className="flex flex-wrap items-center gap-1.5 px-1 pb-0.5">
                  <button
                    title="Default"
                    onClick={() => exec('removeFormat')}
                    className="flex h-5 w-5 items-center justify-center rounded-full border border-edge text-[10px] font-semibold text-ink hover:border-accent"
                  >
                    A
                  </button>
                  {TEXT_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => exec('foreColor', c)}
                      className="h-5 w-5 rounded-full border border-edge hover:border-accent"
                      style={{ background: c }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onAskDelete}
          title="Delete"
          className="shrink-0 rounded p-0.5 text-muted opacity-0 hover:bg-danger/15 hover:text-danger group-hover:opacity-100"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* body */}
      <div className="h-[calc(100%-1.5rem)] w-full overflow-hidden rounded-b-lg">
        {item.kind === 'text' ? (
          <div
            ref={bodyRef}
            data-cv-id={item.id}
            contentEditable
            suppressContentEditableWarning
            onInput={syncBody}
            onBlur={(e) => {
              // Focus moved within this box (rename input, delete button, A menu)?
              // Just save — discarding here would yank the box out from under it.
              if (e.relatedTarget && rootRef.current?.contains(e.relatedTarget as Node)) {
                void persist(item.id)
                return
              }
              // Clicked to start a note but typed nothing? Drop it so misclicks
              // don't litter the canvas (unless it was renamed). Otherwise save.
              const cur = useBoard.getState().canvasItems.find((i) => i.id === item.id)
              if (cur && cur.kind === 'text' && !cur.title && !(cur.text ?? '').trim())
                void del(item.id, { silent: true })
              else void persist(item.id)
            }}
            onPaste={(e) => {
              const dt = e.clipboardData
              // images bubble up to the canvas-level paste handler
              if (Array.from(dt.items).some((i) => i.type.startsWith('image/'))) return
              e.preventDefault()
              document.execCommand('insertText', false, dt.getData('text/plain'))
            }}
            className="h-full w-full cursor-text overflow-auto whitespace-pre-wrap break-words px-2 py-1.5 text-sm text-ink outline-none [&_h1]:my-0.5 [&_h1]:text-[19px] [&_h1]:font-bold [&_h1]:leading-snug [&_h2]:my-0.5 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:leading-snug [&_p]:my-0"
          />
        ) : url ? (
          <img src={url} alt="" className="h-full w-full select-none object-contain" draggable={false} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted">image missing</div>
        )}
      </div>

      {/* resize handle */}
      <div
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        title="Resize"
        className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
        style={{
          background:
            'linear-gradient(135deg, transparent 0 50%, rgb(var(--wk-muted)/0.55) 50% 60%, transparent 60% 70%, rgb(var(--wk-muted)/0.55) 70% 80%, transparent 80%)'
        }}
      />
    </div>
  )
}

/* -------------------------------- pen stroke ------------------------------- */

function StrokeNode({ item, onAskDelete }: { item: CanvasItem; onAskDelete: () => void }): React.JSX.Element {
  const patch = useBoard((s) => s.patchCanvasItem)
  const persist = useBoard((s) => s.persistCanvasItem)
  const front = useBoard((s) => s.bringCanvasItemFront)
  const record = useBoard((s) => s.recordCanvasUndo)
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  const { hover, enter, leave } = useHover()

  const d = polyPath(item.points ?? [])

  const onDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    void front(item.id)
    drag.current = { px: e.clientX, py: e.clientY, x: item.x, y: item.y }
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent): void => {
    const dr = drag.current
    if (!dr) return
    patch(item.id, { x: Math.max(0, dr.x + (e.clientX - dr.px)), y: Math.max(0, dr.y + (e.clientY - dr.py)) })
  }
  const onUp = (): void => {
    const dr = drag.current
    if (!dr) return
    drag.current = null
    const cur = useBoard.getState().canvasItems.find((i) => i.id === item.id)
    if (cur && (cur.x !== dr.x || cur.y !== dr.y)) record(item.id, { x: dr.x, y: dr.y })
    void persist(item.id)
  }

  return (
    <div
      className="pointer-events-none absolute"
      style={{ left: item.x, top: item.y, width: item.w, height: item.h, zIndex: item.z }}
    >
      <svg width={item.w} height={item.h} className="absolute inset-0 overflow-visible">
        <path
          d={d}
          fill="none"
          stroke={item.color ?? 'rgb(var(--wk-ink))'}
          strokeWidth={item.strokeWidth ?? 3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* fat invisible twin of the path so it's easy to grab */}
        <path
          d={d}
          fill="none"
          stroke="transparent"
          strokeWidth={14}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="cursor-grab active:cursor-grabbing"
          style={{ pointerEvents: 'stroke' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerEnter={enter}
          onPointerLeave={leave}
        />
      </svg>
      {hover && (
        <button
          title="Delete"
          onPointerEnter={enter}
          onPointerLeave={leave}
          onClick={onAskDelete}
          className="pointer-events-auto absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-edge bg-surface text-muted shadow hover:text-danger"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  )
}

/* ---------------------------------- arrow --------------------------------- */

function ArrowNode({ item, onAskDelete }: { item: CanvasItem; onAskDelete: () => void }): React.JSX.Element {
  const patch = useBoard((s) => s.patchCanvasItem)
  const persist = useBoard((s) => s.persistCanvasItem)
  const front = useBoard((s) => s.bringCanvasItemFront)
  const record = useBoard((s) => s.recordCanvasUndo)
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  const endDrag = useRef<{ which: 0 | 1; px: number; py: number; sx: number; sy: number } | null>(null)
  // full geometry at endpoint-drag start (re-pointing renormalizes x/y/w/h too)
  const endStart = useRef<{ x: number; y: number; w: number; h: number; points: number[] } | null>(null)
  const { hover, enter, leave } = useHover()

  const [x1, y1, x2, y2] = item.points ?? [14, 14, 154, 14]
  const color = item.color ?? 'rgb(var(--wk-ink))'
  const sw = item.strokeWidth ?? 3

  // arrowhead drawn as a V at the tip
  const ang = Math.atan2(y2 - y1, x2 - x1)
  const hl = 11
  const hx1 = x2 - hl * Math.cos(ang - 0.45)
  const hy1 = y2 - hl * Math.sin(ang - 0.45)
  const hx2 = x2 - hl * Math.cos(ang + 0.45)
  const hy2 = y2 - hl * Math.sin(ang + 0.45)

  const onShaftDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    void front(item.id)
    drag.current = { px: e.clientX, py: e.clientY, x: item.x, y: item.y }
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }
  const onShaftMove = (e: React.PointerEvent): void => {
    const dr = drag.current
    if (!dr) return
    enter()
    patch(item.id, { x: Math.max(0, dr.x + (e.clientX - dr.px)), y: Math.max(0, dr.y + (e.clientY - dr.py)) })
  }
  const onShaftUp = (): void => {
    const dr = drag.current
    if (!dr) return
    drag.current = null
    const cur = useBoard.getState().canvasItems.find((i) => i.id === item.id)
    if (cur && (cur.x !== dr.x || cur.y !== dr.y)) record(item.id, { x: dr.x, y: dr.y })
    void persist(item.id)
  }

  const onEndDown = (which: 0 | 1) => (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    void front(item.id)
    const pts = item.points ?? [x1, y1, x2, y2]
    endDrag.current = {
      which,
      px: e.clientX,
      py: e.clientY,
      sx: pts[which * 2],
      sy: pts[which * 2 + 1]
    }
    endStart.current = { x: item.x, y: item.y, w: item.w, h: item.h, points: [...pts] }
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }
  const onEndMove = (e: React.PointerEvent): void => {
    const dr = endDrag.current
    if (!dr) return
    enter() // keep the handles mounted while dragging (leave can fire under capture)
    const cur = useBoard.getState().canvasItems.find((i) => i.id === item.id)
    if (!cur?.points) return
    const pts = [...cur.points]
    pts[dr.which * 2] = dr.sx + (e.clientX - dr.px)
    pts[dr.which * 2 + 1] = dr.sy + (e.clientY - dr.py)
    patch(item.id, { points: pts })
  }
  const onEndUp = (): void => {
    if (!endDrag.current) return
    endDrag.current = null
    // renormalize the bbox around the (possibly out-of-bounds) endpoints
    const cur = useBoard.getState().canvasItems.find((i) => i.id === item.id)
    if (!cur?.points) return
    const [ax1, ay1, ax2, ay2] = cur.points
    const pad = 14
    const nx = Math.min(ax1, ax2) - pad
    const ny = Math.min(ay1, ay2) - pad
    patch(item.id, {
      x: Math.max(0, cur.x + nx),
      y: Math.max(0, cur.y + ny),
      w: Math.abs(ax2 - ax1) + pad * 2,
      h: Math.abs(ay2 - ay1) + pad * 2,
      points: [ax1 - nx, ay1 - ny, ax2 - nx, ay2 - ny]
    })
    void persist(item.id)
    const s = endStart.current
    endStart.current = null
    if (s && cur.points.some((v, i) => v !== s.points[i])) {
      record(item.id, { x: s.x, y: s.y, w: s.w, h: s.h, points: s.points })
    }
  }

  return (
    <div
      className="pointer-events-none absolute"
      style={{ left: item.x, top: item.y, width: item.w, height: item.h, zIndex: item.z }}
    >
      <svg width={item.w} height={item.h} className="absolute inset-0 overflow-visible">
        <path
          d={`M${x1} ${y1} L${x2} ${y2} M${hx1} ${hy1} L${x2} ${y2} L${hx2} ${hy2}`}
          fill="none"
          stroke={color}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* fat invisible shaft for grabbing the whole arrow */}
        <path
          d={`M${x1} ${y1} L${x2} ${y2}`}
          fill="none"
          stroke="transparent"
          strokeWidth={16}
          strokeLinecap="round"
          className="cursor-grab active:cursor-grabbing"
          style={{ pointerEvents: 'stroke' }}
          onPointerDown={onShaftDown}
          onPointerMove={onShaftMove}
          onPointerUp={onShaftUp}
          onPointerEnter={enter}
          onPointerLeave={leave}
        />
        {/* endpoint handles: drag to re-point the arrow */}
        {(hover || endDrag.current) && (
          <>
            <circle
              cx={x1}
              cy={y1}
              r={6}
              fill="rgb(var(--wk-surface))"
              stroke={color}
              strokeWidth={2}
              className="cursor-move"
              style={{ pointerEvents: 'all' }}
              onPointerDown={onEndDown(0)}
              onPointerMove={onEndMove}
              onPointerUp={onEndUp}
              onPointerEnter={enter}
              onPointerLeave={leave}
            />
            <circle
              cx={x2}
              cy={y2}
              r={6}
              fill="rgb(var(--wk-surface))"
              stroke={color}
              strokeWidth={2}
              className="cursor-move"
              style={{ pointerEvents: 'all' }}
              onPointerDown={onEndDown(1)}
              onPointerMove={onEndMove}
              onPointerUp={onEndUp}
              onPointerEnter={enter}
              onPointerLeave={leave}
            />
          </>
        )}
      </svg>
      {hover && (
        <button
          title="Delete"
          onPointerEnter={enter}
          onPointerLeave={leave}
          onClick={onAskDelete}
          className="pointer-events-auto absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-edge bg-surface text-muted shadow hover:text-danger"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  )
}
