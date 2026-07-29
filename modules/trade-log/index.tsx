import { useEffect } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  Loader2,
  NotebookPen,
  Plus,
  Save,
  Trash2
} from 'lucide-react'
import { useTradeLog } from './store'
import { autoName, effectiveAuto, entryPnl, entryTitle, isClosed, type JournalEntry } from './types'

/* -------------------------------- helpers -------------------------------- */

function fmtWhen(local: string): string {
  if (!local) return ''
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return local
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
const money = (n: number): string => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const signedMoney = (n: number): string => `${n >= 0 ? '+' : '-'}${money(n)}`
const numVal = (n: number | null): string => (n == null ? '' : String(n))
const parseNum = (s: string): number | null => {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

const inputCls =
  'w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent'
const labelCls = 'mb-1 block text-xs font-medium text-muted'
const areaCls = `${inputCls} min-h-[92px] resize-y leading-relaxed`

/* ------------------------------- list item ------------------------------- */

function EntryRow({ e, active, onClick }: { e: JournalEntry; active: boolean; onClick: () => void }): React.JSX.Element {
  const closed = isClosed(e)
  const pl = entryPnl(e)
  return (
    <button
      onClick={onClick}
      className={`w-full border-b border-edge/60 px-4 py-3 text-left transition-colors ${
        active ? 'bg-raised' : 'hover:bg-raised/50'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="truncate font-semibold">{entryTitle(e)}</span>
        {!effectiveAuto(e) && e.symbol && (
          <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] font-semibold text-muted">{e.symbol}</span>
        )}
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            closed ? 'bg-muted/15 text-muted' : 'bg-accent/15 text-accent'
          }`}
        >
          {closed ? 'Closed' : 'Open'}
        </span>
        {pl && (
          <span className={`ml-auto flex items-center gap-0.5 text-xs font-semibold tabular-nums ${pl.abs >= 0 ? 'text-ok' : 'text-danger'}`}>
            {pl.abs >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
            {signedMoney(pl.abs)}
          </span>
        )}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted">
        {fmtWhen(e.buyAt) || 'No date'}
        {e.shares > 0 && ` · ${e.shares} sh`}
      </div>
      {e.entryNote.trim() && <div className="mt-1 line-clamp-2 text-xs text-muted">{e.entryNote}</div>}
    </button>
  )
}

/* -------------------------------- editor --------------------------------- */

function Editor(): React.JSX.Element | null {
  const draft = useTradeLog((s) => s.draft)
  const dirty = useTradeLog((s) => s.dirty)
  const saving = useTradeLog((s) => s.saving)
  const edit = useTradeLog((s) => s.edit)
  const save = useTradeLog((s) => s.save)
  const remove = useTradeLog((s) => s.remove)
  if (!draft) return null
  const pl = entryPnl(draft)
  const auto = effectiveAuto(draft)
  const autoPreview = autoName(draft)

  return (
    <div className="mx-auto max-w-3xl p-6">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-bold tracking-tight">{entryTitle(draft, 'New trade')}</h2>
          <p className="text-xs text-muted">
            {isClosed(draft) ? 'Closed trade' : 'Open trade'}
            {pl && (
              <span className={pl.abs >= 0 ? 'text-ok' : 'text-danger'}>
                {' · '}
                {signedMoney(pl.abs)} ({pl.pct >= 0 ? '+' : ''}
                {pl.pct.toFixed(1)}%)
              </span>
            )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {dirty ? 'Save' : 'Saved'}
          </button>
          <button
            onClick={() => {
              if (window.confirm('Delete this journal entry? This cannot be undone.')) void remove(draft.id)
            }}
            title="Delete entry"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {/* NAME */}
      <div className="mt-5">
        <label className={labelCls}>Name this trade</label>
        <input
          value={auto ? '' : draft.name ?? ''}
          onChange={(e) => {
            const v = e.target.value
            if (v.trim() === '') edit({ name: '', nameAuto: true })
            else edit({ name: v, nameAuto: false })
          }}
          placeholder={autoPreview ? `Auto: ${autoPreview}` : 'Auto-named from ticker + dates — type to override'}
          className={`${inputCls} text-base font-semibold`}
        />
        <p className="mt-1 text-xs text-muted">
          {auto ? (
            <>
              Auto-named
              {autoPreview && (
                <>
                  {' '}
                  as <span className="font-medium text-ink">{autoPreview}</span>
                </>
              )}
              {' '}— it updates when you close the trade. Type to set your own.
            </>
          ) : (
            <>
              Custom name.{' '}
              <button className="text-accent hover:underline" onClick={() => edit({ name: '', nameAuto: true })}>
                Use auto name
              </button>
            </>
          )}
        </p>
      </div>

      {/* ENTRY */}
      <section className="mt-4 rounded-xl border border-edge bg-surface p-4">
        <h3 className="text-sm font-semibold text-accent">Entry — why you got in</h3>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="col-span-2 sm:col-span-1">
            <label className={labelCls}>Stock</label>
            <input
              value={draft.symbol}
              onChange={(e) => edit({ symbol: e.target.value.toUpperCase().replace(/[^A-Z0-9.\-]/g, '') })}
              placeholder="e.g. NVDA"
              className={`${inputCls} font-semibold`}
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <label className={labelCls}>Shares</label>
            <input
              inputMode="decimal"
              value={draft.shares === 0 ? '' : String(draft.shares)}
              onChange={(e) => edit({ shares: Math.max(0, parseNum(e.target.value) ?? 0) })}
              placeholder="e.g. 100"
              className={inputCls}
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <label className={labelCls}>Buy price</label>
            <input
              inputMode="decimal"
              value={numVal(draft.buyPrice)}
              onChange={(e) => edit({ buyPrice: parseNum(e.target.value) })}
              placeholder="e.g. 120.50"
              className={inputCls}
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <label className={labelCls}>Bought at</label>
            <input
              type="datetime-local"
              value={draft.buyAt}
              onChange={(e) => edit({ buyAt: e.target.value })}
              className={inputCls}
            />
          </div>
        </div>
        <div className="mt-3">
          <label className={labelCls}>Why I bought</label>
          <textarea
            value={draft.entryNote}
            onChange={(e) => edit({ entryNote: e.target.value })}
            placeholder="The setup, thesis, catalyst, and your plan going in…"
            className={areaCls}
          />
        </div>
      </section>

      {/* EXIT */}
      <section className="mt-4 rounded-xl border border-edge bg-surface p-4">
        <h3 className="text-sm font-semibold text-warn">Exit — why you got out</h3>
        <p className="mt-0.5 text-xs text-muted">Fill this in when you close the trade.</p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="col-span-2 sm:col-span-1">
            <label className={labelCls}>Sold price</label>
            <input
              inputMode="decimal"
              value={numVal(draft.sellPrice)}
              onChange={(e) => edit({ sellPrice: parseNum(e.target.value) })}
              placeholder="e.g. 131.00"
              className={inputCls}
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <label className={labelCls}>Sold at</label>
            <input
              type="datetime-local"
              value={draft.sellAt}
              onChange={(e) => edit({ sellAt: e.target.value })}
              className={inputCls}
            />
          </div>
        </div>
        <div className="mt-3">
          <label className={labelCls}>Why I left the trade</label>
          <textarea
            value={draft.exitNote}
            onChange={(e) => edit({ exitNote: e.target.value })}
            placeholder="Hit target, stop, thesis broke, needed the capital, emotions…"
            className={areaCls}
          />
        </div>
      </section>

      {/* FINAL REVIEW */}
      <section className="mt-4 rounded-xl border border-edge bg-surface p-4">
        <h3 className="text-sm font-semibold text-ink">Final review</h3>
        <p className="mt-0.5 text-xs text-muted">With hindsight — what you did well, what you'd change next time.</p>
        <textarea
          value={draft.finalReview}
          onChange={(e) => edit({ finalReview: e.target.value })}
          placeholder="Final thoughts: grade the trade, the lesson, the pattern to repeat or avoid…"
          className={`${areaCls} mt-3`}
        />
      </section>

      <div className="h-6" />
    </div>
  )
}

/* -------------------------------- screen --------------------------------- */

export default function TradeLog(): React.JSX.Element {
  const entries = useTradeLog((s) => s.entries)
  const selectedId = useTradeLog((s) => s.selectedId)
  const loading = useTradeLog((s) => s.loading)
  const load = useTradeLog((s) => s.load)
  const select = useTradeLog((s) => s.select)
  const newEntry = useTradeLog((s) => s.newEntry)

  useEffect(() => {
    void load()
  }, [load])

  // Save any pending edits when leaving the tool.
  useEffect(() => {
    return () => {
      if (useTradeLog.getState().dirty) void useTradeLog.getState().save()
    }
  }, [])

  const closedCount = entries.filter((e) => isClosed(e)).length

  return (
    <div className="flex h-full">
      {/* list */}
      <aside className="flex w-80 shrink-0 flex-col border-r border-edge bg-surface">
        <div className="border-b border-edge p-4">
          <div className="flex items-center gap-2">
            <NotebookPen size={18} className="text-accent" />
            <h1 className="text-base font-bold tracking-tight">Trade Log</h1>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {entries.length === 0 ? 'No entries yet' : `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · ${closedCount} closed`}
          </p>
          <button
            onClick={() => void newEntry()}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
          >
            <Plus size={15} /> New journal entry
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted">
              <Loader2 size={15} className="animate-spin" /> Loading…
            </div>
          ) : entries.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted">
              Click <span className="font-medium text-ink">New journal entry</span> to log your first trade.
            </div>
          ) : (
            entries.map((e) => (
              <EntryRow key={e.id} e={e} active={e.id === selectedId} onClick={() => void select(e.id)} />
            ))
          )}
        </div>
      </aside>

      {/* editor */}
      <main className="min-w-0 flex-1 overflow-y-auto bg-bg">
        {selectedId ? (
          <Editor />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted">
            <NotebookPen size={40} strokeWidth={1.5} className="opacity-40" />
            <div>
              <p className="text-sm font-medium">Your trade journal</p>
              <p className="mt-1 text-xs">Create an entry to record why you entered, why you exited, and your review.</p>
            </div>
            <button
              onClick={() => void newEntry()}
              className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
            >
              <Plus size={15} /> New journal entry
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
