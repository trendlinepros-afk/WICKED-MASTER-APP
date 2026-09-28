import { Star } from 'lucide-react'
import type { ScreenInfo } from '../types'
import { layoutMap } from '../lib/geometry'

const BOX_W = 1000
const BOX_H = 280

/** Monitors drawn in their real arrangement (like Windows display settings). */
export default function ScreenMap({ screens, selected, onSelect, areaText }: { screens: ScreenInfo[]; selected: string; onSelect: (id: string) => void; areaText?: (id: string) => string }): React.JSX.Element {
  const { scale, offX, offY } = layoutMap(screens, BOX_W, BOX_H, 14)
  return (
    <div className="relative w-full rounded-lg bg-bg" style={{ aspectRatio: `${BOX_W} / ${BOX_H}` }}>
      {screens.map((s) => {
        const left = ((offX + s.bounds.x * scale) / BOX_W) * 100
        const top = ((offY + s.bounds.y * scale) / BOX_H) * 100
        const w = ((s.bounds.width * scale) / BOX_W) * 100
        const hgt = ((s.bounds.height * scale) / BOX_H) * 100
        const on = s.id === selected
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            title={`${s.label} · ${s.pixels.width}×${s.pixels.height}`}
            className={`absolute flex flex-col items-center justify-center overflow-hidden rounded-md border-2 p-1 text-center transition-colors ${on ? 'border-accent bg-accent/15' : 'border-edge bg-raised hover:border-accent/60'}`}
            style={{ left: `${left}%`, top: `${top}%`, width: `calc(${w}% - 4px)`, height: `calc(${hgt}% - 4px)` }}
          >
            <span className={`text-2xl font-bold leading-none ${on ? 'text-accent' : 'text-ink'}`}>{s.number}</span>
            <span className="mt-1 max-w-full truncate text-[11px] text-ink/85">{s.label}</span>
            <span className="max-w-full truncate text-[10px] text-muted">{areaText?.(s.id) ?? `${s.pixels.width}×${s.pixels.height}`}</span>
            {s.primary && <Star size={10} className="absolute right-1.5 top-1.5 text-muted" />}
            {on && <span className="absolute left-1.5 top-1.5 rounded bg-accent px-1 text-[9px] font-bold uppercase text-accent-ink">Default</span>}
          </button>
        )
      })}
    </div>
  )
}
