import { desktopCapturer } from 'electron'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { callAi, type AiKeys, type AiMessage } from '../stock-planner/ipc/ai'
import { getMinuteBars, getNbbo, type MinuteBar, type WebullKeys } from '../options-assistant/webull'
import type { Action, AnalyzeResult, CopilotStatus, PositionState, QuoteLite, SessionSummary, Verdict } from './types'

/**
 * LIVE TRADE COPILOT — main process.
 *
 * The renderer captures the user's Firefox/TradingView window (desktopCapturer
 * source id → getUserMedia) and every N seconds sends ONE JPEG frame here via
 * invoke (never webContents.send — that path is mirrored to LAN web clients).
 * Each analyze pass is HYBRID: the chart screenshot PLUS live numeric context
 * from the user's Webull OpenAPI (1-minute bars incl. the forming bar, NBBO
 * top-of-book, VWAP, day range), fed to a vision model that answers with a
 * strict-JSON verdict: BUY / SELL / HOLD / WAIT, named pattern callouts,
 * support/resistance, and an exit hint. A rolling memory of the session's
 * recent calls keeps the model consistent tick-to-tick.
 *
 * All electron API usage stays inside register()/handlers — module scope runs
 * before app.whenReady.
 */

const ID = 'live-trade-copilot'
const MEMORY_CAP = 10

interface Session {
  id: string
  symbol: string
  startedAt: number
  memory: { t: number; action: Action; confidence: number; oneLiner: string }[]
  lastVerdict: (Verdict & { t: number }) | null
  verdictCount: number
}

/* ------------------------------ verdict parse ------------------------------ */

const ACTIONS: Action[] = ['BUY', 'SELL', 'HOLD', 'WAIT']

function parseVerdict(raw: string): Verdict | null {
  try {
    let s = raw.trim()
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) s = fence[1]
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a >= 0 && b > a) s = s.slice(a, b + 1)
    const o = JSON.parse(s) as Record<string, unknown>
    const actionRaw = String(o.action ?? '').toUpperCase()
    const action: Action = (ACTIONS as string[]).includes(actionRaw) ? (actionRaw as Action) : 'WAIT'
    const biasRaw = String(o.bias ?? '').toLowerCase()
    const bias = biasRaw === 'bullish' || biasRaw === 'bearish' ? biasRaw : 'neutral'
    const nums = (v: unknown): number[] =>
      Array.isArray(v)
        ? v
            .map(Number)
            .filter(Number.isFinite)
            .slice(0, 4)
        : []
    const levels = (typeof o.levels === 'object' && o.levels !== null ? o.levels : {}) as Record<string, unknown>
    const patterns = Array.isArray(o.patterns)
      ? o.patterns
          .map((p) => (typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : {}))
          .filter((p) => p.name)
          .map((p) => {
            const st = String(p.status ?? '').toLowerCase()
            return {
              name: String(p.name).slice(0, 60),
              status: (st === 'confirmed' || st === 'failed' ? st : 'forming') as 'forming' | 'confirmed' | 'failed'
            }
          })
          .slice(0, 6)
      : []
    return {
      action,
      bias,
      confidence: Math.max(0, Math.min(100, Math.round(Number(o.confidence) || 0))),
      patterns,
      levels: { support: nums(levels.support), resistance: nums(levels.resistance) },
      oneLiner: String(o.one_liner ?? o.oneLiner ?? '').slice(0, 200),
      detail: String(o.detail ?? '').slice(0, 1200),
      exitHint: String(o.exit_hint ?? o.exitHint ?? '').slice(0, 300)
    }
  } catch {
    return null
  }
}

/* ------------------------------ live data calc ----------------------------- */

const ET_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit'
})

/** Compact numeric context from the day's minute bars for the prompt. */
function liveDataBlock(bars: MinuteBar[], nbbo: QuoteLite): string {
  const last = bars[bars.length - 1]
  // today's RTH-ish VWAP: use all fetched bars from today's ET date
  const lastDay = new Date(last.t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const today = bars.filter(
    (b) => new Date(b.t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === lastDay
  )
  let pv = 0
  let vol = 0
  let hi = -Infinity
  let lo = Infinity
  for (const b of today) {
    pv += ((b.h + b.l + b.c) / 3) * b.v
    vol += b.v
    if (b.h > hi) hi = b.h
    if (b.l < lo) lo = b.l
  }
  const vwap = vol > 0 ? pv / vol : null
  const sma20 =
    bars.length >= 20 ? bars.slice(-20).reduce((s, b) => s + b.c, 0) / 20 : null
  const f = (n: number | null): string => (n == null ? '—' : n.toFixed(n >= 100 ? 2 : 3))
  const rows = bars
    .slice(-30)
    .map((b) => `${ET_TIME.format(new Date(b.t))} ${f(b.o)} ${f(b.h)} ${f(b.l)} ${f(b.c)} ${Math.round(b.v)}`)
    .join('\n')
  const spread = nbbo.bid != null && nbbo.ask != null ? (nbbo.ask - nbbo.bid).toFixed(3) : '—'
  return [
    `LIVE DATA (Webull, ${new Date().toISOString()}):`,
    `Last ${f(last.c)} · NBBO ${f(nbbo.bid)} x ${f(nbbo.ask)} (spread ${spread})`,
    `Today VWAP ${f(vwap)} · day high ${f(hi === -Infinity ? null : hi)} / low ${f(lo === Infinity ? null : lo)} · 20-bar SMA ${f(sma20)}`,
    `Last 30 one-minute bars, oldest first (ET time O H L C Vol) — the final row is the FORMING bar:`,
    rows
  ].join('\n')
}

/* -------------------------------- register -------------------------------- */

export default function register(ctx: ModuleIpcContext): void {
  const SESSIONS_KEY = `${ID}.sessions`
  let current: Session | null = null

  const webullKeys = (): WebullKeys | null => {
    const appKey = ctx.getApiKey('webull-app-key')
    const appSecret = ctx.getApiKey('webull-app-secret')
    return appKey && appSecret ? { appKey, appSecret } : null
  }
  const aiKeys = (): AiKeys => ({
    anthropic: ctx.getApiKey('anthropic'),
    gemini: ctx.getApiKey('gemini'),
    deepseek: ctx.getApiKey('deepseek'),
    openai: ctx.getApiKey('openai')
  })
  // vision needs Claude / Gemini / OpenAI (DeepSeek can't see images)
  const hasVisionAi = (): boolean => {
    const k = aiKeys()
    return !!(k.anthropic || k.gemini || k.openai)
  }

  const statusOf = (): CopilotStatus => ({
    running: current !== null,
    symbol: current?.symbol ?? null,
    startedAt: current?.startedAt ?? null,
    verdictCount: current?.verdictCount ?? 0,
    lastVerdict: current?.lastVerdict ?? null
  })

  ctx.ipcMain.handle(`${ID}:status`, () => ({ ok: true, ...statusOf(), hasWebull: webullKeys() !== null, hasAi: hasVisionAi() }))

  /** Capturable windows/screens for the picker (thumbnails as data URLs). */
  ctx.ipcMain.handle(`${ID}:list-sources`, async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 320, height: 180 }
      })
      return {
        ok: true,
        sources: sources.map((s) => ({ id: s.id, name: s.name.slice(0, 80), thumbnail: s.thumbnail.toDataURL() }))
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:start-session`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const symbol =
      typeof r.symbol === 'string' ? r.symbol.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 6) : ''
    if (!hasVisionAi())
      return { ok: false, error: 'Add a vision-capable AI key (Anthropic, Gemini or OpenAI) in Settings → API Keys.' }
    current = {
      id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      symbol,
      startedAt: Date.now(),
      memory: [],
      lastVerdict: null,
      verdictCount: 0
    }
    return { ok: true, sessionId: current.id, hasWebull: webullKeys() !== null, hasAi: true }
  })

  ctx.ipcMain.handle(`${ID}:analyze`, async (_e, raw: unknown): Promise<AnalyzeResult> => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    if (!current || r.sessionId !== current.id) return { ok: false, error: 'Session ended.' }
    const session = current
    const image = typeof r.image === 'string' && r.image.startsWith('data:image/') ? r.image : ''
    if (!image) return { ok: false, error: 'No frame captured.' }
    if (image.length > 6_000_000) return { ok: false, error: 'Captured frame too large.' }
    const model = r.model === 'pro' ? 'pro' : 'lite'
    const pos = (typeof r.position === 'object' && r.position !== null ? r.position : {}) as PositionState

    // live numeric context (fail-soft: a bad tick degrades to vision-only)
    const keys = webullKeys()
    let barsOk = false
    let barsError: string | undefined
    let dataBlock = ''
    let quote: QuoteLite | null = null
    if (keys && session.symbol) {
      const [barsRes, nbboRes] = await Promise.allSettled([
        getMinuteBars(keys, session.symbol, 420),
        getNbbo(keys, session.symbol)
      ])
      if (barsRes.status === 'fulfilled' && barsRes.value.length > 0) {
        const nbbo: QuoteLite =
          nbboRes.status === 'fulfilled'
            ? { bid: nbboRes.value.bid, ask: nbboRes.value.ask, last: barsRes.value[barsRes.value.length - 1].c }
            : { bid: null, ask: null, last: barsRes.value[barsRes.value.length - 1].c }
        dataBlock = liveDataBlock(barsRes.value, nbbo)
        quote = nbbo
        barsOk = true
      } else {
        barsError = barsRes.status === 'rejected' ? String(barsRes.reason?.message ?? barsRes.reason) : 'No bars returned.'
      }
    } else if (!keys) {
      barsError = 'Webull keys not set — vision-only.'
    } else {
      barsError = 'No ticker set — vision-only.'
    }

    const posLine = pos.inPosition
      ? `POSITION: LONG from $${Number(pos.entryPrice ?? 0).toFixed(2)} — exit management comes FIRST: HOLD = stay in, SELL = exit NOW.`
      : 'POSITION: FLAT — BUY = enter long now, SELL = short bias / do not buy, WAIT = no edge yet.'
    const memoryBlock =
      session.memory.length > 0
        ? session.memory
            .map((m) => `${ET_TIME.format(new Date(m.t))} ${m.action} ${m.confidence} — ${m.oneLiner}`)
            .join('\n')
        : '(none yet — this is your first look this session)'

    const system: AiMessage = {
      role: 'system',
      text: [
        `You are a live scalp-trading copilot watching a 1-minute chart of ${session.symbol || 'the ticker on screen'}. The trader holds for 1-10 minutes.`,
        'Each check you get: (1) a screenshot of their TradingView window, (2) live market data when available (1-min OHLCV bars, NBBO, VWAP, day range), (3) your own recent calls.',
        'Trust the NUMBERS for exact prices and levels; use the IMAGE for indicators, drawings, and structure the numbers cannot show. If they disagree, say so.',
        posLine,
        'Rules:',
        '- WAIT is the default. Call BUY or SELL only on concrete visible evidence, and name in `detail` what confirmed it (or what would).',
        '- Call out patterns (bull/bear flag, double top/bottom, VWAP reclaim/reject, break-and-retest, engulfing, higher-lows/lower-highs, range break) ONLY when the chart supports them, with status forming/confirmed/failed. Never invent a pattern to sound useful.',
        '- Mind liquidity: a wide NBBO spread makes fast scalps expensive — factor it into confidence.',
        '- Stay consistent with YOUR RECENT CALLS below; if you flip, explain why in `detail`.',
        '- confidence is honest, 0-100.',
        'YOUR RECENT CALLS (oldest first):',
        memoryBlock,
        'Respond with ONLY this JSON — no fences, no prose:',
        '{"action":"BUY|SELL|HOLD|WAIT","bias":"bullish|bearish|neutral","confidence":0,"patterns":[{"name":"","status":"forming|confirmed|failed"}],"levels":{"support":[],"resistance":[]},"one_liner":"<=120 chars","detail":"2-3 sentences","exit_hint":"target/stop or -"}'
      ].join('\n')
    }
    const user: AiMessage = {
      role: 'user',
      text: dataBlock || `LIVE DATA UNAVAILABLE (${barsError ?? 'unknown'}) — analyze from the chart image alone; treat exact price readings as approximate.`,
      images: [image]
    }

    const ai = await callAi(aiKeys(), [system, user], { json: true, tier: model })
    if (!ai.ok) return { ok: false, error: ai.error }
    const verdict = parseVerdict(ai.text)
    if (!verdict) return { ok: false, error: 'The model returned unreadable output — skipping this tick.' }

    const t = Date.now()
    session.memory.push({ t, action: verdict.action, confidence: verdict.confidence, oneLiner: verdict.oneLiner })
    if (session.memory.length > MEMORY_CAP) session.memory.splice(0, session.memory.length - MEMORY_CAP)
    session.lastVerdict = { ...verdict, t }
    session.verdictCount++

    return { ok: true, verdict, t, provider: ai.provider, barsOk, barsError, quote }
  })

  ctx.ipcMain.handle(`${ID}:stop-session`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    if (current && r.sessionId === current.id) current = null
    const s = (typeof r.summary === 'object' && r.summary !== null ? r.summary : null) as SessionSummary | null
    if (s && s.symbol != null && Number(s.verdictCount) > 0) {
      const hist = ctx.storeGet<unknown[]>(SESSIONS_KEY, [])
      const list = Array.isArray(hist) ? hist : []
      list.unshift({
        symbol: String(s.symbol).slice(0, 6),
        startedAt: Number(s.startedAt) || Date.now(),
        endedAt: Number(s.endedAt) || Date.now(),
        verdictCount: Number(s.verdictCount) || 0,
        flips: Number(s.flips) || 0,
        lastAction: s.lastAction ?? null,
        note: typeof s.note === 'string' ? s.note.slice(0, 120) : undefined
      })
      ctx.storeSet(SESSIONS_KEY, list.slice(0, 20))
    }
    return { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:get-history`, () => {
    const hist = ctx.storeGet<unknown[]>(SESSIONS_KEY, [])
    return { ok: true, sessions: (Array.isArray(hist) ? hist : []).slice(0, 20) }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => [
    {
      label: 'Session history',
      path: null,
      note: 'Stored in the shared module store (live-trade-copilot.sessions key)'
    }
  ])
}
