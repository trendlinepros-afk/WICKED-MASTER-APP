import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import type { ModuleIpcContext } from '../../src/main/module-ipc'

/**
 * TRENDLINE CHARTS — main process. Talks to TrendlineFinder's private partner
 * API (https://app.trendlinefinder.com/api/partner/v1), which returns a finished
 * chart PNG with algorithmic support/resistance trendlines drawn on it.
 *
 * The API key (`tlf_live_…`) lives in the central vault (Settings → API Keys,
 * provider id `trendlinefinder`) and is read ONLY here in main — it is never sent
 * to the renderer. The renderer receives finished PNGs as data URLs, plus a
 * has-key boolean. All fetches are fail-soft with friendly, code-specific errors.
 */

const ID = 'trendline-charts'
const BASE = 'https://app.trendlinefinder.com/api/partner/v1'
const TIMEOUT_MS = 20_000

const HORIZONS = ['30d', '90d', '6mo', '1y'] as const
const INTERVALS = ['15m', '30m', '1h', '4h', '1d'] as const
const HORIZON_ALIAS: Record<string, string> = {
  '1mo': '30d',
  '3mo': '90d',
  '6m': '6mo',
  '1yr': '1y',
  '12mo': '1y'
}

interface ModuleDataPath {
  label: string
  path: string | null
  note?: string
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Normalize a caller's horizon list: apply aliases, keep only known pairs,
 *  de-dupe, and order canonically (30d, 90d, 6mo, 1y). */
function normalizeHorizons(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',')
      : []
  const set = new Set<string>()
  for (const h of raw) {
    const k = String(h).trim().toLowerCase()
    const canon = HORIZON_ALIAS[k] ?? k
    if ((HORIZONS as readonly string[]).includes(canon)) set.add(canon)
  }
  return HORIZONS.filter((h) => set.has(h))
}

interface ChartParams {
  ticker: string
  horizons: string[]
  interval: string
  width: number
  height: number
  branding: boolean
}

function readParams(raw: unknown): ChartParams | null {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const ticker = typeof r.ticker === 'string' ? r.ticker.trim().toUpperCase() : ''
  if (!ticker) return null
  const interval =
    typeof r.interval === 'string' && (INTERVALS as readonly string[]).includes(r.interval) ? r.interval : '4h'
  const clamp = (v: unknown, min: number, max: number, dflt: number): number => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt
  }
  return {
    ticker,
    horizons: normalizeHorizons(r.horizons),
    interval,
    width: clamp(r.width, 320, 2400, 1200),
    height: clamp(r.height, 240, 1600, 640),
    branding: r.branding !== false
  }
}

function friendly(status: number, msg: string, ticker: string): string {
  switch (status) {
    case 401:
      return 'TrendlineFinder API key invalid or revoked — check Settings → API Keys.'
    case 404:
      return `No price data for "${ticker}".`
    case 400:
      return msg || 'Bad chart parameters.'
    case 500:
      return 'TrendlineFinder had an upstream market-data error. Try again in a few seconds.'
    case 0:
      return 'Could not reach TrendlineFinder (network error).'
    default:
      return msg || `TrendlineFinder returned an error (HTTP ${status}).`
  }
}

type FetchResult =
  | { ok: true; buffer: Buffer; contentType: string; spanDays: string; horizons: string }
  | { ok: false; status: number; error: string }

/** One HTTP attempt at GET /chart.png. Never throws — network failures map to status 0. */
async function chartAttempt(p: ChartParams, key: string): Promise<FetchResult> {
  const qs = new URLSearchParams({ ticker: p.ticker })
  if (p.horizons.length) qs.set('horizons', p.horizons.join(','))
  qs.set('interval', p.interval)
  qs.set('width', String(p.width))
  qs.set('height', String(p.height))
  if (!p.branding) qs.set('branding', '0')

  let res: Response
  try {
    res = await fetch(`${BASE}/chart.png?${qs.toString()}`, {
      headers: { 'X-API-Key': key },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch {
    return { ok: false, status: 0, error: friendly(0, '', p.ticker) }
  }
  if (res.ok) {
    return {
      ok: true,
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'image/png',
      spanDays: res.headers.get('X-Chart-Span-Days') ?? '',
      horizons: res.headers.get('X-Chart-Horizons') ?? p.horizons.join(',')
    }
  }
  let msg = ''
  try {
    const j = (await res.json()) as { message?: string; error?: string }
    msg = j.message || j.error || ''
  } catch {
    /* non-JSON error body */
  }
  return { ok: false, status: res.status, error: friendly(res.status, msg, p.ticker) }
}

/** Fetch a chart PNG, retrying ONCE on a 500/network error (per the API brief). */
async function fetchChartPng(p: ChartParams, key: string): Promise<FetchResult> {
  const first = await chartAttempt(p, key)
  if (first.ok || (first.status !== 500 && first.status !== 0)) return first
  await sleep(2500)
  return chartAttempt(p, key)
}

export default function register(ctx: ModuleIpcContext): void {
  const getKey = (): string | null => ctx.getApiKey('trendlinefinder')

  const exportsDir = (): string => join(ctx.app.getPath('downloads'), 'Trendline Charts')

  interface Recent {
    ticker: string
    horizons: string[]
    interval: string
    at: number
  }
  const RECENTS_KEY = `${ID}.recents`
  const readRecents = (): Recent[] => ctx.storeGet<Recent[]>(RECENTS_KEY, [])
  const pushRecent = (p: ChartParams): void => {
    const entry: Recent = { ticker: p.ticker, horizons: p.horizons, interval: p.interval, at: Date.now() }
    const sig = (r: Recent): string => `${r.ticker}|${r.horizons.join(',')}|${r.interval}`
    const next = [entry, ...readRecents().filter((r) => sig(r) !== sig(entry))].slice(0, 12)
    ctx.storeSet(RECENTS_KEY, next)
  }

  /** Save a PNG buffer into Downloads/Trendline Charts and return its path. */
  const saveBuffer = (ticker: string, buf: Buffer): string => {
    const folder = exportsDir()
    mkdirSync(folder, { recursive: true })
    const d = new Date()
    const p2 = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${d.getFullYear()} ${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`
    const file = join(folder, `${ticker} trendlines ${stamp}.png`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, buf)
    return file
  }

  // Presence-only status for the renderer (never the key value).
  ctx.ipcMain.handle(`${ID}:status`, () => ({ ok: true, hasKey: !!getKey() }))

  // Verify the key against GET /health. Optional apiKey override for the MCP path
  // (which must not auto-use the vault); the UI passes nothing and uses the vault.
  ctx.ipcMain.handle(`${ID}:health`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const key = (typeof r.apiKey === 'string' && r.apiKey.trim()) || getKey()
    if (!key) return { ok: false, error: 'No TrendlineFinder API key set. Add it in Settings → API Keys.' }
    try {
      const res = await fetch(`${BASE}/health`, {
        headers: { 'X-API-Key': key },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (res.status === 401) return { ok: false, error: 'API key invalid or revoked.' }
      if (!res.ok) return { ok: false, error: `Health check failed (HTTP ${res.status}).` }
      const j = (await res.json()) as { ok?: boolean; keyName?: string }
      return { ok: true, keyName: typeof j.keyName === 'string' ? j.keyName : '' }
    } catch (err) {
      return { ok: false, error: 'Could not reach TrendlineFinder: ' + errMsg(err) }
    }
  })

  // Fetch a chart for display — returns a data URL (never the key). Used by the UI.
  ctx.ipcMain.handle(`${ID}:chart`, async (_e, raw: unknown) => {
    const p = readParams(raw)
    if (!p) return { ok: false, error: 'A ticker symbol is required.' }
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const key = (typeof r.apiKey === 'string' && r.apiKey.trim()) || getKey()
    if (!key) return { ok: false, error: 'No TrendlineFinder API key set. Add it in Settings → API Keys.' }
    const res = await fetchChartPng(p, key)
    if (!res.ok) return { ok: false, error: res.error }
    pushRecent(p)
    return {
      ok: true,
      dataUrl: `data:${res.contentType};base64,${res.buffer.toString('base64')}`,
      spanDays: res.spanDays,
      horizons: res.horizons,
      ticker: p.ticker
    }
  })

  // Save a PNG the UI already has in hand (base64, with or without data-URL prefix)
  // into the user's Downloads folder. Works on any machine.
  ctx.ipcMain.handle(`${ID}:save`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const ticker = typeof r.ticker === 'string' && r.ticker.trim() ? r.ticker.trim().toUpperCase() : 'CHART'
    const data = typeof r.data === 'string' ? r.data.replace(/^data:image\/\w+;base64,/, '') : ''
    if (!data) return { ok: false, error: 'No image to save.' }
    try {
      const file = saveBuffer(ticker, Buffer.from(data, 'base64'))
      ctx.shell.showItemInFolder(file)
      return { ok: true, file }
    } catch (err) {
      return { ok: false, error: 'Could not save the PNG: ' + errMsg(err) }
    }
  })

  // Fetch AND save in one step, returning the file path — used by the MCP tool so
  // agents get a file reference instead of a huge base64 blob in their context.
  ctx.ipcMain.handle(`${ID}:chart-file`, async (_e, raw: unknown) => {
    const p = readParams(raw)
    if (!p) return { ok: false, error: 'A ticker symbol is required.' }
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const key = (typeof r.apiKey === 'string' && r.apiKey.trim()) || getKey()
    if (!key) return { ok: false, error: 'No TrendlineFinder API key set. Add it in Settings → API Keys.' }
    const res = await fetchChartPng(p, key)
    if (!res.ok) return { ok: false, error: res.error }
    try {
      pushRecent(p)
      const file = saveBuffer(p.ticker, res.buffer)
      return { ok: true, file, spanDays: res.spanDays, horizons: res.horizons }
    } catch (err) {
      return { ok: false, error: 'Could not save the PNG: ' + errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:recents`, () => ({ ok: true, rows: readRecents() }))
  ctx.ipcMain.handle(`${ID}:recents-clear`, () => {
    ctx.storeSet(RECENTS_KEY, [])
    return { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:reveal-exports`, async () => {
    const dir = exportsDir()
    if (!existsSync(dir)) return { ok: false, error: 'No charts saved yet.' }
    await ctx.shell.openPath(dir)
    return { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => {
    const dir = exportsDir()
    return [{ label: 'Saved charts', path: existsSync(dir) ? dir : null, note: 'Exported PNGs in your Downloads folder' }]
  })
}
