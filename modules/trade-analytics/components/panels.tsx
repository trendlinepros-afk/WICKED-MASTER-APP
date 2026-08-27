import { useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Upload,
  Wallet,
  X
} from 'lucide-react'
import { useTrades } from '../store'
import { computeStats } from '../lib/analytics'
import type { MetricBucket, BucketHighlights, TradeMetrics } from '../lib/metrics'
import { duration, money, num, pct, signedMoney } from '../lib/format'
import { AggPnlColumns, DrawdownArea, WinLossColumns, type MetricCol } from './charts'

const pos = (n: number): string => (n >= 0 ? 'text-ok' : 'text-danger')

/* ============================= accounts bar ============================= */

/** Multi-select "which accounts to view" dropdown + Manage + import target. */
export function AccountsBar({ onManage }: { onManage: () => void }): React.JSX.Element {
  const accounts = useTrades((s) => s.accounts)
  const selected = useTrades((s) => s.selectedAccounts)
  const toggle = useTrades((s) => s.toggleAccount)
  const selectAll = useTrades((s) => s.selectAllAccounts)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])

  const viewing =
    selected.length === 0
      ? 'All accounts'
      : selected.length === 1
        ? accounts.find((a) => a.id === selected[0])?.name ?? '1 account'
        : `${selected.length} accounts`

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-edge bg-surface/60 px-4 py-2">
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm font-medium hover:border-accent/60"
        >
          <Layers size={14} className="text-accent" />
          <span>Viewing: {viewing}</span>
          <ChevronDown size={13} className="text-muted" />
        </button>
        {open && (
          <div className="absolute left-0 z-30 mt-1 w-64 rounded-xl border border-edge bg-surface p-1 shadow-2xl">
            <button
              onClick={() => selectAll()}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-raised"
            >
              <span className="w-[15px] shrink-0">{selected.length === 0 && <Check size={13} className="text-accent" />}</span>
              <span className="font-medium">All accounts</span>
              <span className="ml-auto text-xs text-muted">stacked</span>
            </button>
            <div className="my-1 h-px bg-edge" />
            <div className="max-h-64 overflow-y-auto">
              {accounts.map((a) => {
                const on = selected.includes(a.id)
                return (
                  <button
                    key={a.id}
                    onClick={() => toggle(a.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-raised"
                  >
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? 'border-accent bg-accent text-accent-ink' : 'border-edge'}`}>
                      {on && <Check size={11} />}
                    </span>
                    <span className="min-w-0 truncate">{a.name}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted">{num(a.executions)}</span>
                  </button>
                )
              })}
            </div>
            <p className="px-2.5 py-1 text-[11px] text-muted">Check multiple to stack their results together.</p>
          </div>
        )}
      </div>

      <button
        onClick={onManage}
        className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface px-3 py-1.5 text-sm font-medium hover:border-accent/60"
      >
        <Wallet size={14} /> Manage Accounts
      </button>
    </div>
  )
}

/* ============================= import modal ============================= */

/** Pick the destination account, then Browse to choose the CSV to import. */
export function ImportModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const accounts = useTrades((s) => s.accounts)
  const importAccount = useTrades((s) => s.importAccount)
  const importing = useTrades((s) => s.importing)
  const importDialog = useTrades((s) => s.importDialog)
  const createAccount = useTrades((s) => s.createAccount)
  const [account, setAccount] = useState(importAccount || accounts[0]?.id || 'default')
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const browse = async (): Promise<void> => {
    await importDialog(account)
    // importDialog opens the OS file picker; close once it returns (imported or cancelled)
    if (!useTrades.getState().error) onClose()
  }

  const addAccount = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) return
    const id = await createAccount(name)
    if (id) {
      setAccount(id)
      setNewName('')
      setCreating(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-edge bg-surface" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
          <Upload size={15} className="text-accent" />
          <span className="text-sm font-semibold">Import trades (CSV)</span>
          <button onClick={onClose} className="ml-auto rounded-md p-1 text-muted hover:bg-raised hover:text-ink">
            <X size={15} />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-muted">Import into account</label>
            <div className="mt-1.5 flex items-center gap-2">
              <select
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                className="min-w-0 flex-1 cursor-pointer rounded-lg border border-edge bg-raised px-2.5 py-2 text-sm text-ink outline-none focus:border-accent [&>option]:bg-surface"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setCreating((v) => !v)}
                title="New account"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-edge hover:border-accent/60"
              >
                <Plus size={15} />
              </button>
            </div>
            {creating && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addAccount()
                    if (e.key === 'Escape') setCreating(false)
                  }}
                  placeholder="New account name…"
                  className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-2.5 py-2 text-sm outline-none focus:border-accent"
                />
                <button
                  onClick={() => void addAccount()}
                  disabled={!newName.trim()}
                  className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
                >
                  <Check size={14} />
                </button>
              </div>
            )}
            <p className="mt-1.5 text-[11px] text-muted">
              Any broker&apos;s CSV export works (Webull, Robinhood, Schwab, Fidelity, IBKR, E*TRADE,
              tastytrade, NinjaTrader…). Trades import only into this account and never mix with others.
              Re-importing skips duplicates and updates orders that filled since the last export.
            </p>
            <p className="mt-1.5 rounded-lg bg-accent/10 px-2.5 py-1.5 text-[11px] text-muted">
              <strong className="text-ink">NinjaTrader:</strong> for an exact match including commissions,
              export <strong className="text-ink">Trade Performance → Display: Trades</strong> (in $ mode) and
              import that. WICKED uses NinjaTrader&apos;s own net P&amp;L and commission, so the numbers
              reconcile to the cent. The Orders/Executions grids have no fee data.
            </p>
          </div>

          <button
            onClick={() => void browse()}
            disabled={importing}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            {importing ? <Loader2 size={15} className="animate-spin" /> : <FolderOpen size={15} />}
            Browse for CSV…
          </button>
        </div>
      </div>
    </div>
  )
}

/* ========================== manage accounts ============================ */

export function ManageAccountsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const accounts = useTrades((s) => s.accounts)
  const create = useTrades((s) => s.createAccount)
  const rename = useTrades((s) => s.renameAccount)
  const setAccountFee = useTrades((s) => s.setAccountFee)
  const del = useTrades((s) => s.deleteAccount)
  const clearAll = useTrades((s) => s.clearAll)
  const [newName, setNewName] = useState('')
  const [confirmDel, setConfirmDel] = useState('')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-edge bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
          <Wallet size={15} className="text-accent" />
          <span className="text-sm font-semibold">Manage Accounts</span>
          <button onClick={onClose} className="ml-auto rounded-md p-1 text-muted hover:bg-raised hover:text-ink">
            <X size={15} />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-edge px-4 py-2.5">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newName.trim()) {
                void create(newName.trim())
                setNewName('')
              }
            }}
            placeholder="New account name (e.g. Roth IRA, Main, Prop)…"
            className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-2.5 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            onClick={() => {
              if (newName.trim()) {
                void create(newName.trim())
                setNewName('')
              }
            }}
            disabled={!newName.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            <Plus size={14} /> Add
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center gap-2 border-b border-edge/50 px-4 py-2.5 last:border-b-0">
              <input
                defaultValue={a.name}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (v && v !== a.name) void rename(a.id, v)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-medium outline-none hover:border-edge focus:border-accent"
              />
              <label
                className="flex shrink-0 items-center gap-1 rounded-lg border border-edge/60 bg-raised/40 px-1.5 py-0.5"
                title="Cost per contract/share, per fill (entry and exit are each charged). Files with NO cost data (NinjaTrader Orders grid) get this as their full cost; files with commission but no exchange/reg fees (NinjaTrader Executions grid) get it ADDED on top. Leave 0 for commission-free brokers or files that already include the complete cost (Trade Performance, Schwab)."
              >
                <span className="text-[11px] text-muted">$</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  defaultValue={a.feePerContract ? String(a.feePerContract) : ''}
                  placeholder="0.00"
                  onBlur={(e) => {
                    const v = Math.max(0, Number(e.target.value) || 0)
                    if (v !== (a.feePerContract || 0)) void setAccountFee(a.id, v)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                  className="w-12 bg-transparent text-right text-xs tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                />
                <span className="text-[10px] text-muted">/ct·side</span>
              </label>
              <span className="shrink-0 text-xs text-muted">{num(a.executions)} exec</span>
              <Pencil size={12} className="shrink-0 text-muted" />
              <button
                onClick={() => void clearAll(a.id)}
                title="Clear this account's trades (keeps the account)"
                className="shrink-0 rounded-md px-2 py-1 text-xs text-muted hover:bg-raised hover:text-ink"
              >
                Clear
              </button>
              {a.id === 'default' ? (
                <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] uppercase text-muted">default</span>
              ) : confirmDel === a.id ? (
                <button
                  onClick={() => {
                    void del(a.id)
                    setConfirmDel('')
                  }}
                  className="shrink-0 rounded-lg bg-danger px-2 py-1 text-xs font-medium text-white"
                >
                  Delete?
                </button>
              ) : (
                <button
                  onClick={() => setConfirmDel(a.id)}
                  title="Delete account and its trades"
                  className="shrink-0 rounded-md p-1.5 text-muted hover:bg-danger/15 hover:text-danger"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
        <p className="border-t border-edge px-4 py-2 text-[11px] text-muted">
          Imports never mix between accounts — each account is matched into round trips on its own. Deleting an
          account also deletes its imported trades.
          <br />
          <strong className="text-ink">$/ct·side</strong> is a cost per contract (or share) charged on <em>every</em>{' '}
          fill — a round trip pays it twice. Files with <em>no</em> cost data (NinjaTrader Orders grid) get it as
          their full cost; files with commission but missing exchange/reg fees (NinjaTrader Executions grid) get it{' '}
          <em>added on top</em>. Leave 0 for files that already carry the complete cost (Trade Performance, Schwab).
        </p>
      </div>
    </div>
  )
}

/* ============================= sector card ============================= */

export function SectorCard(): React.JSX.Element | null {
  const metrics = useTrades((s) => s.metrics)
  const busy = useTrades((s) => s.sectorsBusy)
  const hasKey = useTrades((s) => s.sectorsHasKey)
  const setSectorFocus = useTrades((s) => s.setSectorFocus)
  if (!metrics) return null
  const sectors = metrics.bySector.filter((s) => s.trades > 0)

  return (
    <div className="rounded-xl border border-edge bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Realized P&L by market sector</h3>
        {busy ? (
          <span className="text-xs text-muted">resolving sectors…</span>
        ) : (
          sectors.length > 0 && <span className="text-xs text-muted">click a sector to drill in →</span>
        )}
      </div>
      {sectors.length === 0 ? (
        <p className="text-sm text-muted">
          {hasKey
            ? 'Sectors are still resolving — check back in a moment.'
            : 'Add your Massive / Polygon key in Settings → API Keys to classify each symbol into a market sector.'}
        </p>
      ) : (
        <div className="space-y-1">
          {sectors.map((s) => {
            const maxAbs = Math.max(1, ...sectors.map((x) => Math.abs(x.pnl)))
            const w = (Math.abs(s.pnl) / maxAbs) * 100
            return (
              <button
                key={s.label}
                onClick={() => setSectorFocus(s.label)}
                title={`View ${s.label} trades`}
                className="flex w-full items-center gap-3 rounded-md px-1.5 py-1 text-left text-xs transition-colors hover:bg-raised"
              >
                <div className="flex w-40 shrink-0 items-center gap-1 truncate font-medium" title={s.label}>
                  <ChevronRight size={12} className="shrink-0 text-muted" />
                  <span className="truncate">{s.label}</span>
                </div>
                <div className="relative h-4 min-w-0 flex-1 rounded bg-raised">
                  <div className={`h-full rounded ${s.pnl >= 0 ? 'bg-ok' : 'bg-danger'}`} style={{ width: `${w}%`, opacity: 0.85 }} />
                </div>
                <div className={`w-24 shrink-0 text-right tabular-nums ${pos(s.pnl)}`}>{signedMoney(s.pnl)}</div>
                <div className="w-16 shrink-0 text-right text-muted">{num(s.trades)}t</div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ========================== sector drill-down ========================= */

/** The effective sector for a symbol, matching how computeMetrics buckets it. */
function sectorOfSymbol(sectors: Record<string, string>, symbol: string): string {
  return sectors[symbol] || 'Unclassified'
}

/**
 * A simplified per-sector analytics page: the stocks traded in one market
 * sector, how profitable each was, and the sector's headline stats. Reached by
 * clicking a bar in the "Realized P&L by market sector" card.
 */
export function SectorDetail(): React.JSX.Element | null {
  const sector = useTrades((s) => s.sectorFocus)
  const trades = useTrades((s) => s.trades)
  const sectors = useTrades((s) => s.sectors)
  const setSectorFocus = useTrades((s) => s.setSectorFocus)
  if (!sector) return null

  const inSector = trades.filter((t) => sectorOfSymbol(sectors, t.symbol) === sector)
  const stats = computeStats(inSector)
  const openPositions = inSector.filter((t) => t.isOpen)
  const rows = stats.bySymbol.filter((r) => r.trades > 0 || r.openQty > 0)

  const back = (): void => setSectorFocus(null)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {/* header / back */}
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={back}
          className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface px-3 py-1.5 text-sm font-medium hover:border-accent/60"
        >
          <ChevronLeft size={15} /> Back
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-base font-bold tracking-tight">{sector}</h2>
          <p className="truncate text-xs text-muted">
            {rows.length} symbol{rows.length === 1 ? '' : 's'} traded · {stats.closedTrades} closed
            {openPositions.length > 0 ? ` · ${openPositions.length} open` : ''}
          </p>
        </div>
      </div>

      {/* headline tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-edge bg-surface p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Realized P&L</div>
          <div className={`mt-0.5 text-lg font-bold tabular-nums ${pos(stats.totalRealized)}`}>{signedMoney(stats.totalRealized)}</div>
          <div className="text-[10px] text-muted">{stats.closedTrades} closed trades</div>
        </div>
        <div className="rounded-xl border border-edge bg-surface p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Win rate</div>
          <div className="mt-0.5 text-lg font-bold tabular-nums">{pct(stats.winRate)}</div>
          <div className="text-[10px] text-muted">{stats.wins}W · {stats.losses}L · {stats.breakeven}BE</div>
        </div>
        <div className="rounded-xl border border-edge bg-surface p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Profit factor</div>
          <div className="mt-0.5 text-lg font-bold tabular-nums">{Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'}</div>
          <div className="text-[10px] text-muted">expectancy {money(stats.expectancy)}/trade</div>
        </div>
        <div className="rounded-xl border border-edge bg-surface p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Avg hold</div>
          <div className="mt-0.5 text-lg font-bold tabular-nums">{duration(stats.avgHoldSeconds)}</div>
          <div className="text-[10px] text-muted">best {stats.bestSymbol?.symbol ?? '—'} · worst {stats.worstSymbol?.symbol ?? '—'}</div>
        </div>
      </div>

      {/* per-symbol table */}
      <div className="mt-4 overflow-hidden rounded-xl border border-edge bg-surface">
        <div className="grid grid-cols-[80px_1fr_70px_90px_110px_90px] gap-2 border-b border-edge px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
          <div>Symbol</div>
          <div>Realized P&L</div>
          <div className="text-right">Trades</div>
          <div className="text-right">W / L</div>
          <div className="text-right">Win rate</div>
          <div className="text-right">Open</div>
        </div>
        {rows.length === 0 ? (
          <div className="p-6 text-sm text-muted">No closed trades in this sector yet.</div>
        ) : (
          rows.map((r) => {
            const maxAbs = Math.max(1, ...rows.map((x) => Math.abs(x.realizedPnl)))
            const w = (Math.abs(r.realizedPnl) / maxAbs) * 100
            const decided = r.wins + r.losses
            const wr = decided > 0 ? (r.wins / decided) * 100 : 0
            return (
              <div key={r.symbol} className="grid grid-cols-[80px_1fr_70px_90px_110px_90px] items-center gap-2 border-b border-edge/60 px-3 py-2 text-xs last:border-0">
                <div className="font-semibold">{r.symbol}</div>
                <div className="flex items-center gap-2">
                  <div className="relative h-3.5 min-w-0 flex-1 rounded bg-raised">
                    <div className={`h-full rounded ${r.realizedPnl >= 0 ? 'bg-ok' : 'bg-danger'}`} style={{ width: `${w}%`, opacity: 0.85 }} />
                  </div>
                  <span className={`w-20 shrink-0 text-right tabular-nums ${pos(r.realizedPnl)}`}>{signedMoney(r.realizedPnl)}</span>
                </div>
                <div className="text-right tabular-nums text-muted">{num(r.trades)}</div>
                <div className="text-right tabular-nums">
                  <span className="text-ok">{r.wins}</span> / <span className="text-danger">{r.losses}</span>
                </div>
                <div className="text-right tabular-nums">{decided > 0 ? pct(wr) : '—'}</div>
                <div className="text-right tabular-nums text-muted">{r.openQty > 0 ? num(r.openQty) : '—'}</div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/* ============================== stats tab ============================= */

function StatCell({ label, value, tone, sub }: { label: string; value: string; tone?: 'ok' | 'danger'; sub?: string }): React.JSX.Element {
  const color = tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : 'text-ink'
  return (
    <div className="rounded-lg border border-edge bg-surface px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-0.5 text-sm font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted">{sub}</div>}
    </div>
  )
}

function StatGroup({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">{children}</div>
    </div>
  )
}

export function StatsTab(): React.JSX.Element {
  const m = useTrades((s) => s.metrics)
  if (!m || m.closedTrades === 0) return <div className="p-8 text-sm text-muted">No closed trades yet.</div>
  const sm = signedMoney
  const t = (tone: number): 'ok' | 'danger' => (tone >= 0 ? 'ok' : 'danger')
  return (
    <div className="space-y-5 p-4">
      <StatGroup title="Totals">
        <StatCell label="Total P&L (realized)" value={sm(m.totalPnl)} tone={t(m.totalPnl)} />
        <StatCell label="Gross P&L" value={sm(m.totalPnl)} tone={t(m.totalPnl)} sub="no commission data in export" />
        <StatCell label="Only profit" value={sm(m.onlyProfit)} tone="ok" />
        <StatCell label="Only loss" value={sm(m.onlyLoss)} tone="danger" />
      </StatGroup>

      <StatGroup title="Extremes">
        <StatCell label="Best trade" value={sm(m.bestTrade)} tone="ok" />
        <StatCell label="Worst trade" value={sm(m.worstTrade)} tone="danger" />
        <StatCell label="Best day" value={sm(m.bestDay)} tone="ok" />
        <StatCell label="Worst day" value={sm(m.worstDay)} tone="danger" />
      </StatGroup>

      <StatGroup title="By period (rolling, ending at your latest trade)">
        <StatCell label="Last day" value={sm(m.lastDay)} tone={t(m.lastDay)} />
        <StatCell label="Last week" value={sm(m.lastWeek)} tone={t(m.lastWeek)} />
        <StatCell label="Last month" value={sm(m.lastMonth)} tone={t(m.lastMonth)} />
        <StatCell label="Last year" value={sm(m.lastYear)} tone={t(m.lastYear)} />
      </StatGroup>

      <StatGroup title="Averages · per period">
        <StatCell label="Per trade" value={sm(m.avgPerTrade.pnl)} tone={t(m.avgPerTrade.pnl)} sub={`${pct(m.avgPerTrade.pct)} avg`} />
        <StatCell label="Per day" value={sm(m.avgPerDay.pnl)} tone={t(m.avgPerDay.pnl)} sub={`${num(m.tradingDays)} days`} />
        <StatCell label="Per month" value={sm(m.avgPerMonth.pnl)} tone={t(m.avgPerMonth.pnl)} sub={`${num(m.tradingMonths)} months`} />
        <StatCell label="Per year" value={sm(m.avgPerYear.pnl)} tone={t(m.avgPerYear.pnl)} sub={`${num(m.tradingYears)} years`} />
      </StatGroup>

      <StatGroup title="Averages · winning">
        <StatCell label="Per trade" value={sm(m.winAvgPerTrade)} tone="ok" />
        <StatCell label="Per day" value={sm(m.winAvgPerDay)} tone="ok" />
        <StatCell label="Per month" value={sm(m.winAvgPerMonth)} tone="ok" />
        <StatCell label="Per year" value={sm(m.winAvgPerYear)} tone="ok" />
      </StatGroup>

      <StatGroup title="Averages · losing">
        <StatCell label="Per trade" value={sm(m.lossAvgPerTrade)} tone="danger" />
        <StatCell label="Per day" value={sm(m.lossAvgPerDay)} tone="danger" />
        <StatCell label="Per month" value={sm(m.lossAvgPerMonth)} tone="danger" />
        <StatCell label="Per year" value={sm(m.lossAvgPerYear)} tone="danger" />
      </StatGroup>

      <StatGroup title="Win / loss %">
        <StatCell label="Winning trades" value={`${m.winningTradesPct.toFixed(1)}%`} tone="ok" />
        <StatCell label="Breakeven trades" value={`${m.breakevenTradesPct.toFixed(1)}%`} />
        <StatCell label="Avg winning %" value={pct(m.avgWinningPct)} tone="ok" />
        <StatCell label="Avg losing %" value={pct(m.avgLosingPct)} tone="danger" />
      </StatGroup>

      <StatGroup title="Risk & consistency">
        <StatCell label="Max drawdown" value={sm(m.maxDrawdown)} tone="danger" sub={`${m.maxDrawdownPct.toFixed(1)}% from peak`} />
        <StatCell label="Longest underwater" value={`${num(m.longestDrawdownDays)} day(s)`} sub="consecutive below peak" />
        <StatCell label="Daily P&L std-dev" value={money(m.dailyStdev)} sub="lower = steadier" />
        <StatCell label="Avg / day" value={sm(m.avgPerDay.pnl)} tone={t(m.avgPerDay.pnl)} sub={`over ${num(m.tradingDays)} day(s)`} />
      </StatGroup>
    </div>
  )
}

/* ============================ breakdown tab =========================== */

const toCols = (buckets: MetricBucket[]): MetricCol[] =>
  buckets.filter((b) => b.trades > 0).map((b) => ({ label: b.label, pnl: b.pnl, trades: b.trades, wins: b.wins, losses: b.losses }))

function HighlightPanel({ hi }: { hi: BucketHighlights }): React.JSX.Element {
  const row = (label: string, bucket: MetricBucket | { label: string; pnl: number } | null, tone: 'ok' | 'danger' | 'muted'): React.JSX.Element => (
    <div className="flex items-center justify-between gap-2 border-b border-edge/40 py-1.5 last:border-b-0 text-xs">
      <span className={`font-semibold uppercase tracking-wide ${tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : 'text-muted'}`}>{label}</span>
      {bucket ? (
        <span className="flex items-center gap-2">
          <span className={`tabular-nums ${bucket.pnl >= 0 ? 'text-ok' : 'text-danger'}`}>{signedMoney(bucket.pnl)}</span>
          <span className="max-w-[120px] truncate text-muted">{bucket.label}</span>
        </span>
      ) : (
        <span className="text-muted">—</span>
      )}
    </div>
  )
  return (
    <div className="rounded-lg border border-edge bg-raised/40 p-3">
      {row('Best', hi.best, 'ok')}
      {row('Worst', hi.worst, 'danger')}
      {row('Sweet spot', hi.sweetSpot, 'ok')}
      {row('Danger zone', hi.dangerZone, 'danger')}
      {row('Activity hub', hi.volumeHub, 'muted')}
    </div>
  )
}

function ChartCard({
  title,
  m,
  buckets,
  hi
}: {
  title: string
  m: TradeMetrics
  buckets: MetricBucket[]
  hi?: BucketHighlights
}): React.JSX.Element {
  const [mode, setMode] = useState<'pnl' | 'winloss'>('pnl')
  void m
  const cols = toCols(buckets)
  return (
    <div className="rounded-xl border border-edge bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="flex overflow-hidden rounded-lg border border-edge text-xs">
          <button onClick={() => setMode('pnl')} className={`px-2 py-1 ${mode === 'pnl' ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink'}`}>
            Agg P&L
          </button>
          <button onClick={() => setMode('winloss')} className={`px-2 py-1 ${mode === 'winloss' ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink'}`}>
            Win/Loss
          </button>
        </div>
      </div>
      <div className={hi ? 'grid grid-cols-1 gap-3 lg:grid-cols-[1fr_240px]' : ''}>
        <div className="min-w-0">
          {mode === 'pnl' ? <AggPnlColumns cols={cols} /> : <WinLossColumns cols={cols} />}
        </div>
        {hi && <HighlightPanel hi={hi} />}
      </div>
    </div>
  )
}

export function BreakdownTab(): React.JSX.Element {
  const m = useTrades((s) => s.metrics)
  if (!m || m.closedTrades === 0) return <div className="p-8 text-sm text-muted">No closed trades yet.</div>
  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCell label="Market open (9:30–10:30)" value={signedMoney(m.marketOpen.pnl)} tone={m.marketOpen.pnl >= 0 ? 'ok' : 'danger'} sub={`${num(m.marketOpen.trades)} trade(s)`} />
        <StatCell label="Power hour (15:00–16:00)" value={signedMoney(m.powerHour.pnl)} tone={m.powerHour.pnl >= 0 ? 'ok' : 'danger'} sub={`${num(m.powerHour.trades)} trade(s)`} />
        <StatCell label="Best price band" value={m.priceHi.best ? signedMoney(m.priceHi.best.pnl) : '—'} tone="ok" sub={m.priceHi.best?.label} />
        <StatCell label="Best duration band" value={m.durationHi.best ? signedMoney(m.durationHi.best.pnl) : '—'} tone="ok" sub={m.durationHi.best?.label} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-edge bg-surface p-4">
          <h3 className="mb-3 text-sm font-semibold">P&L distribution (per trade)</h3>
          <DistributionChart buckets={m.pnlDistribution} />
        </div>
        <div className="rounded-xl border border-edge bg-surface p-4">
          <h3 className="mb-3 text-sm font-semibold">Weekday × hour heatmap (ET close time)</h3>
          <HeatmapCard pnl={m.weekdayHourPnl} n={m.weekdayHourN} />
        </div>
      </div>

      <ChartCard title="P&L vs price range" m={m} buckets={m.byPriceRange} hi={m.priceHi} />
      <ChartCard title="P&L vs volume (share size)" m={m} buckets={m.byVolumeRange} hi={m.volumeHi} />
      <ChartCard title="P&L vs time of day (ET)" m={m} buckets={m.byTimeOfDay} hi={m.timeHi} />
      <ChartCard title="P&L vs hold duration" m={m} buckets={m.byDurationRange} hi={m.durationHi} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartCard title="P&L vs day of week" m={m} buckets={m.byDayOfWeek} />
        <ChartCard title="P&L vs month" m={m} buckets={m.byMonth} />
        <ChartCard title="P&L vs year" m={m} buckets={m.byYear} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="P&L vs position" m={m} buckets={m.byPosition} />
        <ChartCard title="P&L vs asset type" m={m} buckets={m.byAssetType} />
      </div>

      <div className="rounded-xl border border-edge bg-surface p-4">
        <h3 className="mb-3 text-sm font-semibold">Daily drawdown (peak-to-trough of cumulative P&L)</h3>
        <DrawdownArea points={m.drawdown} />
      </div>
    </div>
  )
}

/* =========================== distribution chart ======================= */

/** Count-of-trades columns across P&L buckets; loss side red, profit side green. */
function DistributionChart({ buckets }: { buckets: MetricBucket[] }): React.JSX.Element {
  const withData = buckets.some((b) => b.trades > 0)
  if (!withData) return <div className="flex h-32 items-center justify-center text-sm text-muted">No closed trades.</div>
  const maxN = Math.max(1, ...buckets.map((b) => b.trades))
  const isLoss = (label: string): boolean => label.startsWith('-') || label.startsWith('≤')
  return (
    <div className="w-full overflow-x-auto">
      <div className="flex min-w-full items-end gap-1" style={{ height: 180 }}>
        {buckets.map((b) => (
          <div key={b.label} className="group flex min-w-[28px] flex-1 flex-col items-center justify-end gap-1" title={`${b.label}: ${b.trades} trade(s)`}>
            <span className="text-[9px] tabular-nums text-muted opacity-0 group-hover:opacity-100">{b.trades || ''}</span>
            <div className="flex h-full w-full items-end justify-center">
              <div
                className="w-full rounded-t"
                style={{ height: `${(b.trades / maxN) * 100}%`, background: isLoss(b.label) ? 'rgb(var(--wk-danger))' : 'rgb(var(--wk-ok))', opacity: 0.85, minHeight: b.trades ? 2 : 0 }}
              />
            </div>
            <div className="h-9 origin-top-left -rotate-45 whitespace-nowrap text-[9px] leading-tight text-muted">{b.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ============================== heatmap =============================== */

const HEAT_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function HeatmapCard({ pnl, n }: { pnl: number[][]; n: number[][] }): React.JSX.Element {
  // only show hours that saw any activity, to keep the grid compact
  const activeHours: number[] = []
  for (let h = 0; h < 24; h++) {
    let any = 0
    for (let d = 0; d < 7; d++) any += n[d]?.[h] ?? 0
    if (any > 0) activeHours.push(h)
  }
  if (activeHours.length === 0) return <div className="flex h-32 items-center justify-center text-sm text-muted">No closed trades.</div>
  let maxAbs = 1
  for (let d = 0; d < 7; d++) for (const h of activeHours) maxAbs = Math.max(maxAbs, Math.abs(pnl[d]?.[h] ?? 0))
  const cell = (d: number, h: number): React.JSX.Element => {
    const v = pnl[d]?.[h] ?? 0
    const c = n[d]?.[h] ?? 0
    const intensity = c === 0 ? 0 : Math.max(0.12, Math.abs(v) / maxAbs)
    const bg = c === 0 ? 'transparent' : `rgb(var(--wk-${v >= 0 ? 'ok' : 'danger'}) / ${intensity.toFixed(2)})`
    return (
      <td key={h} className="p-0.5">
        <div
          className="h-6 w-full rounded"
          style={{ background: bg, border: c === 0 ? '1px solid rgb(var(--wk-edge)/0.4)' : 'none' }}
          title={c === 0 ? `${HEAT_DOW[d]} ${h}:00 — no trades` : `${HEAT_DOW[d]} ${h}:00 — ${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(0)} · ${c} trade(s)`}
        />
      </td>
    )
  }
  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full border-separate" style={{ borderSpacing: 0 }}>
        <thead>
          <tr>
            <th className="w-8" />
            {activeHours.map((h) => (
              <th key={h} className="text-[9px] font-normal text-muted">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[1, 2, 3, 4, 5, 0, 6].map((d) => (
            <tr key={d}>
              <td className="pr-1 text-right text-[10px] text-muted">{HEAT_DOW[d]}</td>
              {activeHours.map((h) => cell(d, h))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5 text-[10px] text-muted">Green = net profit, red = net loss; deeper = larger. Hour is ET close time.</p>
    </div>
  )
}

/* ============================== calendar ============================= */

export function CalendarTab(): React.JSX.Element {
  const m = useTrades((s) => s.metrics)
  const byDate = new Map((m?.daily ?? []).map((d) => [d.date, d]))
  // default to the latest trading month (or the current month if none)
  const latest = m?.daily.length ? m.daily[m.daily.length - 1].date : ''
  const [ym, setYm] = useState(() => {
    if (latest) {
      const [y, mo] = latest.split('-').map(Number)
      return { y, m: mo }
    }
    const now = new Date()
    return { y: now.getFullYear(), m: now.getMonth() + 1 }
  })

  if (!m || m.closedTrades === 0) return <div className="p-8 text-sm text-muted">No closed trades yet.</div>

  const key = (d: number): string => `${ym.y}-${String(ym.m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const daysInMonth = new Date(Date.UTC(ym.y, ym.m, 0)).getUTCDate()
  const firstDow = new Date(Date.UTC(ym.y, ym.m - 1, 1)).getUTCDay()
  const monthName = new Date(Date.UTC(ym.y, ym.m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

  // month summary
  let monthPnl = 0
  let monthTrades = 0
  let greenDays = 0
  let redDays = 0
  for (let d = 1; d <= daysInMonth; d++) {
    const cell = byDate.get(key(d))
    if (!cell) continue
    monthPnl += cell.pnl
    monthTrades += cell.trades
    if (cell.pnl > 0) greenDays++
    else if (cell.pnl < 0) redDays++
  }

  const shift = (delta: number): void => {
    let y = ym.y
    let mo = ym.m + delta
    if (mo < 1) {
      mo = 12
      y--
    } else if (mo > 12) {
      mo = 1
      y++
    }
    setYm({ y, m: mo })
  }

  // build week rows (each 7 cells; leading blanks before firstDow)
  const cells: (number | null)[] = []
  for (let i = 0; i < firstDow; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks: (number | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button onClick={() => shift(-1)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-edge hover:bg-raised">
            <ChevronLeft size={16} />
          </button>
          <h2 className="min-w-[160px] text-center text-base font-bold">{monthName}</h2>
          <button onClick={() => shift(1)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-edge hover:bg-raised">
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <span>
            Month P&L <b className={pos(monthPnl)}>{signedMoney(monthPnl)}</b>
          </span>
          <span className="text-muted">{num(monthTrades)} trades</span>
          <span className="text-ok">{greenDays} green</span>
          <span className="text-danger">{redDays} red</span>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-edge bg-surface">
        <div className="grid grid-cols-7 border-b border-edge bg-raised/40 text-center text-[11px] font-semibold uppercase tracking-wide text-muted">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d} className="py-1.5">{d}</div>
          ))}
        </div>
        <div>
          {weeks.map((week, wi) => {
            let weekPnl = 0
            for (const d of week) {
              const c = d ? byDate.get(key(d)) : undefined
              if (c) weekPnl += c.pnl
            }
            return (
              <div key={wi} className="grid grid-cols-[repeat(7,1fr)] border-b border-edge/50 last:border-b-0">
                {week.map((d, di) => {
                  const c = d ? byDate.get(key(d)) : undefined
                  return (
                    <div
                      key={di}
                      className="relative min-h-[74px] border-r border-edge/40 p-1.5 last:border-r-0"
                      style={{ background: c ? `rgb(var(--wk-${c.pnl >= 0 ? 'ok' : 'danger'}) / ${Math.min(0.22, 0.06 + Math.abs(c.pnl) / 3000).toFixed(2)})` : 'transparent' }}
                    >
                      {d && <div className="text-[11px] font-medium text-muted">{d}</div>}
                      {c && (
                        <div className="mt-1">
                          <div className={`text-[13px] font-bold tabular-nums ${pos(c.pnl)}`}>{signedMoney(c.pnl)}</div>
                          <div className="text-[10px] text-muted">{c.trades} trade{c.trades === 1 ? '' : 's'}</div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
