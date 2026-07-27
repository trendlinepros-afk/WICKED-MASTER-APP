import express from 'express'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import type { Server } from 'http'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getAggregates, searchTickers } from '../../stock-planner/ipc/market/massive'
import { resolutionToMassive, SUPPORTED_RESOLUTIONS } from './udf'

/**
 * Localhost host for the TradingView Charting Library (127.0.0.1 only,
 * started on demand). Serves:
 *   /                    the chart page (widget config + datafeed + save/load)
 *   /charting_library/*  the user's licensed library folder (not bundled!)
 *   /api/search|history  Massive-backed datafeed endpoints
 *   /api/layouts…        layout CRUD (JSON files under userData)
 *
 * Same architecture as the ported web app (browser-side library + UDF-ish
 * routes), which also keeps the shell CSP intact — the library runs inside a
 * webview pointed at this server, not in the shell renderer.
 */

const MAX_LAYOUT_BYTES = 8 * 1024 * 1024

export interface ChartServerDeps {
  getMassiveKey: () => string | null
  libraryPath: () => string
  layoutsDir: string
}

let server: Server | null = null
let serverUrl = ''

interface LayoutMeta {
  id: string
  name: string
  symbol: string
  resolution: string
  timestamp: number
}

function layoutFile(dir: string, id: string): string {
  return join(dir, `${id.replace(/[^a-zA-Z0-9-]/g, '')}.json`)
}

function listLayouts(dir: string): LayoutMeta[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as LayoutMeta
        return { id: j.id, name: j.name, symbol: j.symbol, resolution: j.resolution, timestamp: j.timestamp }
      } catch {
        return null
      }
    })
    .filter((l): l is LayoutMeta => l !== null)
    .sort((a, b) => b.timestamp - a.timestamp)
}

/** The chart host page: widget config per the ported spec + tiny adapters. */
function pageHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Advanced Charts</title>
<style>html,body,#tv{margin:0;height:100%;background:#0b1022}</style></head>
<body><div id="tv"></div>
<script src="/charting_library/charting_library.standalone.js"></script>
<script>
const RESOLUTIONS = ${JSON.stringify(SUPPORTED_RESOLUTIONS)};
const subs = {};
const datafeed = {
  onReady: cb => setTimeout(() => cb({ supported_resolutions: RESOLUTIONS, supports_time: true }), 0),
  searchSymbols: async (q, ex, type, cb) => {
    try { cb(await (await fetch('/api/search?q=' + encodeURIComponent(q))).json()) } catch { cb([]) }
  },
  // LOCAL/synthetic resolve: no network (ported). pricescale 100 = 2 decimals.
  resolveSymbol: (name, ok) => setTimeout(() => ok({
    name, ticker: name.toUpperCase(), description: name.toUpperCase(), type: 'stock',
    session: '0930-1600', timezone: 'America/New_York', exchange: '', listed_exchange: '',
    format: 'price', minmov: 1, pricescale: 100, has_intraday: true,
    has_weekly_and_monthly: true, supported_resolutions: RESOLUTIONS,
    volume_precision: 0, data_status: 'delayed_streaming'
  }), 0),
  getBars: async (info, resolution, period, onResult, onError) => {
    try {
      const r = await fetch('/api/history?symbol=' + encodeURIComponent(info.ticker) +
        '&resolution=' + encodeURIComponent(resolution) + '&from=' + period.from + '&to=' + period.to);
      const j = await r.json();
      const bars = j.bars || [];
      onResult(bars, { noData: bars.length === 0 });
    } catch (e) { onError(String(e)); }
  },
  // POLLING every 30s (no websocket anywhere — data_status delayed_streaming)
  subscribeBars: (info, resolution, onTick, uid) => {
    subs[uid] = setInterval(async () => {
      try {
        const to = Math.floor(Date.now() / 1000);
        const from = to - 3 * 86400;
        const r = await fetch('/api/history?symbol=' + encodeURIComponent(info.ticker) +
          '&resolution=' + encodeURIComponent(resolution) + '&from=' + from + '&to=' + to + '&tail=3');
        const j = await r.json();
        const bars = j.bars || [];
        if (bars.length) onTick(bars[bars.length - 1]);
      } catch { /* poll again next tick */ }
    }, 30000);
  },
  unsubscribeBars: uid => { clearInterval(subs[uid]); delete subs[uid]; }
};
const saveLoad = {
  getAllCharts: () => fetch('/api/layouts').then(r => r.json()),
  removeChart: id => fetch('/api/layouts/' + id, { method: 'DELETE' }).then(() => undefined),
  saveChart: async (data) => {
    const r = await fetch('/api/layouts', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: data.id, name: data.name, symbol: data.symbol, resolution: data.resolution, content: data.content }) });
    return (await r.json()).id;
  },
  getChartContent: id => fetch('/api/layouts/' + id).then(r => r.json()).then(j => j.content),
  // templates are stubbed empty (ported behavior)
  getAllStudyTemplates: () => Promise.resolve([]), removeStudyTemplate: () => Promise.resolve(),
  saveStudyTemplate: () => Promise.resolve(), getStudyTemplateContent: () => Promise.resolve(''),
  getDrawingTemplates: () => Promise.resolve([]), loadDrawingTemplate: () => Promise.resolve(''),
  removeDrawingTemplate: () => Promise.resolve(), saveDrawingTemplate: () => Promise.resolve(),
  getAllChartTemplates: () => Promise.resolve([]), getChartTemplateContent: () => Promise.resolve({}),
  removeChartTemplate: () => Promise.resolve(), saveChartTemplate: () => Promise.resolve()
};
const small = window.innerWidth < 640;
window.tvWidget = new TradingView.widget({
  container: 'tv', library_path: '/charting_library/', symbol: 'AAPL', interval: '15',
  theme: 'dark', autosize: true, timezone: 'America/New_York', locale: 'en',
  datafeed, save_load_adapter: saveLoad,
  enabled_features: ['header_saveload'],
  disabled_features: ['use_localstorage_for_settings'].concat(small ? ['left_toolbar'] : []),
  loading_screen: { backgroundColor: '#0b1022', foregroundColor: '#21d4fd' },
  ...(small ? { hide_side_toolbar: true } : {})
});
</script></body></html>`
}

export function chartServerUrl(): string {
  return serverUrl
}

export async function startChartServer(deps: ChartServerDeps): Promise<{ url: string }> {
  if (server && serverUrl) return { url: serverUrl }
  mkdirSync(deps.layoutsDir, { recursive: true })
  const app = express()
  app.use(express.json({ limit: '10mb' }))

  app.get('/', (_req, res) => {
    res.type('html').send(pageHtml())
  })
  // the user's licensed library folder (validated before start)
  app.use('/charting_library', (req, res, next) => {
    const dir = deps.libraryPath()
    if (!dir) {
      res.status(404).send('charting library not configured')
      return
    }
    express.static(dir)(req, res, next)
  })

  app.get('/api/search', async (req, res) => {
    const key = deps.getMassiveKey()
    const q = String(req.query.q ?? '')
    if (!key || !q) {
      res.json([])
      return
    }
    const hits = await searchTickers(key, q)
    res.json(
      hits.map((h) => ({
        symbol: h.ticker,
        ticker: h.ticker,
        full_name: h.ticker,
        description: h.name,
        exchange: '',
        type: 'stock'
      }))
    )
  })

  app.get('/api/history', async (req, res) => {
    const key = deps.getMassiveKey()
    if (!key) {
      res.json({ bars: [] })
      return
    }
    const symbol = String(req.query.symbol ?? '').toUpperCase()
    const resolution = String(req.query.resolution ?? '1D')
    const from = Number(req.query.from) * 1000
    const to = Number(req.query.to) * 1000
    const tail = Number(req.query.tail) || 0
    if (!symbol || !Number.isFinite(from) || !Number.isFinite(to)) {
      res.json({ bars: [] })
      return
    }
    const { mult, timespan } = resolutionToMassive(resolution)
    let bars = await getAggregates(key, symbol, mult, timespan, from, to)
    if (tail > 0) bars = bars.slice(-tail)
    res.json({
      bars: bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }))
    })
  })

  /* ------------------------------ layouts ------------------------------- */

  app.get('/api/layouts', (_req, res) => {
    res.json(listLayouts(deps.layoutsDir))
  })
  app.get('/api/layouts/:id', (req, res) => {
    try {
      res.json(JSON.parse(readFileSync(layoutFile(deps.layoutsDir, req.params.id), 'utf8')))
    } catch {
      res.status(404).json({ error: 'not found' })
    }
  })
  app.post('/api/layouts', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
    if (content.length > MAX_LAYOUT_BYTES) {
      res.status(413).json({ error: 'layout too large (8MB cap)' })
      return
    }
    const id = typeof b.id === 'string' && b.id ? b.id : randomUUID()
    const meta = {
      id,
      name: String(b.name ?? 'Layout'),
      symbol: String(b.symbol ?? ''),
      resolution: String(b.resolution ?? ''),
      timestamp: Math.floor(Date.now() / 1000),
      content
    }
    writeFileSync(layoutFile(deps.layoutsDir, id), JSON.stringify(meta), 'utf8')
    res.json({ id })
  })
  app.delete('/api/layouts/:id', (req, res) => {
    rmSync(layoutFile(deps.layoutsDir, req.params.id), { force: true })
    res.json({ ok: true })
  })

  return await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => {
      server = s
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      serverUrl = `http://127.0.0.1:${port}`
      resolve({ url: serverUrl })
    })
    s.on('error', reject)
  })
}
