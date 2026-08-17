import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { autoCategory, autoName, isKnownSub, normalizeMerchant, PAYMENTS_CATEGORY } from './lib/categories'
import { parseStatement } from './lib/csv'
import { estimateCadence, looksRecurring } from './lib/subs'

/* ------------------------------------------------------------------------ *
 *  FINANCE TRACKER — main process.
 *
 *  Credit-card statements (CSV) land in a per-module SQLite DB. Every row is
 *  keyed by a content hash (+ per-file ordinal so two identical charges on the
 *  same day survive), so re-importing overlapping statements never duplicates.
 *
 *  LEARNING: user edits (rename / category / subscription flag) are stored as
 *  MERCHANT RULES keyed by the normalized merchant. Rules are applied to every
 *  future import and propagated to existing rows the user hasn't individually
 *  edited — so the tracker keeps getting smarter as months of statements land.
 * ------------------------------------------------------------------------ */

const ID = 'finance-tracker'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

let db: Database.Database | null = null

function moduleDir(app: ModuleIpcContext['app']): string {
  return join(app.getPath('userData'), 'modules', ID)
}

function getDb(app: ModuleIpcContext['app']): Database.Database {
  if (db) return db
  const dir = moduleDir(app)
  mkdirSync(dir, { recursive: true })
  db = new Database(join(dir, 'finance.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      createdAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS transactions (
      account TEXT NOT NULL,
      hash TEXT NOT NULL,
      ymd TEXT NOT NULL,
      postedAt INTEGER NOT NULL,
      merchant TEXT NOT NULL,
      rawDesc TEXT NOT NULL,
      name TEXT NOT NULL,
      amount REAL NOT NULL,
      category TEXT NOT NULL,
      isSub INTEGER NOT NULL DEFAULT 0,
      edited INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account, hash)
    );
    CREATE INDEX IF NOT EXISTS idx_ftx_merchant ON transactions(merchant);
    CREATE INDEX IF NOT EXISTS idx_ftx_posted ON transactions(postedAt);
    CREATE TABLE IF NOT EXISTS rules (
      merchant TEXT PRIMARY KEY,
      name TEXT,
      category TEXT,
      isSub INTEGER,
      updatedAt INTEGER NOT NULL DEFAULT 0
    );
  `)
  // Seed a first account so Import works out of the box.
  const count = (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n
  if (count === 0) db.prepare('INSERT INTO accounts (id, name, createdAt) VALUES (?, ?, ?)').run(randomUUID(), 'My Card', Date.now())
  return db
}

interface AccountRow {
  id: string
  name: string
  createdAt: number
  txCount: number
}

function listAccounts(database: Database.Database): AccountRow[] {
  return database
    .prepare(
      `SELECT a.id, a.name, a.createdAt,
              (SELECT COUNT(*) FROM transactions t WHERE t.account = a.id) AS txCount
       FROM accounts a ORDER BY a.createdAt ASC, a.name ASC`
    )
    .all() as AccountRow[]
}

interface TxRow {
  account: string
  hash: string
  ymd: string
  postedAt: number
  merchant: string
  rawDesc: string
  name: string
  amount: number
  category: string
  isSub: number
  edited: number
}

interface RuleRow {
  merchant: string
  name: string | null
  category: string | null
  isSub: number | null
}

/**
 * Recurrence pass: flag merchants whose charge stream looks like a subscription
 * (regular cadence, similar amounts). Skips any merchant the user has an
 * explicit rule opinion on, and never touches individually-edited rows.
 * Returns how many rows were newly flagged.
 */
function recurrencePass(database: Database.Database): number {
  const ruled = new Set(
    (database.prepare('SELECT merchant FROM rules WHERE isSub IS NOT NULL').all() as { merchant: string }[]).map((r) => r.merchant)
  )
  const rows = database
    .prepare(`SELECT merchant, postedAt, amount, isSub FROM transactions WHERE amount > 0 AND category != ?`)
    .all(PAYMENTS_CATEGORY) as { merchant: string; postedAt: number; amount: number; isSub: number }[]
  const byMerchant = new Map<string, { dates: number[]; amounts: number[]; anyUnflagged: boolean }>()
  for (const r of rows) {
    const g = byMerchant.get(r.merchant) ?? { dates: [], amounts: [], anyUnflagged: false }
    g.dates.push(r.postedAt)
    g.amounts.push(r.amount)
    if (!r.isSub) g.anyUnflagged = true
    byMerchant.set(r.merchant, g)
  }
  const flag = database.prepare('UPDATE transactions SET isSub = 1 WHERE merchant = ? AND edited = 0 AND isSub = 0')
  let flagged = 0
  const tx = database.transaction(() => {
    for (const [merchant, g] of byMerchant) {
      if (ruled.has(merchant) || !g.anyUnflagged) continue
      if (looksRecurring(g.dates, g.amounts)) flagged += flag.run(merchant).changes
    }
  })
  tx()
  return flagged
}

/** Import one CSV file into an account, applying merchant rules as rows land. */
function importCsvFile(
  database: Database.Database,
  path: string,
  account: string
): { file: string; parsed: number; imported: number; skipped: number; errors: number; note?: string } {
  const text = readFileSync(path, 'utf8')
  const parsed = parseStatement(text)
  const getRule = database.prepare('SELECT merchant, name, category, isSub FROM rules WHERE merchant = ?')
  const insert = database.prepare(`
    INSERT OR IGNORE INTO transactions (account, hash, ymd, postedAt, merchant, rawDesc, name, amount, category, isSub, edited)
    VALUES (@account, @hash, @ymd, @postedAt, @merchant, @rawDesc, @name, @amount, @category, @isSub, 0)
  `)
  let imported = 0
  const ordinals = new Map<string, number>()
  const tx = database.transaction(() => {
    for (const t of parsed.txns) {
      const upper = t.desc.toUpperCase()
      const merchant = normalizeMerchant(t.desc)
      const rule = getRule.get(merchant) as RuleRow | undefined
      const category = rule?.category ?? autoCategory(upper)
      const name = rule?.name ?? autoName(t.desc)
      const isSub = rule?.isSub != null ? rule.isSub : isKnownSub(upper) && t.amount > 0 ? 1 : 0
      const ordKey = `${t.ymd}|${t.desc}|${t.amount.toFixed(2)}`
      const ord = (ordinals.get(ordKey) ?? 0) + 1
      ordinals.set(ordKey, ord)
      const hash = createHash('sha1').update(`${ordKey}|${ord}`).digest('hex')
      imported += insert.run({
        account,
        hash,
        ymd: t.ymd,
        postedAt: t.ms,
        merchant,
        rawDesc: t.desc,
        name,
        amount: t.amount,
        category,
        isSub
      }).changes
    }
  })
  tx()
  return {
    file: path,
    parsed: parsed.txns.length,
    imported,
    skipped: parsed.txns.length - imported,
    errors: parsed.errors,
    note: parsed.note
  }
}

export default function register(ctx: ModuleIpcContext): void {
  const ACTIVE_KEY = `${ID}.active`

  // WAL databases must checkpoint right before Backup/Cloud Sync captures
  // files, or the snapshot's finance.db misses everything still in the -wal.
  ctx.onBackupFlush(() => {
    try {
      db?.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* db not open yet — nothing to flush */
    }
  })

  ctx.ipcMain.handle(`${ID}:bootstrap`, () => {
    try {
      const database = getDb(ctx.app)
      const accounts = listAccounts(database)
      let active = ctx.storeGet<string>(ACTIVE_KEY, '')
      if (active && !accounts.some((a) => a.id === active)) active = ''
      return { ok: true, accounts, active }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:set-active`, (_e, id: unknown) => {
    ctx.storeSet(ACTIVE_KEY, str(id))
    return { ok: true }
  })

  /* ------------------------------- accounts ------------------------------ */

  ctx.ipcMain.handle(`${ID}:accounts-create`, (_e, rawName: unknown) => {
    const name = str(rawName).trim().slice(0, 60)
    if (!name) return { ok: false, error: 'Enter an account name.' }
    try {
      const database = getDb(ctx.app)
      database.prepare('INSERT INTO accounts (id, name, createdAt) VALUES (?, ?, ?)').run(randomUUID(), name, Date.now())
      return { ok: true, accounts: listAccounts(database) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:accounts-rename`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const id = str(r.id)
    const name = str(r.name).trim().slice(0, 60)
    if (!id || !name) return { ok: false, error: 'Missing account or name.' }
    try {
      const database = getDb(ctx.app)
      database.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(name, id)
      return { ok: true, accounts: listAccounts(database) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  // Deletes the account AND its transactions (merchant rules are kept — they're
  // learned knowledge, not account data). Reseeds a default if the last one goes.
  ctx.ipcMain.handle(`${ID}:accounts-delete`, (_e, rawId: unknown) => {
    const id = str(rawId)
    if (!id) return { ok: false, error: 'Missing account.' }
    try {
      const database = getDb(ctx.app)
      const tx = database.transaction(() => {
        database.prepare('DELETE FROM transactions WHERE account = ?').run(id)
        database.prepare('DELETE FROM accounts WHERE id = ?').run(id)
      })
      tx()
      const count = (database.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n
      if (count === 0) database.prepare('INSERT INTO accounts (id, name, createdAt) VALUES (?, ?, ?)').run(randomUUID(), 'My Card', Date.now())
      if (ctx.storeGet<string>(ACTIVE_KEY, '') === id) ctx.storeSet(ACTIVE_KEY, '')
      return { ok: true, accounts: listAccounts(database) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /* -------------------------------- import ------------------------------- */

  const resolveAccount = (database: Database.Database, raw: unknown): string | null => {
    const accounts = listAccounts(database)
    const id = str(raw).trim()
    if (id) {
      const hit = accounts.find((a) => a.id === id || a.name.toLowerCase() === id.toLowerCase())
      if (hit) return hit.id
    }
    return accounts[0]?.id ?? null
  }

  const runImport = (database: Database.Database, paths: string[], account: string): Record<string, unknown> => {
    const files = paths.filter(existsSync).map((p) => importCsvFile(database, p, account))
    const flagged = recurrencePass(database)
    return {
      ok: true,
      account,
      files,
      imported: files.reduce((n, f) => n + f.imported, 0),
      skipped: files.reduce((n, f) => n + f.skipped, 0),
      errors: files.reduce((n, f) => n + f.errors, 0),
      flaggedSubs: flagged
    }
  }

  ctx.ipcMain.handle(`${ID}:import-dialog`, async (_e, rawAccount: unknown) => {
    try {
      const database = getDb(ctx.app)
      const account = resolveAccount(database, rawAccount)
      if (!account) return { ok: false, error: 'Create an account first.' }
      const win = ctx.getMainWindow()
      const opts = {
        title: 'Import credit-card statement CSV(s)',
        properties: ['openFile' as const, 'multiSelections' as const],
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      }
      const res = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
      if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true }
      return runImport(database, res.filePaths, account)
    } catch (err) {
      return { ok: false, error: 'Import failed: ' + errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:import-file`, (_e, rawPaths: unknown, rawAccount: unknown) => {
    const paths = (Array.isArray(rawPaths) ? rawPaths : [rawPaths]).filter(
      (p): p is string => typeof p === 'string' && p.toLowerCase().endsWith('.csv')
    )
    if (paths.length === 0) return { ok: false, error: 'Drop one or more statement .csv files.' }
    try {
      const database = getDb(ctx.app)
      const account = resolveAccount(database, rawAccount)
      if (!account) return { ok: false, error: 'Create an account first.' }
      return runImport(database, paths, account)
    } catch (err) {
      return { ok: false, error: 'Import failed: ' + errMsg(err) }
    }
  })

  /* ----------------------------- transactions ---------------------------- */

  ctx.ipcMain.handle(`${ID}:transactions`, (_e, rawAccount: unknown) => {
    try {
      const database = getDb(ctx.app)
      const account = str(rawAccount).trim()
      const rows = (
        account
          ? database.prepare('SELECT * FROM transactions WHERE account = ? ORDER BY postedAt DESC, hash ASC LIMIT 20000').all(account)
          : database.prepare('SELECT * FROM transactions ORDER BY postedAt DESC, hash ASC LIMIT 20000').all()
      ) as TxRow[]
      return { ok: true, transactions: rows }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /**
   * Edit one transaction (rename / category / subscription flag). The row is
   * marked `edited`, the change is saved as a MERCHANT RULE (so future imports
   * apply it), and propagated to this merchant's other non-edited rows.
   */
  ctx.ipcMain.handle(`${ID}:tx-update`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const account = str(r.account)
    const hash = str(r.hash)
    if (!account || !hash) return { ok: false, error: 'Missing transaction.' }
    try {
      const database = getDb(ctx.app)
      const row = database.prepare('SELECT * FROM transactions WHERE account = ? AND hash = ?').get(account, hash) as TxRow | undefined
      if (!row) return { ok: false, error: 'Transaction not found.' }
      const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 60) : null
      const category = typeof r.category === 'string' && r.category.trim() ? r.category.trim().slice(0, 40) : null
      const isSub = typeof r.isSub === 'boolean' ? (r.isSub ? 1 : 0) : null
      if (name == null && category == null && isSub == null) return { ok: false, error: 'Nothing to change.' }

      const tx = database.transaction(() => {
        database
          .prepare('UPDATE transactions SET name = ?, category = ?, isSub = ?, edited = 1 WHERE account = ? AND hash = ?')
          .run(name ?? row.name, category ?? row.category, isSub ?? row.isSub, account, hash)
        // learn the rule for this merchant (only the provided fields)
        database
          .prepare(
            `INSERT INTO rules (merchant, name, category, isSub, updatedAt) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(merchant) DO UPDATE SET
               name = COALESCE(excluded.name, rules.name),
               category = COALESCE(excluded.category, rules.category),
               isSub = COALESCE(excluded.isSub, rules.isSub),
               updatedAt = excluded.updatedAt`
          )
          .run(row.merchant, name, category, isSub, Date.now())
        // propagate to the merchant's other non-edited rows so history stays consistent
        if (name != null) database.prepare('UPDATE transactions SET name = ? WHERE merchant = ? AND edited = 0').run(name, row.merchant)
        if (category != null) database.prepare('UPDATE transactions SET category = ? WHERE merchant = ? AND edited = 0').run(category, row.merchant)
        if (isSub != null) database.prepare('UPDATE transactions SET isSub = ? WHERE merchant = ? AND edited = 0').run(isSub, row.merchant)
      })
      tx()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  // Merchant-wide subscription toggle (Subscriptions tab): updates EVERY row of
  // the merchant (including edited ones) and stores the rule.
  ctx.ipcMain.handle(`${ID}:merchant-sub`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const merchant = str(r.merchant)
    const isSub = r.isSub === true ? 1 : 0
    if (!merchant) return { ok: false, error: 'Missing merchant.' }
    try {
      const database = getDb(ctx.app)
      const tx = database.transaction(() => {
        database.prepare('UPDATE transactions SET isSub = ? WHERE merchant = ?').run(isSub, merchant)
        database
          .prepare(
            `INSERT INTO rules (merchant, isSub, updatedAt) VALUES (?, ?, ?)
             ON CONFLICT(merchant) DO UPDATE SET isSub = excluded.isSub, updatedAt = excluded.updatedAt`
          )
          .run(merchant, isSub, Date.now())
      })
      tx()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /* ---------------------- computed views (MCP + agents) ------------------- */

  ctx.ipcMain.handle(`${ID}:subscriptions`, () => {
    try {
      const database = getDb(ctx.app)
      const rows = database
        .prepare('SELECT merchant, name, category, postedAt, ymd, amount FROM transactions WHERE isSub = 1 AND amount > 0 ORDER BY postedAt ASC')
        .all() as { merchant: string; name: string; category: string; postedAt: number; ymd: string; amount: number }[]
      const byMerchant = new Map<string, typeof rows>()
      for (const r of rows) {
        const g = byMerchant.get(r.merchant) ?? []
        g.push(r)
        byMerchant.set(r.merchant, g)
      }
      const subs = [...byMerchant.entries()].map(([merchant, g]) => {
        const cad = estimateCadence(
          g.map((x) => x.postedAt),
          g.map((x) => x.amount)
        )
        const last = g[g.length - 1]
        return {
          merchant,
          name: last.name,
          category: last.category,
          charges: g.length,
          lastCharge: last.ymd,
          lastAmount: Math.round(last.amount * 100) / 100,
          cadence: cad.label ?? 'assumed monthly',
          estMonthly: Math.round(cad.monthly * 100) / 100
        }
      })
      subs.sort((a, b) => b.estMonthly - a.estMonthly)
      const totalMonthly = Math.round(subs.reduce((n, s) => n + s.estMonthly, 0) * 100) / 100
      return { ok: true, totalMonthly, count: subs.length, subscriptions: subs }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:spending`, (_e, rawMonth: unknown) => {
    try {
      const database = getDb(ctx.app)
      const month = str(rawMonth).trim() // 'YYYY-MM' or '' for all
      const rows = database
        .prepare(`SELECT ymd, amount, category FROM transactions WHERE category != ?${month ? " AND ymd LIKE ?" : ''}`)
        .all(...(month ? [PAYMENTS_CATEGORY, `${month}%`] : [PAYMENTS_CATEGORY])) as { ymd: string; amount: number; category: string }[]
      const byCat = new Map<string, { net: number; count: number }>()
      let total = 0
      for (const r of rows) {
        const g = byCat.get(r.category) ?? { net: 0, count: 0 }
        g.net += r.amount
        g.count++
        byCat.set(r.category, g)
        total += r.amount
      }
      const categories = [...byCat.entries()]
        .map(([category, g]) => ({ category, net: Math.round(g.net * 100) / 100, transactions: g.count }))
        .sort((a, b) => b.net - a.net)
      return { ok: true, month: month || 'all', totalSpend: Math.round(total * 100) / 100, categories }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /* --------------------------------- misc -------------------------------- */

  ctx.ipcMain.handle(`${ID}:clear`, (_e, rawAccount: unknown) => {
    try {
      const database = getDb(ctx.app)
      const account = str(rawAccount).trim()
      if (account) database.prepare('DELETE FROM transactions WHERE account = ?').run(account)
      else database.exec('DELETE FROM transactions')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => {
    const file = join(moduleDir(ctx.app), 'finance.db')
    return [
      {
        label: 'Finance database',
        path: existsSync(file) ? file : null,
        note: 'Imported statement transactions, accounts and learned merchant rules (SQLite). Included in Backup & Cloud Sync.'
      }
    ]
  })
}
