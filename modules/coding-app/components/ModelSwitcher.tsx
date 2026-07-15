import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/bridge'
import { VramUsage } from './VramUsage'
import type { ModelDescriptor } from '../shared/types'

/**
 * Model dropdown shown above the chat. Lists every model from the store,
 * greys out unavailable ones, and exposes a "Load Model" action for the
 * selected local (Ollama) model.
 */

/** Extract the Ollama model name from an id like "ollama:mistral:7b". */
function ollamaNameFromId(id: string): string | null {
  if (!id.startsWith('ollama:')) return null
  return id.slice('ollama:'.length)
}

/** Inline VRAM label for a model (local only). */
function vramLabel(model: ModelDescriptor): string {
  if (!model.isLocal) return ''
  if (model.vramGb != null) return `${model.vramGb} GB`
  return '— GB'
}

/** Build the hover tooltip text for a model row. */
function tooltipFor(model: ModelDescriptor, gpuVramGb: number): string {
  const lines: string[] = [model.name, `Provider: ${model.providerLabel}`]
  if (model.isLocal) {
    if (model.vramGb != null) {
      const pct =
        gpuVramGb > 0 ? Math.round((model.vramGb / gpuVramGb) * 100) : 0
      lines.push(`VRAM: ${model.vramGb} GB (${pct}% of ${gpuVramGb} GB total)`)
    } else {
      lines.push('VRAM: unknown')
    }
  } else {
    lines.push('Cloud API')
  }
  if (model.speedHint) lines.push(`Speed: ${model.speedHint}`)
  if (!model.available && model.unavailableReason) {
    lines.push(`Unavailable: ${model.unavailableReason}`)
  }
  return lines.join('\n')
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'error'

export function ModelSwitcher(): JSX.Element {
  const models = useStore((s) => s.models)
  const selectedModelId = useStore((s) => s.selectedModelId)
  const selectModel = useStore((s) => s.selectModel)
  const config = useStore((s) => s.config)
  const setBanner = useStore((s) => s.setBanner)
  const refreshOllama = useStore((s) => s.refreshOllama)
  const toggleFavorite = useStore((s) => s.toggleFavorite)
  const ollamaStatus = useStore((s) => s.ollamaStatus)

  const [open, setOpen] = useState(false)
  const [loadState, setLoadState] = useState<LoadState>('idle')
  // Locally-tracked load state — a reliable fallback if Ollama's /api/ps
  // reporting is flaky, so Unload is always available after a Load this session.
  const [loadedLocal, setLoadedLocal] = useState<Set<string>>(new Set())
  const containerRef = useRef<HTMLDivElement>(null)

  const gpuVramGb = config?.gpuVramGb ?? 0
  const favorites = config?.favoriteModels ?? []
  const isFavorite = (id: string): boolean => favorites.includes(id)
  const selected = models.find((m) => m.id === selectedModelId) ?? null
  const selectedOllamaName = selected ? ollamaNameFromId(selected.id) : null
  const isLoaded =
    !!selectedOllamaName &&
    ((ollamaStatus?.loadedModels?.includes(selectedOllamaName) ?? false) ||
      loadedLocal.has(selectedOllamaName))

  // Favorited models float to the top, preserving the underlying order within
  // each group (stable sort).
  const sortedModels = [...models].sort((a, b) => {
    const fa = isFavorite(a.id) ? 0 : 1
    const fb = isFavorite(b.id) ? 0 : 1
    return fa - fb
  })

  // Close the dropdown on any click outside the component.
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  // Reset transient load state whenever the selected model changes.
  useEffect(() => {
    setLoadState('idle')
  }, [selectedModelId])

  const handleSelect = (model: ModelDescriptor): void => {
    if (!model.available) return
    void selectModel(model.id)
    setOpen(false)
  }

  // Toggle: load the selected local model, or unload it if already loaded.
  const handleLoadToggle = async (): Promise<void> => {
    if (!selectedOllamaName) return
    setLoadState('loading')
    try {
      const willUnload = isLoaded
      const res = willUnload
        ? await api.unloadOllamaModel(selectedOllamaName)
        : await api.loadOllamaModel(selectedOllamaName)
      if (res.ok) {
        setLoadState('idle')
        // Update local tracking immediately so the button reflects reality even
        // if /api/ps lags or under-reports.
        setLoadedLocal((prev) => {
          const next = new Set(prev)
          if (willUnload) next.delete(selectedOllamaName)
          else next.add(selectedOllamaName)
          return next
        })
        await refreshOllama() // updates loaded state + VRAM-in-use meter
      } else {
        setLoadState('error')
        setBanner({
          kind: 'error',
          text: `Failed to ${isLoaded ? 'unload' : 'load'} model: ${res.error ?? 'unknown error'}`
        })
      }
    } catch (err) {
      setLoadState('error')
      setBanner({
        kind: 'error',
        text: `Failed to ${isLoaded ? 'unload' : 'load'} model: ${(err as Error).message}`
      })
    }
  }

  return (
    <div ref={containerRef} className="relative flex items-center gap-2">
      <button
        type="button"
        className="flex min-w-[220px] items-center justify-between gap-2 rounded border border-edge bg-raised px-3 py-1.5 text-sm hover:bg-edge/60"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex flex-col items-start leading-tight">
          <span className="font-medium text-ink">
            {selected ? selected.name : 'Select a model'}
          </span>
          {selected && (
            <span className="text-xs text-muted">
              {selected.providerLabel}
              {vramLabel(selected) ? ` · ${vramLabel(selected)}` : ''}
            </span>
          )}
        </span>
        <span className="text-muted">▾</span>
      </button>

      {selectedOllamaName && (
        <button
          type="button"
          className={`rounded border px-3 py-1.5 text-sm disabled:opacity-50 ${
            isLoaded
              ? 'border-ok/50 bg-ok/10 text-ok hover:bg-ok/20'
              : 'border-edge bg-raised hover:bg-edge/60'
          }`}
          disabled={loadState === 'loading'}
          onClick={() => void handleLoadToggle()}
          title={
            isLoaded
              ? 'Model is loaded in memory — click to unload and free VRAM'
              : 'Load the selected local model into Ollama memory'
          }
        >
          {loadState === 'loading'
            ? isLoaded
              ? 'Unloading…'
              : 'Loading…'
            : isLoaded
              ? 'Loaded ✓ — Unload'
              : 'Load Model'}
        </button>
      )}

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 max-h-96 w-80 overflow-y-auto rounded-md border border-edge bg-raised py-1 shadow-xl">
          {/* Live VRAM budget so it's clear what will still fit. */}
          <div className="sticky top-0 border-b border-edge bg-raised px-3 py-2">
            <VramUsage />
          </div>
          {sortedModels.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted">No models available</div>
          )}
          {sortedModels.map((model) => {
            const isSelected = model.id === selectedModelId
            const fav = isFavorite(model.id)
            return (
              <div
                key={model.id}
                title={tooltipFor(model, gpuVramGb)}
                className={`flex w-full items-start gap-2 px-3 py-2 text-sm ${
                  isSelected ? 'bg-accent/15' : ''
                } ${model.available ? 'hover:bg-edge/60' : 'opacity-60'}`}
              >
                {/* Favorite toggle — floats the model to the top of the list. */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    void toggleFavorite(model.id)
                  }}
                  title={fav ? 'Unfavorite' : 'Favorite (pin to top)'}
                  className={`mt-0.5 shrink-0 text-base leading-none ${
                    fav ? 'text-warn' : 'text-muted hover:text-warn'
                  }`}
                >
                  {fav ? '★' : '☆'}
                </button>
                {/* Selectable region. */}
                <button
                  type="button"
                  disabled={!model.available}
                  onClick={() => handleSelect(model)}
                  className={`flex min-w-0 flex-1 items-start justify-between gap-2 text-left ${
                    model.available ? 'cursor-pointer text-ink' : 'cursor-not-allowed text-muted'
                  }`}
                >
                  <span className="flex min-w-0 flex-col leading-tight">
                    <span className="flex items-center gap-1.5 font-medium">
                      {model.name}
                      {isSelected && <span className="text-accent">●</span>}
                    </span>
                    <span className="text-xs text-muted">{model.providerLabel}</span>
                    {model.description && (
                      <span className="mt-0.5 text-xs text-muted">
                        {model.description}
                      </span>
                    )}
                    {!model.available && model.unavailableReason && (
                      <span className="mt-0.5 text-xs text-warn">
                        {model.unavailableReason}
                      </span>
                    )}
                  </span>
                  {/* Inline VRAM badge — always visible, no hover needed. */}
                  {vramLabel(model) && (
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${
                        model.available
                          ? 'bg-edge/60 text-muted'
                          : 'bg-warn/20 text-warn'
                      }`}
                      title="Estimated VRAM (from the model's size)"
                    >
                      {vramLabel(model)}
                    </span>
                  )}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
