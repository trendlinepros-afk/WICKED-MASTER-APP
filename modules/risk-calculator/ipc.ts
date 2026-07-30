import { join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import {
  positionSize,
  riskReward,
  optionCalc,
  expectancy,
  type PositionSizeInput,
  type RiskRewardInput,
  type OptionInput,
  type ExpectancyInput
} from './calc'

/**
 * Risk Calculator — pure math. The UI computes locally for instant feedback; the
 * same functions are exposed on IPC so the MCP tools (and the AI Advisor) get
 * identical numbers. `get`/`set` just persist the last-used inputs.
 */
const ID = 'risk-calculator'
const KEY = `${ID}.state`

const asObj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})

export default function register(ctx: ModuleIpcContext): void {
  ctx.ipcMain.handle(`${ID}:get`, () => ({ ok: true, state: ctx.storeGet<Record<string, unknown>>(KEY, {}) }))

  ctx.ipcMain.handle(`${ID}:set`, (_e, state: unknown) => {
    ctx.storeSet(KEY, asObj(state))
    return { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:position-size`, (_e, raw: unknown) => positionSize(asObj(raw) as unknown as PositionSizeInput))
  ctx.ipcMain.handle(`${ID}:risk-reward`, (_e, raw: unknown) => riskReward(asObj(raw) as unknown as RiskRewardInput))
  ctx.ipcMain.handle(`${ID}:option`, (_e, raw: unknown) => optionCalc(asObj(raw) as unknown as OptionInput))
  ctx.ipcMain.handle(`${ID}:expectancy`, (_e, raw: unknown) => expectancy(asObj(raw) as unknown as ExpectancyInput))

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => {
    let base = ''
    try {
      base = ctx.app.getPath('userData')
    } catch {
      /* not available */
    }
    return [
      {
        label: 'Saved inputs',
        path: base ? join(base, 'wicked-modules.json') : null,
        note: 'Your last-used values under the "risk-calculator.state" key. Included in Backup & Cloud Sync.'
      }
    ]
  })
}
