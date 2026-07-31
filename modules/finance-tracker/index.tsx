import { ModuleTitle } from '@/shell/moduleContext'
import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  CreditCard,
  Landmark,
  List,
  Loader2,
  Pencil,
  Plus,
  Repeat,
  Search,
  Trash2,
  Upload,
  Wallet,
  X
} from 'lucide-react'
import { CATEGORIES, PAYMENTS_CATEGORY } from './lib/categories'
import { estimateCadence } from './lib/subs'
import { useFinance, type Account, type Tab, type Tx } from './store'

/* -------------------------------- helpers -------------------------------- */

const money = (n: number): string =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const monthLabel = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, (m || 1) - 1, 15)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

const dateShort = (ymd: string): string => {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const inputCls = 'w-full rounded-lg border border-edge bg-raised px-2.5 py-2 text-sm outline-none focus:border-accent'

/** Spend rows only (excludes card payments) — what the analytics run on. */
const spendRows = (txns: Tx[]): Tx[] => txns.filter((t) => t.category !== PAYMENTS_CATEGORY)

/* -------------------------------- overview ------------------------------- */

function OverviewTab(): React.JSX.Element {
  const txns = useFinance((s) => s.txns)
  const spend = useMemo(() => spendRows(txns), [txns])
  const months = useMemo(() => [...new Set(spend.map((t) => t.ymd.slice(0, 7)))].sort().reverse(), [spend])
  const [month, setMonth] = useState('')
  const sel = month || months[0] || ''

  const inMonth = useMemo(() => (sel ? spend.filter((t) => t.ymd.startsWith(sel)) : spend), [spend, sel])
  const total = inMonth.reduce((n, t) => n + t.amount, 0)

  const byCat = useMemo(() => {
    const m = new Map<string, { net: number; count: number }>()
    for (const t of inMonth) {
      const g = m.get(t.category) ?? { net: 0, count: 0 }
      g.net += t.amount
      g.count++
      m.set(t.category, g)
    }
    return [...m.entries()].map(([cat, g]) => ({ cat, ...g })).sort((a, b) => b.net - a.net)
  }, [inMonth])

  const topMerchants = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of inMonth) if (t.amount > 0) m.set(t.name, (m.get(t.name) ?? 0) + t.amount)
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  }, [inMonth])

  const trend = useMemo(() => {
    const wanted = months.slice(0, 6).reverse()
    return wanted.map((ym) => ({
      ym,
      total: spend.filter((t) => t.ymd.startsWith(ym)).reduce((n, t) => n + t.amount, 0)
    }))
  }, [months, spend])

  const subsMonthly = useMemo(() => {
    const groups = new Map<string, Tx[]>()
    for (const t of txns) if (t.isSub && t.amount > 0) groups.set(t.merchant, [...(groups.get(t.merchant) ?? []), t])
    let sum = 0
    for (const g of groups.values()) sum += estimateCadence(g.map((x) => x.postedAt), g.map((x) => x.amount)).monthly
    return sum
  }, [txns])

  if (txns.length === 0) return <EmptyState />

  const maxCat = Math.max(1, ...byCat.map((c) => Math.abs(c.net)))
  const maxTrend = Math.max(1, ...trend.map((t) => t.total))

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">Spending</span>
        <select value={sel} onChange={(e) => setMonth(e.target.value)} className="rounded-lg border border-edge bg-raised px-2 py-1.5 text-sm outline-none">
          {months.map((m) => (
            <option key={m} value={m}>
              {monthLabel(m)}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total spend" value={money(total)} sub={`${inMonth.length} transactions`} />
        <StatCard label="Subscriptions / month" value={money(subsMonthly)} sub="across all accounts" accent />
        <StatCard label="Top category" value={byCat[0]?.cat ?? '—'} sub={byCat[0] ? money(byCat[0].net) : ''} />
        <StatCard label="Top merchant" value={topMerchants[0]?.[0] ?? '—'} sub={topMerchants[0] ? money(topMerchants[0][1]) : ''} />
      </div>

      {/* category breakdown */}
      <div className="rounded-xl border border-edge bg-surface p-4">
        <h3 className="mb-3 text-sm font-semibold">Where the money went — {sel ? monthLabel(sel) : 'all time'}</h3>
        {byCat.length === 0 ? (
          <p className="text-sm text-muted">No spending in this month.</p>
        ) : (
          <div className="space-y-1.5">
            {byCat.map((c) => (
              <div key={c.cat} className="flex items-center gap-3 text-xs">
                <div className="w-40 shrink-0 truncate font-medium">{c.cat}</div>
                <div className="relative h-4 min-w-0 flex-1 rounded bg-raised">
                  <div className={`h-full rounded ${c.net >= 0 ? 'bg-accent' : 'bg-ok'}`} style={{ width: `${(Math.abs(c.net) / maxCat) * 100}%`, opacity: 0.85 }} />
                </div>
                <div className="w-24 shrink-0 text-right tabular-nums">{money(c.net)}</div>
                <div className="w-12 shrink-0 text-right text-muted">{c.count}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 6-month trend */}
        <div className="rounded-xl border border-edge bg-surface p-4">
          <h3 className="mb-3 text-sm font-semibold">Monthly spend trend</h3>
          <div className="flex h-32 items-end gap-2">
            {trend.map((t) => (
              <div key={t.ym} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                <span className="text-[10px] tabular-nums text-muted">{money(t.total)}</span>
                <div className="w-full rounded-t bg-accent/80" style={{ height: `${(t.total / maxTrend) * 100}%` }} />
                <span className="truncate text-[10px] text-muted">{t.ym.slice(2)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* top merchants */}
        <div className="rounded-xl border border-edge bg-surface p-4">
          <h3 className="mb-3 text-sm font-semibold">Top merchants</h3>
          <div className="space-y-1.5 text-xs">
            {topMerchants.map(([name, amt]) => (
              <div key={name} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">{name}</span>
                <span className="shrink-0 tabular-nums text-muted">{money(amt)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-edge bg-surface p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-1 truncate text-xl font-bold tracking-tight ${accent ? 'text-accent' : ''}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-muted">{sub}</div>}
    </div>
  )
}

/* ------------------------------ transactions ------------------------------ */

function TxRowView({ t }: { t: Tx }): React.JSX.Element {
  const updateTx = useFinance((s) => s.updateTx)
  const [name, setName] = useState(t.name)
  useEffect(() => setName(t.name), [t.name])
  return (
    <div className="grid grid-cols-[70px_1fr_170px_100px_50px] items-center gap-2 border-b border-edge/50 px-3 py-1.5 text-xs">
      <div className="tabular-nums text-muted">{dateShort(t.ymd)}</div>
      <div className="min-w-0">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim() && name.trim() !== t.name) void updateTx(t, { name: name.trim() })
            else setName(t.name)
          }}
          title={t.rawDesc}
          className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-ink outline-none hover:border-edge focus:border-accent focus:bg-raised"
        />
        <div className="truncate px-1 text-[10px] text-muted/70">{t.rawDesc}</div>
      </div>
      <select
        value={t.category}
        onChange={(e) => void updateTx(t, { category: e.target.value })}
        className="rounded-lg border border-edge bg-raised px-1.5 py-1 text-xs outline-none focus:border-accent"
      >
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <div className={`text-right font-medium tabular-nums ${t.amount < 0 ? 'text-ok' : 'text-ink'}`}>{money(t.amount)}</div>
      <div className="flex justify-center" title="Subscription">
        <input type="checkbox" checked={t.isSub} onChange={(e) => void updateTx(t, { isSub: e.target.checked })} className="h-3.5 w-3.5 accent-current" />
      </div>
    </div>
  )
}

function TransactionsTab(): React.JSX.Element {
  const txns = useFinance((s) => s.txns)
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState('')
  const [subsOnly, setSubsOnly] = useState(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return txns.filter((t) => {
      if (cat && t.category !== cat) return false
      if (subsOnly && !t.isSub) return false
      if (q && !(t.name.toLowerCase().includes(q) || t.rawDesc.toLowerCase().includes(q) || t.category.toLowerCase().includes(q))) return false
      return true
    })
  }, [txns, query, cat, subsOnly])

  if (txns.length === 0) return <EmptyState />
  const shown = filtered.slice(0, 500)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-3 py-2">
        <div className="flex min-w-48 flex-1 items-center gap-2 rounded-lg border border-edge bg-raised px-2.5 py-1.5">
          <Search size={13} className="shrink-0 text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search transactions…" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" />
          {query && (
            <button onClick={() => setQuery('')} className="text-muted hover:text-ink">
              <X size={12} />
            </button>
          )}
        </div>
        <select value={cat} onChange={(e) => setCat(e.target.value)} className="rounded-lg border border-edge bg-raised px-2 py-1.5 text-xs outline-none">
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={subsOnly} onChange={(e) => setSubsOnly(e.target.checked)} className="h-3.5 w-3.5" />
          Subs only
        </label>
      </div>
      <div className="grid grid-cols-[70px_1fr_170px_100px_50px] gap-2 border-b border-edge px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
        <div>Date</div>
        <div>Name — click to rename</div>
        <div>Category</div>
        <div className="text-right">Amount</div>
        <div className="text-center">Sub</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.map((t) => (
          <TxRowView key={`${t.account}:${t.hash}`} t={t} />
        ))}
        {filtered.length > shown.length && (
          <p className="px-3 py-2 text-center text-xs text-muted">
            Showing {shown.length} of {filtered.length} — refine the search to see the rest.
          </p>
        )}
      </div>
    </div>
  )
}

/* ------------------------------ subscriptions ----------------------------- */

function SubsTab(): React.JSX.Element {
  const txns = useFinance((s) => s.txns)
  const setMerchantSub = useFinance((s) => s.setMerchantSub)

  const subs = useMemo(() => {
    const groups = new Map<string, Tx[]>()
    for (const t of txns) if (t.isSub && t.amount > 0) groups.set(t.merchant, [...(groups.get(t.merchant) ?? []), t])
    return [...groups.entries()]
      .map(([merchant, g]) => {
        const sorted = [...g].sort((a, b) => a.postedAt - b.postedAt)
        const last = sorted[sorted.length - 1]
        const cad = estimateCadence(sorted.map((x) => x.postedAt), sorted.map((x) => x.amount))
        return { merchant, name: last.name, category: last.category, charges: sorted.length, last, cadence: cad.label, monthly: cad.monthly }
      })
      .sort((a, b) => b.monthly - a.monthly)
  }, [txns])

  if (txns.length === 0) return <EmptyState />
  const total = subs.reduce((n, s) => n + s.monthly, 0)

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between rounded-xl border border-edge bg-surface p-4">
        <div>
          <div className="text-xs text-muted">Estimated subscription cost</div>
          <div className="text-2xl font-bold tracking-tight text-accent">{money(total)}<span className="text-sm font-medium text-muted"> / month</span></div>
        </div>
        <div className="text-right text-xs text-muted">
          {subs.length} active subscription{subs.length === 1 ? '' : 's'}
          <br />
          uncheck one to un-flag it everywhere
        </div>
      </div>

      {subs.length === 0 ? (
        <p className="p-4 text-sm text-muted">
          No subscriptions flagged yet. They're detected automatically on import (known merchants + regular recurring charges), and you can
          check the “Sub” box on any transaction.
        </p>
      ) : (
        subs.map((s) => (
          <div key={s.merchant} className="flex items-center gap-3 rounded-lg border border-edge bg-surface px-3 py-2.5">
            <input
              type="checkbox"
              checked
              onChange={() => void setMerchantSub(s.merchant, false)}
              title="Uncheck to remove from subscriptions (and remember that choice)"
              className="h-4 w-4 shrink-0"
            />
            <Repeat size={14} className="shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{s.name}</div>
              <div className="truncate text-[11px] text-muted">
                {s.category} · {s.charges} charge{s.charges === 1 ? '' : 's'} · last {dateShort(s.last.ymd)} at {money(s.last.amount)}
                {s.cadence ? ` · ${s.cadence}` : ' · cadence unknown (assumed monthly)'}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-sm font-bold tabular-nums">{money(s.monthly)}</div>
              <div className="text-[10px] text-muted">/ month</div>
            </div>
          </div>
        ))
      )}
    </div>
  )
}

/* -------------------------------- accounts -------------------------------- */

function AccountsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const accounts = useFinance((s) => s.accounts)
  const createAccount = useFinance((s) => s.createAccount)
  const renameAccount = useFinance((s) => s.renameAccount)
  const deleteAccount = useFinance((s) => s.deleteAccount)
  const [name, setName] = useState('')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-edge bg-surface p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2">
          <CreditCard size={16} className="text-accent" />
          <span className="text-sm font-semibold">Card accounts</span>
          <button onClick={onClose} className="ml-auto rounded-md p-1 text-muted hover:bg-raised hover:text-ink">
            <X size={15} />
          </button>
        </div>
        <div className="space-y-2">
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center gap-2 rounded-lg border border-edge bg-raised px-2.5 py-2">
              <Pencil size={12} className="shrink-0 text-muted" />
              <input
                defaultValue={a.name}
                onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== a.name && void renameAccount(a.id, e.target.value.trim())}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
              <span className="shrink-0 text-[11px] text-muted">{a.txCount} txns</span>
              <button
                onClick={() => {
                  if (window.confirm(`Delete "${a.name}" and its ${a.txCount} transaction(s)? Learned merchant rules are kept.`)) void deleteAccount(a.id)
                }}
                className="shrink-0 rounded p-1 text-muted hover:bg-danger/15 hover:text-danger"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-3 flex gap-2 border-t border-edge pt-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New account (e.g. Chase Sapphire)" className={inputCls} />
          <button
            onClick={() => {
              if (name.trim()) {
                void createAccount(name.trim())
                setName('')
              }
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
          >
            <Plus size={14} /> Add
          </button>
        </div>
      </div>
    </div>
  )
}

/* --------------------------------- shared --------------------------------- */

function EmptyState(): React.JSX.Element {
  const importCsv = useFinance((s) => s.importCsv)
  const importing = useFinance((s) => s.importing)
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-raised text-accent">
          <Landmark size={30} />
        </span>
        <h2 className="mt-4 text-lg font-bold">Import a credit-card statement</h2>
        <p className="mt-2 text-sm text-muted">
          Download a statement as <strong>CSV</strong> from your card's website (most banks offer “Export/Download transactions”), then
          drop the file here or click Import. Re-import anytime — overlapping statements are de-duplicated, and your renames, category
          fixes and subscription flags are remembered and applied to every future import.
        </p>
        <button
          onClick={() => void importCsv()}
          disabled={importing}
          className="mx-auto mt-5 flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
        >
          {importing ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} Import CSV
        </button>
      </div>
    </div>
  )
}

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <BarChart3 size={14} /> },
  { id: 'transactions', label: 'Transactions', icon: <List size={14} /> },
  { id: 'subs', label: 'Subscriptions', icon: <Repeat size={14} /> }
]

export default function FinanceTracker(): React.JSX.Element {
  const s = useFinance()
  const [accountsOpen, setAccountsOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    void s.load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragOver(false)
    const paths: string[] = []
    for (const f of Array.from(e.dataTransfer.files)) {
      try {
        const p = window.wicked.getPathForFile(f)
        if (p) paths.push(p)
      } catch {
        /* ignore */
      }
    }
    if (paths.length > 0) void s.importPaths(paths)
  }

  const subCount = useMemo(() => new Set(s.txns.filter((t) => t.isSub).map((t) => t.merchant)).size, [s.txns])

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={(e) => {
        e.preventDefault()
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      {/* header */}
      <header className="flex items-center gap-3 border-b border-edge px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
          <Wallet size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold tracking-tight">
            <ModuleTitle fallback="Finance Tracker" />
          </h1>
          <p className="truncate text-xs text-muted">
            {s.txns.length > 0
              ? `${s.txns.length.toLocaleString('en-US')} transactions · ${subCount} subscription${subCount === 1 ? '' : 's'} · ${s.accounts.length} account${s.accounts.length === 1 ? '' : 's'}`
              : 'Import your credit-card statement CSVs'}
          </p>
        </div>
        <select
          value={s.active}
          onChange={(e) => void s.setActive(e.target.value)}
          className="rounded-lg border border-edge bg-raised px-2 py-2 text-sm outline-none"
          title="Which account to view"
        >
          <option value="">All accounts</option>
          {s.accounts.map((a: Account) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => setAccountsOpen(true)}
          className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface px-3 py-2 text-sm font-medium hover:border-accent/60"
        >
          <CreditCard size={14} /> Accounts
        </button>
        <button
          onClick={() => void s.importCsv()}
          disabled={s.importing}
          title={s.active ? undefined : `Imports into ${s.accounts[0]?.name ?? 'the first account'} — pick an account to target another`}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
        >
          {s.importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Import CSV
        </button>
      </header>

      {/* tabs */}
      <div className="flex items-center gap-1 border-b border-edge px-4 pt-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => s.setTab(t.id)}
            className={`-mb-px flex items-center gap-1.5 whitespace-nowrap rounded-t-md border-b-2 px-3 py-1.5 text-sm ${
              s.tab === t.id ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {t.icon}
            {t.label}
            {t.id === 'subs' && subCount > 0 && (
              <span className="rounded-full bg-accent/15 px-1.5 text-[10px] font-semibold text-accent">{subCount}</span>
            )}
          </button>
        ))}
      </div>

      {/* error */}
      {s.error && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-5 py-2 text-sm text-danger">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 break-words">{s.error}</span>
          <button onClick={s.dismissError} className="rounded p-1 hover:bg-danger/15">
            <X size={14} />
          </button>
        </div>
      )}

      {/* body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {s.tab === 'overview' && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <OverviewTab />
          </div>
        )}
        {s.tab === 'transactions' && <TransactionsTab />}
        {s.tab === 'subs' && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SubsTab />
          </div>
        )}
      </div>

      {accountsOpen && <AccountsModal onClose={() => setAccountsOpen(false)} />}

      {/* status bar */}
      <footer className="flex items-center gap-2 border-t border-edge px-5 py-1.5 text-xs text-muted">
        {s.importing && <Loader2 size={12} className="shrink-0 animate-spin text-accent" />}
        <span className="truncate">{s.status}</span>
      </footer>

      {/* drag overlay */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-accent/10 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-surface px-8 py-6 text-center">
            <Upload size={28} className="mx-auto text-accent" />
            <p className="mt-2 text-sm font-medium">Drop statement CSV(s) to import</p>
          </div>
        </div>
      )}
    </div>
  )
}
