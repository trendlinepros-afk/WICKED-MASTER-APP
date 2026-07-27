import type { ModuleGroup, ShellSettings } from '@shared/types'
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

/* ------------------------------- grouping -------------------------------- *
 * Modules may declare a `group` in their manifest ("folders"). The nav and home
 * screen then show ONE entry for the folder, which opens /g/<groupId> listing
 * its members; each member keeps its own /m/<id> route.
 * ------------------------------------------------------------------------- */

/** One row in the nav / home grid: a lone module, or a folder of modules. */
export type NavEntry =
  | { kind: 'module'; module: RegisteredModule }
  | { kind: 'group'; group: ModuleGroup; modules: RegisteredModule[] }

/** The group declared by any module with this id (first declaration wins). */
export function groupById(id: string): ModuleGroup | undefined {
  for (const m of modules) if (m.manifest.group?.id === id) return m.manifest.group
  return undefined
}

/** Visible members of a group, in the user's order. */
export function groupModules(
  groupId: string,
  order: string[],
  overrides: Overrides,
  disabled: string[] = []
): RegisteredModule[] {
  return orderedModules(order, overrides).filter(
    (m) => m.manifest.group?.id === groupId && !disabled.includes(m.manifest.id)
  )
}

/**
 * Collapse the ordered module list into nav entries: a module that declares a
 * group is folded into that group's single entry, which takes the position of
 * its highest-ordered member (so drag-ordering keeps working). Groups whose
 * every member is hidden disappear entirely.
 */
export function navEntries(
  order: string[],
  overrides: Overrides,
  disabled: string[]
): NavEntry[] {
  const visible = orderedModules(order, overrides).filter(
    (m) => !disabled.includes(m.manifest.id)
  )
  const entries: NavEntry[] = []
  const seenGroups = new Set<string>()
  for (const m of visible) {
    const g = m.manifest.group
    if (!g) {
      entries.push({ kind: 'module', module: m })
      continue
    }
    if (seenGroups.has(g.id)) continue // already emitted at its first member
    seenGroups.add(g.id)
    entries.push({
      kind: 'group',
      group: g,
      modules: visible.filter((x) => x.manifest.group?.id === g.id)
    })
  }
  return entries
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
