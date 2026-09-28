/**
 * Pure screen / capture-area math (no Electron imports — shared by main,
 * renderer and tests).
 */
import type { AreaMode, Frac, Rect, ScreenInfo } from '../types'

export const FULL: Frac = { x: 0, y: 0, w: 1, h: 1 }

export interface RawDisplay {
  id: number | string
  label?: string
  bounds: Rect
  workArea: Rect
  scaleFactor: number
  size?: { width: number; height: number }
}

/** Number displays 1..N left→right, then top→bottom (what the overlays show). */
export function numberScreens(displays: RawDisplay[], primaryId?: number | string): ScreenInfo[] {
  const sorted = [...displays].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
  return sorted.map((d, i) => {
    const size = d.size ?? { width: d.bounds.width, height: d.bounds.height }
    return {
      id: String(d.id),
      number: i + 1,
      label: (d.label ?? '').trim() || `Display ${i + 1}`,
      bounds: { ...d.bounds },
      workArea: { ...d.workArea },
      scaleFactor: d.scaleFactor || 1,
      pixels: { width: Math.round(size.width * (d.scaleFactor || 1)), height: Math.round(size.height * (d.scaleFactor || 1)) },
      primary: primaryId != null && String(primaryId) === String(d.id)
    }
  })
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))

/** Keep a fraction rect inside the unit square with a sane minimum size. */
export function normFrac(f: Frac): Frac {
  const w = Math.min(1, Math.max(0.05, Number.isFinite(f.w) ? f.w : 1))
  const h = Math.min(1, Math.max(0.05, Number.isFinite(f.h) ? f.h : 1))
  const x = Math.min(1 - w, clamp01(f.x))
  const y = Math.min(1 - h, clamp01(f.y))
  return { x, y, w, h }
}

/** The screen minus its taskbar, as fractions of the whole screen. */
export function workAreaFrac(s: Pick<ScreenInfo, 'bounds' | 'workArea'>): Frac {
  const b = s.bounds
  const wa = s.workArea
  if (!b.width || !b.height) return FULL
  return normFrac({ x: (wa.x - b.x) / b.width, y: (wa.y - b.y) / b.height, w: wa.width / b.width, h: wa.height / b.height })
}

/** The capture area for a screen under the chosen mode (custom falls back to "no taskbar"). */
export function areaFor(mode: AreaMode, s: Pick<ScreenInfo, 'bounds' | 'workArea'>, custom?: Frac | null): Frac {
  if (mode === 'full') return FULL
  if (mode === 'custom' && custom) return normFrac(custom)
  return workAreaFrac(s)
}

/**
 * Adjust a fraction rect so its pixel aspect is `ratio` (default 16:9),
 * shrinking the longer side around the centre and staying on screen.
 */
export function lockAspect(f: Frac, pixels: { width: number; height: number }, ratio = 16 / 9): Frac {
  const n = normFrac(f)
  const pw = n.w * pixels.width
  const ph = n.h * pixels.height
  if (!pw || !ph) return n
  let w = n.w
  let h = n.h
  if (pw / ph > ratio) w = (ph * ratio) / pixels.width
  else h = pw / ratio / pixels.height
  const cx = n.x + n.w / 2
  const cy = n.y + n.h / 2
  return normFrac({ x: cx - w / 2, y: cy - h / 2, w, h })
}

export function isFull(f: Frac): boolean {
  return f.x <= 0.0005 && f.y <= 0.0005 && f.w >= 0.9995 && f.h >= 0.9995
}

/** Pixel size of an area on a screen, e.g. 2560×1392. */
export function areaPixels(f: Frac, pixels: { width: number; height: number }): { width: number; height: number } {
  return { width: Math.round(f.w * pixels.width), height: Math.round(f.h * pixels.height) }
}

export function areaLabel(mode: AreaMode, f: Frac, pixels: { width: number; height: number }): string {
  const p = areaPixels(f, pixels)
  const what = mode === 'full' ? 'whole screen' : mode === 'custom' ? 'custom area' : 'taskbar hidden'
  return `${p.width}×${p.height} · ${what}`
}

/** Scale-to-fit a set of display rects into a box (for the settings screen map). */
export function layoutMap(screens: Pick<ScreenInfo, 'bounds'>[], boxW: number, boxH: number, pad = 8): { scale: number; offX: number; offY: number } {
  if (!screens.length) return { scale: 1, offX: 0, offY: 0 }
  const minX = Math.min(...screens.map((s) => s.bounds.x))
  const minY = Math.min(...screens.map((s) => s.bounds.y))
  const maxX = Math.max(...screens.map((s) => s.bounds.x + s.bounds.width))
  const maxY = Math.max(...screens.map((s) => s.bounds.y + s.bounds.height))
  const scale = Math.min((boxW - pad * 2) / (maxX - minX), (boxH - pad * 2) / (maxY - minY))
  const offX = (boxW - (maxX - minX) * scale) / 2 - minX * scale
  const offY = (boxH - (maxY - minY) * scale) / 2 - minY * scale
  return { scale, offX, offY }
}

export function fmtDuration(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i >= 2 ? 1 : 0)} ${u[i]}`
}

/** Recording bitrate for a capture size / frame rate / quality. */
export function videoBitrate(pixels: { width: number; height: number }, fps: number, quality: 'standard' | 'high'): number {
  const bpp = quality === 'high' ? 0.12 : 0.07
  const bits = pixels.width * pixels.height * fps * bpp
  return Math.round(Math.min(60_000_000, Math.max(4_000_000, bits)))
}
