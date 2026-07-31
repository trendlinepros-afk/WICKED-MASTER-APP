import { ModuleTitle } from '@/shell/moduleContext'
import { useEffect } from 'react'
import { AlertTriangle, Calculator } from 'lucide-react'
import { useRisk, type Inputs, type Tab } from './store'
import { positionSize, riskReward, optionCalc, expectancy } from './calc'

/* -------------------------------- helpers -------------------------------- */

const P = (s: string): number => {
  const n = Number(String(s).replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : 0
}
const money = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const money2 = (n: number): string => `$${n.toFixed(2)}`
const pct = (n: number): string => `${n.toFixed(1)}%`
const intFmt = (n: number): string => n.toLocaleString('en-US')

function Field({
  label,
  value,
  onChange,
  prefix,
  suffix,
  wide
}: {
  label: string
  value: string
  onChange: (v: string) => void
  prefix?: string
  suffix?: string
  wide?: boolean
}): React.JSX.Element {
  return (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      <div className="flex items-center rounded-lg border border-edge bg-raised focus-within:border-accent">
        {prefix && <span className="pl-2.5 text-sm text-muted">{prefix}</span>}
        <input
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-transparent px-2.5 py-2 text-sm outline-none"
        />
        {suffix && <span className="pr-2.5 text-sm text-muted">{suffix}</span>}
      </div>
    </label>
  )
}

function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { v: T; label: string }[] }): React.JSX.Element {
  return (
    <div className="inline-flex rounded-lg border border-edge bg-raised p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            value === o.v ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-edge bg-surface p-3">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`mt-0.5 text-lg font-bold tabular-nums ${tone ?? 'text-ink'}`}>{value}</div>
    </div>
  )
}

function Note({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'ok' | 'danger' | 'warn' }): React.JSX.Element {
  const cls = tone === 'ok' ? 'bg-ok/10 text-ok' : tone === 'danger' ? 'bg-danger/10 text-danger' : tone === 'warn' ? 'bg-warn/10 text-warn' : 'bg-raised text-muted'
  return <p className={`mt-3 rounded-lg px-3 py-2 text-xs ${cls}`}>{children}</p>
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'position', label: 'Position Size' },
  { id: 'rr', label: 'Risk / Reward' },
  { id: 'options', label: 'Options' },
  { id: 'expectancy', label: 'Expectancy / Kelly' }
]

/* --------------------------------- tabs ---------------------------------- */

function PositionTab({ inputs, set }: { inputs: Inputs; set: <K extends keyof Inputs>(k: K, v: Inputs[K]) => void }): React.JSX.Element {
  const r = positionSize({
    account: P(inputs.account),
    riskPercent: P(inputs.riskPercent),
    entry: P(inputs.entry),
    stop: P(inputs.stop),
    direction: inputs.direction
  })
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div>
        <div className="mb-3 flex items-center gap-2">
          <span className="text-xs font-medium text-muted">Direction</span>
          <Seg
            value={inputs.direction}
            onChange={(v) => set('direction', v)}
            options={[
              { v: 'long', label: 'Long' },
              { v: 'short', label: 'Short' }
            ]}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Entry price" value={inputs.entry} onChange={(v) => set('entry', v)} prefix="$" />
          <Field label="Stop-loss price" value={inputs.stop} onChange={(v) => set('stop', v)} prefix="$" />
        </div>
      </div>
      <div>
        {r.ok ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Shares to buy" value={intFmt(r.shares)} tone="text-accent" />
              <Stat label="Dollar risk" value={money(r.actualRisk)} tone="text-danger" />
              <Stat label="Position cost" value={money(r.positionCost)} />
              <Stat label="Risk / share" value={money2(r.perShareRisk)} />
              <Stat label="% of account" value={pct(r.accountPercent)} tone={r.accountPercent > 100 ? 'text-warn' : 'text-ink'} />
              <Stat label="Risk budget" value={money(r.riskAmount)} />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3">
              {r.rTargets.map((t) => (
                <Stat key={t.r} label={`${t.r}R target`} value={money2(t.price)} tone="text-ok" />
              ))}
            </div>
            {r.accountPercent > 100 && (
              <Note tone="warn">This position costs more than your whole account — it would need margin/leverage.</Note>
            )}
          </>
        ) : (
          <Note tone="warn">{r.error}</Note>
        )}
      </div>
    </div>
  )
}

function RRTab({ inputs, set }: { inputs: Inputs; set: <K extends keyof Inputs>(k: K, v: Inputs[K]) => void }): React.JSX.Element {
  const r = riskReward({
    entry: P(inputs.rrEntry),
    stop: P(inputs.rrStop),
    target: P(inputs.rrTarget),
    winRate: P(inputs.rrWinRate)
  })
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Entry price" value={inputs.rrEntry} onChange={(v) => set('rrEntry', v)} prefix="$" />
        <Field label="Stop-loss price" value={inputs.rrStop} onChange={(v) => set('rrStop', v)} prefix="$" />
        <Field label="Target price" value={inputs.rrTarget} onChange={(v) => set('rrTarget', v)} prefix="$" />
        <Field label="Win rate (optional)" value={inputs.rrWinRate} onChange={(v) => set('rrWinRate', v)} suffix="%" />
      </div>
      <div>
        {r.ok ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Risk : Reward" value={`${r.rr.toFixed(2)} : 1`} tone={r.rr >= 2 ? 'text-ok' : r.rr >= 1 ? 'text-warn' : 'text-danger'} />
              <Stat label="Risk / share" value={money2(r.risk)} tone="text-danger" />
              <Stat label="Reward / share" value={money2(r.reward)} tone="text-ok" />
              <Stat label="Breakeven win rate" value={pct(r.breakevenWinRate)} />
              {r.expectancyR != null && (
                <Stat label="Expectancy" value={`${r.expectancyR >= 0 ? '+' : ''}${r.expectancyR.toFixed(2)}R`} tone={r.expectancyR >= 0 ? 'text-ok' : 'text-danger'} />
              )}
            </div>
            {r.expectancyR != null && (
              <Note tone={r.expectancyR >= 0 ? 'ok' : 'danger'}>
                At {P(inputs.rrWinRate).toFixed(0)}% win rate and {r.rr.toFixed(1)}:1, you {r.expectancyR >= 0 ? 'make' : 'lose'} an average of{' '}
                {Math.abs(r.expectancyR).toFixed(2)}R per trade. You need a {r.breakevenWinRate.toFixed(0)}% win rate just to break even at this
                R:R.
              </Note>
            )}
          </>
        ) : (
          <Note tone="warn">Enter entry, stop and target prices.</Note>
        )}
      </div>
    </div>
  )
}

function OptionsTab({ inputs, set }: { inputs: Inputs; set: <K extends keyof Inputs>(k: K, v: Inputs[K]) => void }): React.JSX.Element {
  const r = optionCalc({
    optionType: inputs.optType,
    underlying: P(inputs.underlying),
    strike: P(inputs.strike),
    premium: P(inputs.premium),
    contracts: P(inputs.contracts),
    multiplier: 100,
    account: P(inputs.account),
    riskPercent: P(inputs.riskPercent)
  })
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div>
        <div className="mb-3 flex items-center gap-2">
          <span className="text-xs font-medium text-muted">Type</span>
          <Seg
            value={inputs.optType}
            onChange={(v) => set('optType', v)}
            options={[
              { v: 'call', label: 'Call' },
              { v: 'put', label: 'Put' }
            ]}
          />
          <span className="ml-2 text-[11px] text-muted">Long (bought) · 100 shares/contract</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Underlying price" value={inputs.underlying} onChange={(v) => set('underlying', v)} prefix="$" />
          <Field label="Strike" value={inputs.strike} onChange={(v) => set('strike', v)} prefix="$" />
          <Field label="Premium / share" value={inputs.premium} onChange={(v) => set('premium', v)} prefix="$" />
          <Field label="Contracts" value={inputs.contracts} onChange={(v) => set('contracts', v)} />
        </div>
      </div>
      <div>
        {r.ok ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Capital at risk" value={money(r.costBasis)} tone="text-danger" />
              <Stat label="Per contract" value={money(r.costPerContract)} />
              <Stat label="Breakeven" value={money2(r.breakeven)} tone="text-accent" />
              <Stat label="Move to breakeven" value={`${r.moveToBreakevenPct >= 0 ? '+' : ''}${r.moveToBreakevenPct.toFixed(1)}%`} />
              <Stat label="Intrinsic" value={money2(r.intrinsic)} />
              <Stat label="Extrinsic (time)" value={money2(r.extrinsic)} />
            </div>
            {r.maxContractsForRisk != null && r.riskBudget != null && (
              <Note tone="muted">
                Max loss on a long {inputs.optType} is the premium: <strong className="text-danger">{money(r.costBasis)}</strong>. Your{' '}
                {P(inputs.riskPercent)}% risk budget of {money(r.riskBudget)} covers{' '}
                <strong className="text-ink">{intFmt(r.maxContractsForRisk)}</strong> contract(s).
              </Note>
            )}
          </>
        ) : (
          <Note tone="warn">Enter a strike and premium.</Note>
        )}
      </div>
    </div>
  )
}

function ExpectancyTab({ inputs, set }: { inputs: Inputs; set: <K extends keyof Inputs>(k: K, v: Inputs[K]) => void }): React.JSX.Element {
  const r = expectancy({ winRate: P(inputs.winRate), avgWin: P(inputs.avgWin), avgLoss: P(inputs.avgLoss) })
  const pf = r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2)
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Win rate" value={inputs.winRate} onChange={(v) => set('winRate', v)} suffix="%" />
        <div />
        <Field label="Avg win ($ or R)" value={inputs.avgWin} onChange={(v) => set('avgWin', v)} />
        <Field label="Avg loss ($ or R)" value={inputs.avgLoss} onChange={(v) => set('avgLoss', v)} />
      </div>
      <div>
        {r.ok ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Expectancy / trade" value={`${r.expectancy >= 0 ? '+' : ''}${r.expectancy.toFixed(2)}`} tone={r.expectancy >= 0 ? 'text-ok' : 'text-danger'} />
              <Stat label="Payoff ratio" value={`${r.payoffRatio.toFixed(2)} : 1`} />
              <Stat label="Profit factor" value={pf} tone={r.profitFactor >= 1 ? 'text-ok' : 'text-danger'} />
              <Stat label="Kelly" value={pct(r.kelly * 100)} />
              <Stat label="Half-Kelly" value={pct(r.halfKelly * 100)} tone="text-accent" />
            </div>
            <Note tone={r.expectancy >= 0 ? 'ok' : 'danger'}>
              {r.expectancy >= 0
                ? `Positive edge — this system makes ~${r.expectancy.toFixed(2)} per trade on average.`
                : `Negative edge — this system loses ~${Math.abs(r.expectancy).toFixed(2)} per trade over time.`}{' '}
              Kelly suggests risking up to {pct(r.kelly * 100)} of capital per trade; most traders use <strong>half-Kelly</strong> ({pct(r.halfKelly * 100)}) or less.
            </Note>
          </>
        ) : (
          <Note tone="warn">Enter win rate, average win and average loss.</Note>
        )}
      </div>
    </div>
  )
}

/* --------------------------------- screen -------------------------------- */

export default function RiskCalculator(): React.JSX.Element {
  const { tab, inputs, setTab, set, load } = useRisk()

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="h-full overflow-y-auto bg-bg p-6">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-raised text-accent">
            <Calculator size={20} />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight"><ModuleTitle fallback="Risk Calculator" /></h1>
            <p className="text-xs text-muted">Size every trade to a fixed risk — stocks and options.</p>
          </div>
        </div>

        {/* account bar */}
        <div className="mt-4 grid grid-cols-2 gap-3 rounded-xl border border-edge bg-surface p-3 sm:max-w-md">
          <Field label="Account size" value={inputs.account} onChange={(v) => set('account', v)} prefix="$" />
          <Field label="Risk per trade" value={inputs.riskPercent} onChange={(v) => set('riskPercent', v)} suffix="%" />
        </div>

        {/* tabs */}
        <div className="mt-5 flex flex-wrap gap-1 border-b border-edge">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm ${
                tab === t.id ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="mt-5">
          {tab === 'position' && <PositionTab inputs={inputs} set={set} />}
          {tab === 'rr' && <RRTab inputs={inputs} set={set} />}
          {tab === 'options' && <OptionsTab inputs={inputs} set={set} />}
          {tab === 'expectancy' && <ExpectancyTab inputs={inputs} set={set} />}
        </div>

        <p className="mt-8 flex items-center gap-1.5 text-[11px] text-muted">
          <AlertTriangle size={12} /> Estimates for planning only — not financial advice. Options figures assume long positions
          held to expiration (max loss = premium).
        </p>
      </div>
    </div>
  )
}
