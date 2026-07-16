import type { ShellSettings } from '@shared/types'
import { modules, type RegisteredModule } from './registry'

type Overrides = ShellSettings['moduleOverrides']

/** Display name, honoring the user's per-module override. */
export function effectiveName(m: RegisteredModule, overrides: Overrides): string {
  return overrides[m.manifest.id]?.name?.trim() || m.manifest.name
}

/** Short description, honoring the user's per-module override. */
export function effectiveDescription(m: RegisteredModule, overrides: Overrides): string {
  return overrides[m.manifest.id]?.description?.trim() || m.manifest.description
}

/**
 * All modules in the user's saved order. Ids not present in `order` are
 * appended, sorted by their effective name. Ordering covers every module
 * (including hidden ones) so toggling visibility never loses the arrangement.
 */
export function orderedModules(order: string[], overrides: Overrides): RegisteredModule[] {
  const index = new Map(order.map((id, i) => [id, i] as const))
  return [...modules].sort((a, b) => {
    const ai = index.get(a.manifest.id) ?? Number.POSITIVE_INFINITY
    const bi = index.get(b.manifest.id) ?? Number.POSITIVE_INFINITY
    if (ai !== bi) return ai - bi
    return effectiveName(a, overrides).localeCompare(effectiveName(b, overrides))
  })
}

/** Move `draggedId` to sit immediately before `targetId` in the id list. */
export function reorderIds(ids: string[], draggedId: string, targetId: string): string[] {
  if (draggedId === targetId) return ids
  const without = ids.filter((x) => x !== draggedId)
  const ti = without.indexOf(targetId)
  if (ti === -1) return ids
  without.splice(ti, 0, draggedId)
  return without
}
