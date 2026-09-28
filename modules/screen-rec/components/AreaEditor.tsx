import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { inv } from '../store'
import type { Frac, ScreenInfo } from '../types'
import { areaPixels, lockAspect, normFrac, workAreaFrac } from '../lib/geometry'
import { btn, btnAccent, Modal, Toggle } from './ui'

type Drag = { kind: 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'draw'; x0: number; y0: number; start: Frac }

/** Draw the part of a screen to record on a live screenshot of it. */
export default function AreaEditor({ screen, initial, lock169, onSave, onClose }: { screen: ScreenInfo; initial: Frac; lock169: boolean; onSave: (f: Frac, lock: boolean) => void; onClose: () => void }): React.JSX.Element {
  const [shot, setShot] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [lock, setLock] = useState(lock169)
  const [rect, setRect] = useState<Frac>(() => (lock169 ? lockAspect(initial, screen.pixels) : normFrac(initial)))
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const k = screen.pixels.width / (screen.pixels.height * (16 / 9)) // h = w * k keeps 16:9 in pixels

  useEffect(() => {
    void (inv('screen-thumb', { screenId: screen.id, width: 1400 }) as Promise<{ ok: boolean; dataUrl?: string; error?: string }>).then((r) => (r.ok && r.dataUrl ? setShot(r.dataUrl) : setErr(r.error ?? 'No screenshot')))
  }, [screen.id])
  useEffect(() => {
    if (lock) setRect((r) => lockAspect(r, screen.pixels))
  }, [lock, screen.pixels])

  const pt = (e: React.PointerEvent): { x: number; y: number } => {
    const b = box.current!.getBoundingClientRect()
    return { x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)) }
  }
  const fromCorner = (ax: number, ay: number, px: number, py: number): Frac => {
    let w = Math.max(0.05, Math.abs(px - ax))
    let h = Math.max(0.05, Math.abs(py - ay))
    if (lock) {
      h = w * k
      const maxH = py < ay ? ay : 1 - ay
      const maxW = px < ax ? ax : 1 - ax
      if (h > maxH) {
        h = maxH
        w = h / k
      }
      if (w > maxW) {
        w = maxW
        h = w * k
      }
    }
    return normFrac({ x: px < ax ? ax - w : ax, y: py < ay ? ay - h : ay, w, h })
  }
  const down = (kind: Drag['kind']) => (e: React.PointerEvent) => {
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    const p = pt(e)
    drag.current = { kind, x0: p.x, y0: p.y, start: rect }
  }
  const move = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const p = pt(e)
    const r = d.start
    if (d.kind === 'move') setRect(normFrac({ ...r, x: r.x + (p.x - d.x0), y: r.y + (p.y - d.y0) }))
    else if (d.kind === 'draw') setRect(fromCorner(d.x0, d.y0, p.x, p.y))
    else {
      const ax = d.kind === 'nw' || d.kind === 'sw' ? r.x + r.w : r.x
      const ay = d.kind === 'nw' || d.kind === 'ne' ? r.y + r.h : r.y
      setRect(fromCorner(ax, ay, p.x, p.y))
    }
  }
  const up = (): void => {
    drag.current = null
  }
  const px = areaPixels(rect, screen.pixels)
  const handle = 'absolute h-3.5 w-3.5 rounded-sm border-2 border-white bg-accent shadow'

  return (
    <Modal title={`Custom area — Screen ${screen.number} · ${screen.label}`} onClose={onClose} wide>
      <p className="mb-3 text-sm text-muted">Drag a box over the part of the screen to record, or drag the corners. This area is used whenever you record this screen.</p>
      <div
        ref={box}
        className="relative w-full touch-none select-none overflow-hidden rounded-lg bg-black"
        style={{ aspectRatio: `${screen.pixels.width} / ${screen.pixels.height}`, cursor: 'crosshair' }}
        onPointerDown={down('draw')}
        onPointerMove={move}
        onPointerUp={up}
      >
        {shot ? <img src={shot} alt="" className="pointer-events-none h-full w-full object-cover" draggable={false} /> : <div className="flex h-full items-center justify-center text-sm text-white/60">{err || <LoaderCircle size={18} className="animate-spin" />}</div>}
        <div
          className="absolute cursor-move border-2 border-accent"
          style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%`, boxShadow: '0 0 0 200vmax rgba(0,0,0,.55)' }}
          onPointerDown={down('move')}
        >
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md bg-black/75 px-2 py-1 text-xs font-semibold text-white">
            {px.width}×{px.height}
          </span>
          <span className={`${handle} -left-2 -top-2 cursor-nwse-resize`} onPointerDown={down('nw')} />
          <span className={`${handle} -right-2 -top-2 cursor-nesw-resize`} onPointerDown={down('ne')} />
          <span className={`${handle} -bottom-2 -left-2 cursor-nesw-resize`} onPointerDown={down('sw')} />
          <span className={`${handle} -bottom-2 -right-2 cursor-nwse-resize`} onPointerDown={down('se')} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="min-w-[260px] flex-1">
          <Toggle checked={lock} onChange={setLock} label="Keep it 16:9" hint="Fills the 1920×1080 video exactly — no black bars." />
        </div>
        <button className={btn} onClick={() => setRect(lock ? lockAspect(workAreaFrac(screen), screen.pixels) : workAreaFrac(screen))}>
          Whole screen without taskbar
        </button>
        <button className={btn} onClick={onClose}>
          Cancel
        </button>
        <button className={btnAccent} onClick={() => onSave(rect, lock)}>
          Use this area
        </button>
      </div>
    </Modal>
  )
}
