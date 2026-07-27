import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { parseWebullCsv, type Execution, type Side } from './lib/parse'
import { etParts } from './lib/et'
import { classifySector } from './lib/sector'
import { getTickerDetails } from '../stock-planner/ipc/market/massive'

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

/** The current executions schema — dedup is scoped PER ACCOUNT (composite PK). */
const EXEC_SCHEMA = `
  CREATE TABLE IF NOT EXISTS executions (
    account TEXT NOT NULL DEFAULT 'default',
    hash TEXT NOT NULL,
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
    placedAt INTEGER,
    PRIMARY KEY (account, hash)
  );
  CREATE INDEX IF NOT EXISTS idx_exec_symbol ON executions(symbol);
  CREATE INDEX IF NOT EXISTS idx_exec_filledAt ON executions(filledAt);
  CREATE INDEX IF NOT EXISTS idx_exec_account ON executions(account);
`

const DEFAULT_ACCOUNT = { id: 'default', name: 'Default' }

function getDb(app: ModuleIpcContext['app']): Database.Database {
  if (db) return db
  const dir = moduleDir(app)
  mkdirSync(dir, { recursive: true })
  db = new Database(join(dir, 'trades.db'))
  db.pragma('journal_mode = WAL')

  // accounts registry (named; can exist with zero executions)
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      createdAt INTEGER NOT NULL DEFAULT 0
    );
  `)

  // Migrate a pre-account executions table (hash PK, no account column) in
  // place: everything it holds belongs to the 'default' account.
  const hasExec = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='executions'")
    .get()
  if (hasExec) {
    const cols = db.prepare('PRAGMA table_info(executions)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'account')) {
      db.exec('ALTER TABLE executions RENAME TO executions_old;')
      db.exec(EXEC_SCHEMA)
      db.exec(`
        INSERT OR IGNORE INTO executions
          (account, hash, name, symbol, side, sideRaw, status, filled, qty, totalQty, price, avgPrice, limitPrice, timeInForce, placedText, filledText, filledAt, placedAt)
        SELECT 'default', hash, name, symbol, side, sideRaw, status, filled, qty, totalQty, price, avgPrice, limitPrice, timeInForce, placedText, filledText, filledAt, placedAt
        FROM executions_old;
      `)
      db.exec('DROP TABLE executions_old;')
    }
  } else {
    db.exec(EXEC_SCHEMA)
  }

  // Ensure the Default account always exists (and covers any pre-existing rows).
  db.prepare('INSERT OR IGNORE INTO accounts (id, name, createdAt) VALUES (?, ?, ?)').run(
    DEFAULT_ACCOUNT.id,
    DEFAULT_ACCOUNT.name,
    0
  )
  return db
}

interface AccountRow {
  id: string
  name: string
  createdAt: number
  executions: number
}

function listAccounts(database: Database.Database): AccountRow[] {
  return database
    .prepare(
      `SELECT a.id, a.name, a.createdAt,
              (SELECT COUNT(*) FROM executions e WHERE e.account = a.id) AS executions
       FROM accounts a ORDER BY a.createdAt ASC, a.name ASC`
    )
    .all() as AccountRow[]
}

function rowToExecution(r: Record<string, unknown>): Execution {
  return {
    hash: String(r.hash),
    account: String(r.account ?? 'default'),
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

function insertExecutions(database: Database.Database, execs: Execution[], account: string): number {
  const stmt = database.prepare(`
    INSERT OR IGNORE INTO executions
      (account, hash, name, symbol, side, sideRaw, status, filled, qty, totalQty, price, avgPrice, limitPrice, timeInForce, placedText, filledText, filledAt, placedAt)
    VALUES
      (@account, @hash, @name, @symbol, @side, @sideRaw, @status, @filled, @qty, @totalQty, @price, @avgPrice, @limitPrice, @timeInForce, @placedText, @filledText, @filledAt, @placedAt)
  `)
  let imported = 0
  const tx = database.transaction((rows: Execution[]) => {
    for (const e of rows) {
      const info = stmt.run({
        account,
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

/**
 * Build a single filled execution for a MANUAL (hand-entered) trade. Manual
 * rows carry a UUID hash so they never collide with — or get de-duped against —
 * imported rows, and are timestamped on the ET wall clock like imports so all
 * analytics group them the same way. A round-trip trade is just an entry
 * execution plus an (optional) exit execution; FIFO reassembles them.
 */
function buildManualExec(account: string, symbol: string, side: Side, qty: number, price: number, at: number): Execution {
  const p = etParts(at)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${p2(p.m)}/${p2(p.d)}/${p.y} ${p2(p.hour)}:${p2(p.minute)}:00 ET`
  const sideRaw = side === 'buy' ? 'Buy' : side === 'short' ? 'Short' : 'Sell'
  return {
    hash: `manual:${randomUUID()}`,
    account,
    name: '',
    symbol,
    side,
    sideRaw,
    status: 'Filled',
    filled: true,
    qty,
    totalQty: qty,
    price,
    avgPrice: price,
    limitPrice: price,
    timeInForce: '',
    placedText: stamp,
    filledText: stamp,
    filledAt: at,
    placedAt: at
  }
}

/** Parse one CSV file and import it into an account; returns per-file counts. */
function importCsvFile(
  database: Database.Database,
  path: string,
  account: string
): { file: string; parsed: number; imported: number; skipped: number; errors: number } {
  const text = readFileSync(path, 'utf8')
  const parsed = parseWebullCsv(text)
  const imported = insertExecutions(database, parsed.executions, account)
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
          model: 'claude-sonnet-5',
          max_tokens: 2000,
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

  /** Resolve/validate the destination account id (defaults to 'default'). */
  const resolveAccount = (database: Database.Database, raw: unknown): string => {
    const id = typeof raw === 'string' && raw.trim() ? raw.trim() : 'default'
    const exists = database.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)
    return exists ? id : 'default'
  }

  ctx.ipcMain.handle(`${ID}:import-dialog`, async (_e, rawAccount: unknown) => {
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
      const account = resolveAccount(database, rawAccount)
      const files = res.filePaths.map((p) => importCsvFile(database, p, account))
      return {
        ok: true,
        account,
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
  ctx.ipcMain.handle(`${ID}:import-file`, async (_e, rawPaths: unknown, rawAccount: unknown) => {
    const paths = (Array.isArray(rawPaths) ? rawPaths : [rawPaths]).filter(
      (p): p is string => typeof p === 'string' && p.toLowerCase().endsWith('.csv')
    )
    if (paths.length === 0) return { ok: false, error: 'Drop one or more .csv files exported from Webull.' }
    try {
      const database = getDb(ctx.app)
      const account = resolveAccount(database, rawAccount)
      const files = paths.filter(existsSync).map((p) => importCsvFile(database, p, account))
      return {
        ok: true,
        account,
        files,
        imported: files.reduce((n, f) => n + f.imported, 0),
        skipped: files.reduce((n, f) => n + f.skipped, 0),
        executions: allExecutions(database)
      }
    } catch (err) {
      return { ok: false, error: 'Import failed: ' + errMsg(err) }
    }
  })

  // Clear everything, or just one account when an id is passed.
  ctx.ipcMain.handle(`${ID}:clear`, (_e, rawAccount: unknown) => {
    try {
      const database = getDb(ctx.app)
      if (typeof rawAccount === 'string' && rawAccount.trim()) {
        database.prepare('DELETE FROM executions WHERE account = ?').run(rawAccount.trim())
      } else {
        database.exec('DELETE FROM executions')
      }
      return { ok: true, executions: allExecutions(database) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /* ------------------------- manual trade editing -------------------------- */

  // Delete a trade by removing its underlying executions (the source of truth).
  // Scoped to the trade's account so a hash can't collide across accounts.
  ctx.ipcMain.handle(`${ID}:trade-delete`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const account = typeof r.account === 'string' && r.account.trim() ? r.account.trim() : 'default'
    const hashes = (Array.isArray(r.hashes) ? r.hashes : []).filter((h): h is string => typeof h === 'string')
    if (hashes.length === 0) return { ok: false, error: 'Nothing to delete.' }
    try {
      const database = getDb(ctx.app)
      const stmt = database.prepare('DELETE FROM executions WHERE account = ? AND hash = ?')
      const tx = database.transaction(() => {
        for (const h of hashes) stmt.run(account, h)
      })
      tx()
      return { ok: true, executions: allExecutions(database) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /**
   * Create OR edit a trade. Edit is delete-then-insert: the original fills
   * (`deleteHashes` in `fromAccount`) are removed and fresh entry/exit
   * executions are written into `account`, which also lets a trade be moved
   * between accounts. A blank exit price = still-open position (entry only).
   */
  ctx.ipcMain.handle(`${ID}:trade-save`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const numOr = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

    const symbol = (typeof r.symbol === 'string' ? r.symbol : '').trim().toUpperCase()
    const direction = r.direction === 'short' ? 'short' : 'long'
    const qty = numOr(r.qty)
    const entryPrice = numOr(r.entryPrice)
    const entryAt = numOr(r.entryAt)
    const exitPrice = numOr(r.exitPrice)
    const exitAt = numOr(r.exitAt)
    const exitQtyRaw = numOr(r.exitQty)
    const deleteHashes = (Array.isArray(r.deleteHashes) ? r.deleteHashes : []).filter(
      (h): h is string => typeof h === 'string'
    )
    const fromAccount =
      typeof r.fromAccount === 'string' && r.fromAccount.trim() ? r.fromAccount.trim() : null

    if (!symbol) return { ok: false, error: 'Enter a ticker symbol.' }
    if (qty == null || qty <= 0) return { ok: false, error: 'Quantity must be greater than 0.' }
    if (entryPrice == null || entryPrice <= 0) return { ok: false, error: 'Entry price must be greater than 0.' }
    if (entryAt == null) return { ok: false, error: 'Enter a valid entry date/time.' }

    const hasExit = exitPrice != null
    if (hasExit) {
      if (exitPrice <= 0) return { ok: false, error: 'Exit price must be greater than 0.' }
      if (exitAt == null) return { ok: false, error: 'Enter a valid exit date/time.' }
      if (exitAt < entryAt) return { ok: false, error: 'Exit time can’t be before the entry time.' }
    }
    const exitQty = hasExit ? (exitQtyRaw != null && exitQtyRaw > 0 ? Math.min(exitQtyRaw, qty) : qty) : 0

    try {
      const database = getDb(ctx.app)
      const account = resolveAccount(database, r.account)
      const entrySide: Side = direction === 'long' ? 'buy' : 'short'
      const exitSide: Side = direction === 'long' ? 'sell' : 'buy'
      const rows: Execution[] = [buildManualExec(account, symbol, entrySide, qty, entryPrice, entryAt)]
      if (hasExit && exitPrice != null && exitAt != null) {
        rows.push(buildManualExec(account, symbol, exitSide, exitQty, exitPrice, exitAt))
      }
      const delStmt = database.prepare('DELETE FROM executions WHERE account = ? AND hash = ?')
      const tx = database.transaction(() => {
        if (deleteHashes.length > 0) {
          const acct = fromAccount ?? account
          for (const h of deleteHashes) delStmt.run(acct, h)
        }
        insertExecutions(database, rows, account)
      })
      tx()
      return { ok: true, executions: allExecutions(database) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /* ------------------------------- accounts -------------------------------- */

  ctx.ipcMain.handle(`${ID}:accounts-list`, () => {
    try {
      return { ok: true, accounts: listAccounts(getDb(ctx.app)) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:accounts-create`, (_e, rawName: unknown) => {
    const name = typeof rawName === 'string' ? rawName.trim() : ''
    if (!name) return { ok: false, error: 'Enter an account name.' }
    try {
      const database = getDb(ctx.app)
      const taken = new Set((database.prepare('SELECT id FROM accounts').all() as { id: string }[]).map((r) => r.id))
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'account'
      let id = base
      for (let i = 2; taken.has(id); i++) id = `${base}-${i}`
      database.prepare('INSERT INTO accounts (id, name, createdAt) VALUES (?, ?, ?)').run(id, name, Date.now())
      return { ok: true, id, accounts: listAccounts(database) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:accounts-rename`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id : ''
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    if (!id || !name) return { ok: false, error: 'Missing account or name.' }
    try {
      const database = getDb(ctx.app)
      database.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(name, id)
      return { ok: true, accounts: listAccounts(database) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  // Delete an account AND its executions. The Default account can be emptied
  // but not removed (it's the fallback destination).
  ctx.ipcMain.handle(`${ID}:accounts-delete`, (_e, rawId: unknown) => {
    const id = typeof rawId === 'string' ? rawId : ''
    if (!id) return { ok: false, error: 'Missing account.' }
    if (id === 'default') return { ok: false, error: 'The Default account can’t be deleted — clear it instead.' }
    try {
      const database = getDb(ctx.app)
      const tx = database.transaction(() => {
        database.prepare('DELETE FROM executions WHERE account = ?').run(id)
        database.prepare('DELETE FROM accounts WHERE id = ?').run(id)
      })
      tx()
      return { ok: true, accounts: listAccounts(database), executions: allExecutions(database) }
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

  /* ------------------------------- sectors --------------------------------- *
   * Best-effort symbol→sector for the Market Sector P&L card. Classifications
   * are cached permanently (sectors rarely change); missing ones are fetched
   * from the shared Massive layer when a key exists, classified to a broad
   * sector, and cached. No key / lookup failure → the symbol stays Unclassified
   * and is retried next time (not cached as a failure).
   * ------------------------------------------------------------------------- */
  const sectorCachePath = join(moduleDir(ctx.app), 'sectors.json')
  const readSectorCache = (): Record<string, string> => {
    try {
      const o = JSON.parse(readFileSync(sectorCachePath, 'utf8')) as unknown
      return o && typeof o === 'object' ? (o as Record<string, string>) : {}
    } catch {
      return {}
    }
  }
  const writeSectorCache = (m: Record<string, string>): void => {
    try {
      writeFileSync(sectorCachePath, JSON.stringify(m, null, 2))
    } catch {
      /* best-effort */
    }
  }

  ctx.ipcMain.handle(`${ID}:sectors`, async (_e, rawSymbols: unknown) => {
    const symbols = (Array.isArray(rawSymbols) ? rawSymbols : [])
      .filter((s): s is string => typeof s === 'string' && !!s.trim())
      .map((s) => s.trim().toUpperCase())
    const cache = readSectorCache()
    const key = ctx.getApiKey('massive')
    const missing = [...new Set(symbols)].filter((s) => !cache[s])

    let resolved = 0
    if (key && missing.length > 0) {
      // small concurrency pool so we don't hammer the API for large symbol sets
      const queue = [...missing]
      const worker = async (): Promise<void> => {
        for (;;) {
          const sym = queue.shift()
          if (!sym) return
          try {
            const details = await getTickerDetails(key, sym)
            if (details && details.sector) {
              cache[sym] = classifySector(details.sector)
              resolved++
            }
          } catch {
            /* leave uncached → retried next time */
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker))
      if (resolved > 0) writeSectorCache(cache)
    }

    const out: Record<string, string> = {}
    for (const s of symbols) out[s] = cache[s] ?? 'Unclassified'
    return { ok: true, sectors: out, hasKey: !!key, resolved, pending: missing.length - resolved }
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
