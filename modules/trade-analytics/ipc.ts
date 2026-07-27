import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import Database from 'better-sqlite3'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { parseWebullCsv, type Execution } from './lib/parse'

/* ------------------------------------------------------------------------ *
 *  TRADE ANALYTICS — main process.
 *
 *  Stores every Webull execution row in a per-module SQLite DB keyed by a
 *  composite `hash` (Webull exports carry no order id), so re-importing a
 *  report that overlaps previous ones is naturally de-duplicated via
 *  INSERT OR IGNORE. Analytics (FIFO round-trips, stats) are computed in the
 *  renderer from the returned executions (see lib/analytics.ts).
 *
 *  AI analysis reads a provider key from the shell's central vault at call time
 *  (Anthropic → OpenAI → Gemini → DeepSeek) and never forwards it to the
 *  renderer.
 * ------------------------------------------------------------------------ */

const ID = 'trade-analytics'
const AI_TIMEOUT_MS = 60_000

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* ------------------------------- database -------------------------------- */

let db: Database.Database | null = null

function moduleDir(app: ModuleIpcContext['app']): string {
  return join(app.getPath('userData'), 'modules', ID)
}

function getDb(app: ModuleIpcContext['app']): Database.Database {
  if (db) return db
  const dir = moduleDir(app)
  mkdirSync(dir, { recursive: true })
  db = new Database(join(dir, 'trades.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      hash TEXT PRIMARY KEY,
      name TEXT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      sideRaw TEXT,
      status TEXT,
      filled INTEGER NOT NULL DEFAULT 0,
      qty REAL NOT NULL DEFAULT 0,
      totalQty REAL NOT NULL DEFAULT 0,
      price REAL NOT NULL DEFAULT 0,
      avgPrice REAL NOT NULL DEFAULT 0,
      limitPrice REAL NOT NULL DEFAULT 0,
      timeInForce TEXT,
      placedText TEXT,
      filledText TEXT,
      filledAt INTEGER,
      placedAt INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_exec_symbol ON executions(symbol);
    CREATE INDEX IF NOT EXISTS idx_exec_filledAt ON executions(filledAt);
  `)
  return db
}

function rowToExecution(r: Record<string, unknown>): Execution {
  return {
    hash: String(r.hash),
    name: String(r.name ?? ''),
    symbol: String(r.symbol),
    side: r.side as Execution['side'],
    sideRaw: String(r.sideRaw ?? ''),
    status: String(r.status ?? ''),
    filled: Number(r.filled) === 1,
    qty: Number(r.qty),
    totalQty: Number(r.totalQty),
    price: Number(r.price),
    avgPrice: Number(r.avgPrice),
    limitPrice: Number(r.limitPrice),
    timeInForce: String(r.timeInForce ?? ''),
    placedText: String(r.placedText ?? ''),
    filledText: String(r.filledText ?? ''),
    filledAt: r.filledAt == null ? null : Number(r.filledAt),
    placedAt: r.placedAt == null ? null : Number(r.placedAt)
  }
}

function insertExecutions(database: Database.Database, execs: Execution[]): number {
  const stmt = database.prepare(`
    INSERT OR IGNORE INTO executions
      (hash, name, symbol, side, sideRaw, status, filled, qty, totalQty, price, avgPrice, limitPrice, timeInForce, placedText, filledText, filledAt, placedAt)
    VALUES
      (@hash, @name, @symbol, @side, @sideRaw, @status, @filled, @qty, @totalQty, @price, @avgPrice, @limitPrice, @timeInForce, @placedText, @filledText, @filledAt, @placedAt)
  `)
  let imported = 0
  const tx = database.transaction((rows: Execution[]) => {
    for (const e of rows) {
      const info = stmt.run({
        hash: e.hash,
        name: e.name,
        symbol: e.symbol,
        side: e.side,
        sideRaw: e.sideRaw,
        status: e.status,
        filled: e.filled ? 1 : 0,
        qty: e.qty,
        totalQty: e.totalQty,
        price: e.price,
        avgPrice: e.avgPrice,
        limitPrice: e.limitPrice,
        timeInForce: e.timeInForce,
        placedText: e.placedText,
        filledText: e.filledText,
        filledAt: e.filledAt,
        placedAt: e.placedAt
      })
      imported += info.changes
    }
  })
  tx(execs)
  return imported
}

function allExecutions(database: Database.Database): Execution[] {
  const rows = database.prepare('SELECT * FROM executions').all() as Record<string, unknown>[]
  return rows.map(rowToExecution)
}

/** Parse one CSV file and import it; returns per-file counts. */
function importCsvFile(
  database: Database.Database,
  path: string
): { file: string; parsed: number; imported: number; skipped: number; errors: number } {
  const text = readFileSync(path, 'utf8')
  const parsed = parseWebullCsv(text)
  const imported = insertExecutions(database, parsed.executions)
  return {
    file: path,
    parsed: parsed.executions.length,
    imported,
    skipped: parsed.executions.length - imported,
    errors: parsed.errors.length
  }
}

/* ------------------------------ AI analysis ------------------------------ */

async function callAi(
  ctx: ModuleIpcContext,
  prompt: string,
  override: { provider: string; key: string } | null,
  signal: AbortSignal
): Promise<{ provider: string; text: string } | { error: string }> {
  const key = (p: string): string | null => (override ? (override.provider === p ? override.key : null) : ctx.getApiKey(p))
  const attempts: string[] = []

  // Anthropic
  const anthropic = key('anthropic')
  if (anthropic) {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropic,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-latest',
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal
      })
      const body = (await resp.json()) as { content?: { text?: string }[]; error?: { message?: string } }
      if (resp.ok && Array.isArray(body.content)) {
        const text = body.content.map((c) => c.text ?? '').join('').trim()
        if (text) return { provider: 'Anthropic (Claude)', text }
      }
      attempts.push(`Anthropic: ${body.error?.message ?? resp.status}`)
    } catch (err) {
      if (signal.aborted) return { error: 'Cancelled.' }
      attempts.push(`Anthropic: ${errMsg(err)}`)
    }
  }
  // OpenAI
  const openai = key('openai')
  if (openai) {
    try {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${openai}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: prompt }] }),
        signal
      })
      const body = (await resp.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } }
      const text = body.choices?.[0]?.message?.content?.trim()
      if (resp.ok && text) return { provider: 'OpenAI (GPT-4o)', text }
      attempts.push(`OpenAI: ${body.error?.message ?? resp.status}`)
    } catch (err) {
      if (signal.aborted) return { error: 'Cancelled.' }
      attempts.push(`OpenAI: ${errMsg(err)}`)
    }
  }
  // Gemini
  const gemini = key('gemini')
  if (gemini) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(gemini)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          signal
        }
      )
      const body = (await resp.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[]
        error?: { message?: string }
      }
      const text = body.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
      if (resp.ok && text) return { provider: 'Google Gemini', text }
      attempts.push(`Gemini: ${body.error?.message ?? resp.status}`)
    } catch (err) {
      if (signal.aborted) return { error: 'Cancelled.' }
      attempts.push(`Gemini: ${errMsg(err)}`)
    }
  }
  // DeepSeek
  const deepseek = key('deepseek')
  if (deepseek) {
    try {
      const resp = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${deepseek}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], stream: false }),
        signal
      })
      const body = (await resp.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } }
      const text = body.choices?.[0]?.message?.content?.trim()
      if (resp.ok && text) return { provider: 'DeepSeek', text }
      attempts.push(`DeepSeek: ${body.error?.message ?? resp.status}`)
    } catch (err) {
      if (signal.aborted) return { error: 'Cancelled.' }
      attempts.push(`DeepSeek: ${errMsg(err)}`)
    }
  }

  if (attempts.length === 0)
    return { error: 'No AI key set. Add an Anthropic, OpenAI, Gemini or DeepSeek key in Settings → API Keys.' }
  return { error: 'AI request failed — ' + attempts.join(' | ') }
}

/* -------------------------------- register ------------------------------- */

export default function register(ctx: ModuleIpcContext): void {
  let aiAbort: AbortController | null = null

  ctx.ipcMain.handle(`${ID}:executions`, () => {
    try {
      return { ok: true, executions: allExecutions(getDb(ctx.app)) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:import-dialog`, async () => {
    const win = ctx.getMainWindow()
    const opts = {
      title: 'Import Webull order records (CSV)',
      properties: ['openFile' as const, 'multiSelections' as const],
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    }
    const res = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true }
    try {
      const database = getDb(ctx.app)
      const files = res.filePaths.map((p) => importCsvFile(database, p))
      return {
        ok: true,
        files,
        imported: files.reduce((n, f) => n + f.imported, 0),
        skipped: files.reduce((n, f) => n + f.skipped, 0),
        executions: allExecutions(database)
      }
    } catch (err) {
      return { ok: false, error: 'Import failed: ' + errMsg(err) }
    }
  })

  // Drag-and-drop path(s) from the renderer (via window.wicked.getPathForFile).
  ctx.ipcMain.handle(`${ID}:import-file`, async (_e, rawPaths: unknown) => {
    const paths = (Array.isArray(rawPaths) ? rawPaths : [rawPaths]).filter(
      (p): p is string => typeof p === 'string' && p.toLowerCase().endsWith('.csv')
    )
    if (paths.length === 0) return { ok: false, error: 'Drop one or more .csv files exported from Webull.' }
    try {
      const database = getDb(ctx.app)
      const files = paths.filter(existsSync).map((p) => importCsvFile(database, p))
      return {
        ok: true,
        files,
        imported: files.reduce((n, f) => n + f.imported, 0),
        skipped: files.reduce((n, f) => n + f.skipped, 0),
        executions: allExecutions(database)
      }
    } catch (err) {
      return { ok: false, error: 'Import failed: ' + errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:clear`, () => {
    try {
      getDb(ctx.app).exec('DELETE FROM executions')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:ai-analyze`, async (_e, rawReq: unknown) => {
    const req = (typeof rawReq === 'object' && rawReq !== null ? rawReq : {}) as Record<string, unknown>
    const prompt = typeof req.prompt === 'string' ? req.prompt : ''
    if (!prompt.trim()) return { ok: false, error: 'Nothing to analyze — import some trades first.' }
    const override =
      typeof req.keyOverride === 'object' && req.keyOverride !== null
        ? {
            provider: String((req.keyOverride as Record<string, unknown>).provider ?? '').toLowerCase(),
            key: String((req.keyOverride as Record<string, unknown>).key ?? '')
          }
        : null

    if (aiAbort) return { ok: false, error: 'An analysis request is already running.' }
    const controller = new AbortController()
    aiAbort = controller
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS)
    try {
      const res = await callAi(ctx, prompt, override && override.key ? override : null, controller.signal)
      if ('error' in res) return { ok: false, error: res.error }
      return { ok: true, provider: res.provider, text: res.text }
    } finally {
      clearTimeout(timer)
      aiAbort = null
    }
  })

  ctx.ipcMain.handle(`${ID}:cancel`, () => {
    if (aiAbort) {
      aiAbort.abort()
      return { ok: true, cancelled: true }
    }
    return { ok: true, cancelled: false }
  })

  // The renderer builds the PDF (shared jsPDF renderer) and sends bytes; the
  // user picks where it goes (defaults next to the Stock Trading exports).
  ctx.ipcMain.handle(`${ID}:save-pdf`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const b64 = typeof r.data === 'string' ? r.data : ''
    if (!b64) return { ok: false, error: 'No PDF data.' }
    const stamp = new Date()
    const name = `Trade Journal report ${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')}-${stamp.getFullYear()}.pdf`
    const win = ctx.getMainWindow()
    const opts = {
      title: 'Save trading report',
      defaultPath: join(ctx.app.getPath('documents'), 'Stock Trading', name),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    }
    try {
      const picked = win ? await ctx.dialog.showSaveDialog(win, opts) : await ctx.dialog.showSaveDialog(opts)
      if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true }
      mkdirSync(dirname(picked.filePath), { recursive: true })
      writeFileSync(picked.filePath, Buffer.from(b64, 'base64'))
      ctx.shell.showItemInFolder(picked.filePath)
      return { ok: true, file: picked.filePath }
    } catch (err) {
      return { ok: false, error: 'Could not save the PDF: ' + errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => {
    const dbFile = join(moduleDir(ctx.app), 'trades.db')
    return [
      {
        label: 'Trade database',
        path: existsSync(dbFile) ? dbFile : null,
        note: 'Imported Webull executions (SQLite, de-duplicated by order fingerprint)'
      }
    ]
  })
}
