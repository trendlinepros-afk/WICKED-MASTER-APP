import { randomUUID } from 'crypto'
import { join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import type { JournalDraft, JournalEntry } from './types'

/**
 * Trade Log — a hand-written trade journal. Plain CRUD over a list of entries
 * persisted in the shared module store (so it's included in Backup & Cloud
 * Sync). All logic lives here; the MCP tools and the UI both call these
 * channels, so there is one source of truth.
 */

const ID = 'trade-log'
const KEY = `${ID}.entries`
const MAX_NOTE = 20_000

function readAll(ctx: ModuleIpcContext): JournalEntry[] {
  const list = ctx.storeGet<JournalEntry[]>(KEY, [])
  return Array.isArray(list) ? list : []
}

function writeAll(ctx: ModuleIpcContext, entries: JournalEntry[]): void {
  ctx.storeSet(KEY, entries)
}

/** Newest trade first (by buy time, then creation). */
function sortEntries(entries: JournalEntry[]): JournalEntry[] {
  return [...entries].sort((a, b) => (b.buyAt || '').localeCompare(a.buyAt || '') || b.createdAt - a.createdAt)
}

const str = (v: unknown, max = 400): string => (typeof v === 'string' ? v.slice(0, max) : '')
const sym = (v: unknown): string => str(v, 12).toUpperCase().replace(/[^A-Z0-9.\-]/g, '')
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const shareCount = (v: unknown): number => {
  const n = num(v)
  return n != null && n >= 0 ? n : 0
}

/** Coerce arbitrary renderer/agent input into a clean draft. */
function normalizeDraft(raw: unknown): JournalDraft {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    name: str(r.name, 120),
    symbol: sym(r.symbol),
    buyAt: str(r.buyAt, 40),
    shares: shareCount(r.shares),
    buyPrice: num(r.buyPrice),
    entryNote: str(r.entryNote, MAX_NOTE),
    sellAt: str(r.sellAt, 40),
    sellPrice: num(r.sellPrice),
    exitNote: str(r.exitNote, MAX_NOTE),
    finalReview: str(r.finalReview, MAX_NOTE)
  }
}

export default function register(ctx: ModuleIpcContext): void {
  ctx.ipcMain.handle(`${ID}:list`, () => ({ ok: true, entries: sortEntries(readAll(ctx)) }))

  ctx.ipcMain.handle(`${ID}:get`, (_e, id: unknown) => {
    const entry = readAll(ctx).find((x) => x.id === String(id)) ?? null
    return { ok: !!entry, entry }
  })

  ctx.ipcMain.handle(`${ID}:create`, (_e, raw: unknown) => {
    const now = Date.now()
    const entry: JournalEntry = {
      id: randomUUID(),
      ...normalizeDraft(raw),
      createdAt: now,
      updatedAt: now
    }
    const entries = [entry, ...readAll(ctx)]
    writeAll(ctx, entries)
    return { ok: true, entry, entries: sortEntries(entries) }
  })

  ctx.ipcMain.handle(`${ID}:update`, (_e, id: unknown, patch: unknown) => {
    const entries = readAll(ctx)
    const i = entries.findIndex((x) => x.id === String(id))
    if (i === -1) return { ok: false, error: 'Entry not found.' }
    const draft = normalizeDraft({ ...entries[i], ...(typeof patch === 'object' && patch ? patch : {}) })
    entries[i] = { ...entries[i], ...draft, updatedAt: Date.now() }
    writeAll(ctx, entries)
    return { ok: true, entry: entries[i], entries: sortEntries(entries) }
  })

  ctx.ipcMain.handle(`${ID}:remove`, (_e, id: unknown) => {
    const entries = readAll(ctx).filter((x) => x.id !== String(id))
    writeAll(ctx, entries)
    return { ok: true, entries: sortEntries(entries) }
  })

  // Settings → Modules: where this app keeps its data.
  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => {
    let base = ''
    try {
      base = ctx.app.getPath('userData')
    } catch {
      /* not available */
    }
    return [
      {
        label: 'Journal entries',
        path: base ? join(base, 'wicked-modules.json') : null,
        note: 'Stored under the "trade-log.entries" key. Included in Backup & Cloud Sync.'
      }
    ]
  })
}
