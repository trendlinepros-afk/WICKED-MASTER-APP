/**
 * Pure risk-math — imported by both the renderer (instant UI) and ipc.ts (so the
 * MCP tools compute the exact same numbers). No electron/react here.
 */

export type Direction = 'long' | 'short'

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : 0
}
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/* ----------------------------- position sizing --------------------------- */

export interface PositionSizeInput {
  account: number
  riskPercent: number
  entry: number
  stop: number
  direction?: Direction
}
export interface PositionSizeResult {
  ok: boolean
  error?: string
  direction: Direction
  riskAmount: number
  perShareRisk: number
  shares: number
  positionCost: number
  actualRisk: number
  accountPercent: number
  rTargets: { r: number; price: number }[]
}

export function positionSize(i: PositionSizeInput): PositionSizeResult {
  const account = num(i.account)
  const riskPct = num(i.riskPercent)
  const entry = num(i.entry)
  const stop = num(i.stop)
  const direction: Direction = i.direction === 'short' ? 'short' : 'long'
  const riskAmount = (account * riskPct) / 100
  const perShareRisk = Math.abs(entry - stop)
  const base = {
    direction,
    riskAmount,
    perShareRisk,
    shares: 0,
    positionCost: 0,
    actualRisk: 0,
    accountPercent: 0,
    rTargets: [] as { r: number; price: number }[]
  }
  if (!(account > 0)) return { ok: false, error: 'Enter an account size.', ...base }
  if (!(riskPct > 0)) return { ok: false, error: 'Enter a risk % per trade.', ...base }
  if (!(entry > 0)) return { ok: false, error: 'Enter an entry price.', ...base }
  if (!(perShareRisk > 0)) return { ok: false, error: 'Your stop must be different from your entry.', ...base }

  const shares = Math.floor(riskAmount / perShareRisk)
  const positionCost = shares * entry
  const actualRisk = shares * perShareRisk
  const accountPercent = account > 0 ? (positionCost / account) * 100 : 0
  const rTargets = [1, 2, 3].map((r) => ({
    r,
    price: direction === 'long' ? entry + r * perShareRisk : entry - r * perShareRisk
  }))
  return { ok: true, ...base, shares, positionCost, actualRisk, accountPercent, rTargets }
}

/* ------------------------------- risk / reward --------------------------- */

export interface RiskRewardInput {
  entry: number
  stop: number
  target: number
  direction?: Direction
  winRate?: number
}
export interface RiskRewardResult {
  ok: boolean
  direction: Direction
  risk: number
  reward: number
  rr: number
  breakevenWinRate: number
  expectancyR: number | null
}

export function riskReward(i: RiskRewardInput): RiskRewardResult {
  const entry = num(i.entry)
  const stop = num(i.stop)
  const target = num(i.target)
  const direction: Direction = i.direction === 'short' ? 'short' : 'long'
  const risk = Math.abs(entry - stop)
  const reward = Math.abs(target - entry)
  const rr = risk > 0 ? reward / risk : 0
  const breakevenWinRate = rr > 0 ? 100 / (1 + rr) : 0
  const w = i.winRate != null ? clamp(num(i.winRate), 0, 100) / 100 : null
  const expectancyR = w != null && rr > 0 ? w * rr - (1 - w) : null
  return { ok: risk > 0 && reward > 0, direction, risk, reward, rr, breakevenWinRate, expectancyR }
}

/* --------------------------------- options ------------------------------- */

export interface OptionInput {
  optionType: 'call' | 'put'
  underlying: number
  strike: number
  premium: number
  contracts: number
  multiplier?: number
  account?: number
  riskPercent?: number
}
export interface OptionResult {
  ok: boolean
  optionType: 'call' | 'put'
  costPerContract: number
  costBasis: number
  breakeven: number
  moveToBreakevenPct: number
  intrinsic: number
  extrinsic: number
  riskBudget: number | null
  maxContractsForRisk: number | null
}

export function optionCalc(i: OptionInput): OptionResult {
  const optionType: 'call' | 'put' = i.optionType === 'put' ? 'put' : 'call'
  const underlying = num(i.underlying)
  const strike = num(i.strike)
  const premium = num(i.premium)
  const contracts = Math.max(0, Math.floor(num(i.contracts)))
  const multiplier = num(i.multiplier) || 100
  const costPerContract = premium * multiplier
  const costBasis = costPerContract * contracts
  const breakeven = optionType === 'call' ? strike + premium : Math.max(0, strike - premium)
  const moveToBreakevenPct = underlying > 0 ? ((breakeven - underlying) / underlying) * 100 : 0
  const intrinsic = optionType === 'call' ? Math.max(0, underlying - strike) : Math.max(0, strike - underlying)
  const extrinsic = Math.max(0, premium - intrinsic)
  let riskBudget: number | null = null
  let maxContractsForRisk: number | null = null
  if (i.account != null && i.riskPercent != null) {
    riskBudget = (num(i.account) * num(i.riskPercent)) / 100
    maxContractsForRisk = costPerContract > 0 ? Math.floor(riskBudget / costPerContract) : 0
  }
  return {
    ok: premium > 0 && strike > 0,
    optionType,
    costPerContract,
    costBasis,
    breakeven,
    moveToBreakevenPct,
    intrinsic,
    extrinsic,
    riskBudget,
    maxContractsForRisk
  }
}

/* --------------------------- expectancy / kelly -------------------------- */

export interface ExpectancyInput {
  winRate: number
  avgWin: number
  avgLoss: number
}
export interface ExpectancyResult {
  ok: boolean
  expectancy: number
  payoffRatio: number
  profitFactor: number
  kelly: number
  halfKelly: number
}

export function expectancy(i: ExpectancyInput): ExpectancyResult {
  const w = clamp(num(i.winRate), 0, 100) / 100
  const avgWin = Math.abs(num(i.avgWin))
  const avgLoss = Math.abs(num(i.avgLoss))
  const lossRate = 1 - w
  const exp = w * avgWin - lossRate * avgLoss
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : 0
  const denom = lossRate * avgLoss
  const profitFactor = denom > 0 ? (w * avgWin) / denom : w * avgWin > 0 ? Infinity : 0
  const kelly = payoffRatio > 0 ? Math.max(0, w - lossRate / payoffRatio) : 0
  return { ok: avgWin > 0 && avgLoss > 0, expectancy: exp, payoffRatio, profitFactor, kelly, halfKelly: kelly / 2 }
}
