import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Palette, Pipette, Plus, Save, SlidersHorizontal, Trash2, Undo2, X } from 'lucide-react'
import {
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  hexToRgb,
  hsvToRgb,
  makeThemeId,
  migrateTheme,
  normalizeHex,
  rgbToHex,
  rgbToHsv,
  THEME_TOKENS,
  type CustomTheme,
  type ThemeColors
} from '@shared/themes'
import { previewAppearance, useSettings } from '@/stores/settings'

/* ------------------------------ color wheel ------------------------------- */

const WHEEL = 168

function ColorWheel({ hex, onPick }: { hex: string; onPick: (hex: string) => void }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rgb = hexToRgb(hex) ?? { r: 255, g: 255, b: 255 }
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b)
  const [value, setValue] = useState(hsv.v)
  const valueRef = useRef(hsv.v)

  // keep the brightness slider in sync when an outside change (hex field) lands
  useEffect(() => {
    valueRef.current = hsv.v
    setValue(hsv.v)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hex])

  // paint the hue/saturation disc at the current brightness
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(WHEEL, WHEEL)
    const R = WHEEL / 2
    for (let y = 0; y < WHEEL; y++) {
      for (let x = 0; x < WHEEL; x++) {
        const dx = x - R
        const dy = y - R
        const dist = Math.sqrt(dx * dx + dy * dy)
        const i = (y * WHEEL + x) * 4
        if (dist <= R) {
          const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360
          const s = Math.min(1, dist / R)
          const { r, g, b } = hsvToRgb(h, s, value)
          img.data[i] = r
          img.data[i + 1] = g
          img.data[i + 2] = b
          // soft anti-aliased rim
          img.data[i + 3] = dist > R - 1.5 ? Math.max(0, Math.round((R - dist) / 1.5 * 255)) : 255
        } else {
          img.data[i + 3] = 0
        }
      }
    }
    ctx.putImageData(img, 0, 0)
  }, [value])

  const pick = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const R = WHEEL / 2
    const dx = ((e.clientX - rect.left) / rect.width) * WHEEL - R
    const dy = ((e.clientY - rect.top) / rect.height) * WHEEL - R
    const dist = Math.min(Math.sqrt(dx * dx + dy * dy), R)
    const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360
    const s = dist / R
    const { r, g, b } = hsvToRgb(h, s, valueRef.current)
    onPick(rgbToHex(r, g, b))
  }

  // marker position for the current color
  const marker = useMemo(() => {
    const R = WHEEL / 2
    const ang = (hsv.h * Math.PI) / 180
    const dist = hsv.s * R
    return { x: R + Math.cos(ang) * dist, y: R + Math.sin(ang) * dist }
  }, [hsv.h, hsv.s])

  return (
    <div className="flex flex-col items-center gap-2.5">
      <div className="relative" style={{ width: WHEEL, height: WHEEL }}>
        <canvas
          ref={canvasRef}
          width={WHEEL}
          height={WHEEL}
          className="cursor-crosshair touch-none rounded-full"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            pick(e)
          }}
          onPointerMove={(e) => {
            if (e.buttons > 0) pick(e)
          }}
        />
        <span
          className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
          style={{ left: marker.x, top: marker.y, background: hex }}
        />
      </div>
      <div className="flex w-full items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted">Dark</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(value * 100)}
          onChange={(e) => {
            const v = Number(e.target.value) / 100
            valueRef.current = v
            setValue(v)
            const { r, g, b } = hsvToRgb(hsv.h, hsv.s, v)
            onPick(rgbToHex(r, g, b))
          }}
          className="min-w-0 flex-1 accent-accent"
        />
        <span className="text-[10px] uppercase tracking-wide text-muted">Bright</span>
      </div>
    </div>
  )
}

/* ------------------------------- color field ------------------------------ */

function ColorField({
  label,
  hint,
  value,
  open,
  onToggle,
  onChange
}: {
  label: string
  hint: string
  value: string
  open: boolean
  onToggle: () => void
  onChange: (hex: string) => void
}): React.JSX.Element {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])

  const commitText = (): void => {
    const n = normalizeHex(text)
    if (n) onChange(n)
    else setText(value)
  }

  return (
    <div className="border-b border-edge/50 last:border-b-0">
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          onClick={onToggle}
          title="Open the color wheel"
          className={`h-8 w-8 shrink-0 rounded-lg border ${open ? 'border-accent ring-2 ring-accent/30' : 'border-edge'}`}
          style={{ background: value }}
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{label}</div>
          <div className="truncate text-[11px] text-muted">{hint}</div>
        </div>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText()
          }}
          spellCheck={false}
          className="w-24 rounded-lg border border-edge bg-raised px-2 py-1.5 text-center font-mono text-xs outline-none focus:border-accent"
        />
      </div>
      {open && (
        <div className="flex justify-center px-3 pb-3">
          <ColorWheel hex={value} onPick={onChange} />
        </div>
      )}
    </div>
  )
}

/* ------------------------------- theme studio ------------------------------ */

export default function ThemeStudio(): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const { customThemes, activeThemeId } = settings

  const activeTheme = customThemes.find((t) => t.id === activeThemeId)
  const systemDark = matchMedia('(prefers-color-scheme: dark)').matches
  const appDark = settings.theme === 'dark' || (settings.theme === 'system' && systemDark)

  // Each theme has BOTH palettes; the buffer holds both, and `editMode` decides
  // which sub-palette the color fields edit + preview. Default (no custom theme)
  // seeds from the built-in light/dark palettes.
  const sourceOf = (t: CustomTheme | undefined): { light: ThemeColors; dark: ThemeColors } =>
    t
      ? { light: { ...migrateTheme(t).light }, dark: { ...migrateTheme(t).dark } }
      : { light: { ...DEFAULT_LIGHT }, dark: { ...DEFAULT_DARK } }

  const [buffer, setBuffer] = useState(() => sourceOf(activeTheme))
  const [editMode, setEditMode] = useState<'light' | 'dark'>(appDark ? 'dark' : 'light')
  const [openField, setOpenField] = useState('')
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [saveAsName, setSaveAsName] = useState('')
  const [manageOpen, setManageOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState('')

  const source = sourceOf(activeTheme)
  const dirty = JSON.stringify(buffer) !== JSON.stringify(source)
  const palette = buffer[editMode]

  // re-seed the buffer when the selected theme changes
  useEffect(() => {
    setBuffer(sourceOf(activeTheme))
    setOpenField('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThemeId, customThemes])

  // Live-preview the sub-palette being edited, in its own light/dark mode, the
  // whole time the studio is open (toggling Light/Dark shows that sub-theme);
  // restore the saved look on unmount.
  useEffect(() => {
    previewAppearance({ mode: editMode, colors: buffer[editMode] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer, editMode])
  useEffect(() => () => previewAppearance(null), [])

  const setColor = (id: string, hex: string): void =>
    setBuffer((b) => ({ ...b, [editMode]: { ...b[editMode], [id]: hex } }))

  const save = async (): Promise<void> => {
    if (!activeTheme) return
    await update({
      customThemes: customThemes.map((t) =>
        t.id === activeTheme.id ? { id: t.id, name: t.name, light: buffer.light, dark: buffer.dark } : t
      )
    })
  }

  const saveAs = async (): Promise<void> => {
    const name = saveAsName.trim()
    if (!name) return
    const theme: CustomTheme = {
      id: makeThemeId(name, customThemes.map((t) => t.id)),
      name,
      light: buffer.light,
      dark: buffer.dark
    }
    await update({ customThemes: [...customThemes, theme], activeThemeId: theme.id })
    setSaveAsOpen(false)
    setSaveAsName('')
  }

  const removeTheme = async (id: string): Promise<void> => {
    await update({
      customThemes: customThemes.filter((t) => t.id !== id),
      ...(activeThemeId === id ? { activeThemeId: '' } : {})
    })
    setConfirmDelete('')
  }

  const renameTheme = async (id: string, name: string): Promise<void> => {
    const clean = name.trim()
    if (!clean) return
    await update({ customThemes: customThemes.map((t) => (t.id === id ? { ...t, name: clean } : t)) })
  }

  const duplicateTheme = async (t: CustomTheme): Promise<void> => {
    const name = `${t.name} copy`
    const m = migrateTheme(t)
    const copy: CustomTheme = {
      id: makeThemeId(name, customThemes.map((x) => x.id)),
      name,
      light: { ...m.light },
      dark: { ...m.dark }
    }
    await update({ customThemes: [...customThemes, copy] })
  }

  return (
    <div className="mt-4 max-w-2xl">
      {/* theme picker row */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-edge bg-raised px-2">
          <Palette size={14} className="shrink-0 text-muted" />
          <select
            value={activeThemeId}
            onChange={(e) => void update({ activeThemeId: e.target.value })}
            className="cursor-pointer bg-transparent py-2 text-sm text-ink outline-none [&>option]:bg-surface [&>option]:text-ink"
          >
            <option value="">Default (Light / Dark / System above)</option>
            {customThemes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={() => setManageOpen(true)}
          className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface px-3 py-2 text-sm font-medium hover:border-accent/60"
        >
          <SlidersHorizontal size={14} /> Manage themes
        </button>
      </div>

      {/* editor */}
      <div className="mt-3 rounded-xl border border-edge bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-edge px-3 py-2.5">
          <Pipette size={14} className="text-accent" />
          <span className="text-sm font-semibold">
            Theme editor — {activeTheme ? activeTheme.name : 'Default'}
          </span>
          {dirty && (
            <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-warn">
              Previewing · unsaved
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-xs text-muted">Editing</span>
            {(['light', 'dark'] as const).map((b) => (
              <button
                key={b}
                onClick={() => {
                  setEditMode(b)
                  setOpenField('')
                }}
                title={`Edit the ${b} sub-theme (previews in ${b} mode)`}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium capitalize ${
                  editMode === b ? 'bg-accent text-accent-ink' : 'bg-raised text-muted hover:text-ink'
                }`}
              >
                {b}
              </button>
            ))}
          </div>
        </div>

        <div className="border-b border-edge/50 bg-raised/30 px-3 py-1.5 text-[11px] text-muted">
          Editing the <strong className="text-ink capitalize">{editMode}</strong> sub-theme — these colors
          apply when the app is in {editMode} mode. The {editMode === 'light' ? 'dark' : 'light'} colors are
          separate; switch with the toggle above.
        </div>

        <div>
          {THEME_TOKENS.map((tok) => (
            <ColorField
              key={`${editMode}-${tok.id}`}
              label={tok.label}
              hint={tok.hint}
              value={palette[tok.id]}
              open={openField === tok.id}
              onToggle={() => setOpenField((f) => (f === tok.id ? '' : tok.id))}
              onChange={(hex) => setColor(tok.id, hex)}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-edge px-3 py-2.5">
          <button
            onClick={() => void save()}
            disabled={!activeTheme || !dirty}
            title={activeTheme ? 'Update this theme' : 'The Default theme can’t be overwritten — use Save As'}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            <Save size={14} /> Save
          </button>
          {saveAsOpen ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={saveAsName}
                onChange={(e) => setSaveAsName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveAs()
                  if (e.key === 'Escape') setSaveAsOpen(false)
                }}
                placeholder="Theme name…"
                className="w-40 rounded-lg border border-edge bg-raised px-2.5 py-2 text-sm outline-none focus:border-accent"
              />
              <button
                onClick={() => void saveAs()}
                disabled={!saveAsName.trim()}
                className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
              >
                <Check size={14} />
              </button>
              <button onClick={() => setSaveAsOpen(false)} className="rounded-lg bg-raised px-2.5 py-2 text-sm hover:bg-edge/60">
                <X size={14} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                setSaveAsName(activeTheme ? `${activeTheme.name} copy` : 'My theme')
                setSaveAsOpen(true)
              }}
              className="flex items-center gap-1.5 rounded-lg bg-raised px-3.5 py-2 text-sm font-medium hover:bg-edge/60"
            >
              <Plus size={14} /> Save As
            </button>
          )}
          <button
            onClick={() => setBuffer(sourceOf(activeTheme))}
            disabled={!dirty}
            className="flex items-center gap-1.5 rounded-lg bg-raised px-3.5 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
          >
            <Undo2 size={14} /> Reset
          </button>
          <span className="ml-auto text-[11px] text-muted">Light &amp; dark save together — Save makes them stick.</span>
        </div>
      </div>

      {/* manage themes modal */}
      {manageOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={() => setManageOpen(false)}>
          <div
            className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-edge bg-surface"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
              <SlidersHorizontal size={15} className="text-accent" />
              <span className="text-sm font-semibold">Manage themes</span>
              <button onClick={() => setManageOpen(false)} className="ml-auto rounded-md p-1 text-muted hover:bg-raised hover:text-ink">
                <X size={15} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {customThemes.length === 0 && (
                <p className="p-6 text-center text-sm text-muted">
                  No custom themes yet — tweak some colors below and hit <strong>Save As</strong>.
                </p>
              )}
              {customThemes.map((t) => {
                const mt = migrateTheme(t)
                return (
                <div key={t.id} className="flex items-center gap-2 border-b border-edge/50 px-4 py-2.5 last:border-b-0">
                  <span className="flex shrink-0 -space-x-1" title="Light / dark accents">
                    <span className="h-5 w-5 rounded-full border border-edge" style={{ background: mt.light.accent }} />
                    <span className="h-5 w-5 rounded-full border border-edge" style={{ background: mt.dark.bg }} />
                    <span className="h-5 w-5 rounded-full border border-edge" style={{ background: mt.dark.accent }} />
                  </span>
                  <input
                    defaultValue={t.name}
                    onBlur={(e) => void renameTheme(t.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    }}
                    className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-medium outline-none hover:border-edge focus:border-accent"
                  />
                  <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] uppercase text-muted">L+D</span>
                  {activeThemeId === t.id ? (
                    <span className="shrink-0 rounded bg-ok/15 px-2 py-1 text-xs font-medium text-ok">In use</span>
                  ) : (
                    <button
                      onClick={() => void update({ activeThemeId: t.id })}
                      className="shrink-0 rounded-lg bg-raised px-2.5 py-1 text-xs font-medium hover:bg-edge/60"
                    >
                      Use
                    </button>
                  )}
                  <button
                    onClick={() => void duplicateTheme(t)}
                    title="Duplicate"
                    className="shrink-0 rounded-md p-1.5 text-muted hover:bg-raised hover:text-ink"
                  >
                    <Copy size={14} />
                  </button>
                  {confirmDelete === t.id ? (
                    <button
                      onClick={() => void removeTheme(t.id)}
                      className="shrink-0 rounded-lg bg-danger px-2 py-1 text-xs font-medium text-white"
                    >
                      Sure?
                    </button>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(t.id)}
                      title="Delete theme"
                      className="shrink-0 rounded-md p-1.5 text-muted hover:bg-danger/15 hover:text-danger"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
