import type { ModuleGroup, ShellSettings } from '@shared/types'
import { modules, type RegisteredModule } from './registry'

type Overrides = ShellSettings['moduleOverrides']

/** kebab-case, collision-free id for a new user folder. */
export function makeGroupId(name: string, taken: string[]): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'folder'
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`
}

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
  | { kind: 'group'; group: ModuleGroup; modules: RegisteredModule[]; custom: boolean }

/** Minimal settings slice the grouping helpers need. */
export type GroupSettings = Pick<
  ShellSettings,
  'moduleOrder' | 'moduleOverrides' | 'disabledModules' | 'customGroups' | 'moduleGroupOverrides' | 'groupOverrides'
>

/**
 * Which folder a module is actually in: the user's assignment wins over the
 * manifest's shipped `group` ('' = deliberately pulled out to the top level).
 */
export function effectiveGroupId(m: RegisteredModule, s: GroupSettings): string {
  const override = s.moduleGroupOverrides[m.manifest.id]
  if (override !== undefined) return override
  return m.manifest.group?.id ?? ''
}

/** Apply the user's rename/re-icon to a folder. */
function withOverrides(g: ModuleGroup, s: GroupSettings): ModuleGroup {
  const o = s.groupOverrides[g.id]
  if (!o) return g
  return {
    ...g,
    name: o.name?.trim() || g.name,
    icon: o.icon?.trim() || g.icon,
    description: o.description?.trim() || g.description
  }
}

/** Resolve a folder by id — user-created first, then any manifest declaration. */
export function groupById(id: string, s: GroupSettings): ModuleGroup | undefined {
  if (!id) return undefined
  const custom = s.customGroups.find((g) => g.id === id)
  if (custom) return withOverrides(custom, s)
  for (const m of modules) if (m.manifest.group?.id === id) return withOverrides(m.manifest.group, s)
  return undefined
}

/** Every folder that exists: user-created + declared by any installed module. */
export function allGroups(s: GroupSettings): ModuleGroup[] {
  const out = new Map<string, ModuleGroup>()
  for (const m of modules) {
    const g = m.manifest.group
    if (g && !out.has(g.id)) out.set(g.id, withOverrides(g, s))
  }
  for (const g of s.customGroups) out.set(g.id, withOverrides(g, s)) // user wins
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Visible members of a folder, in the user's order. */
export function groupModules(groupId: string, s: GroupSettings): RegisteredModule[] {
  return orderedModules(s.moduleOrder, s.moduleOverrides).filter(
    (m) => effectiveGroupId(m, s) === groupId && !s.disabledModules.includes(m.manifest.id)
  )
}

/**
 * Collapse the ordered module list into nav entries: a module in a folder is
 * folded into that folder's single entry, which takes the position of its
 * highest-ordered member (so drag-ordering keeps working). A shipped folder
 * with no visible members disappears; a user-created folder always shows (so a
 * freshly made, still-empty folder doesn't vanish).
 */
export function navEntries(s: GroupSettings): NavEntry[] {
  const visible = orderedModules(s.moduleOrder, s.moduleOverrides).filter(
    (m) => !s.disabledModules.includes(m.manifest.id)
  )
  const entries: NavEntry[] = []
  const seenGroups = new Set<string>()
  const customIds = new Set(s.customGroups.map((g) => g.id))

  for (const m of visible) {
    const gid = effectiveGroupId(m, s)
    if (!gid) {
      entries.push({ kind: 'module', module: m })
      continue
    }
    if (seenGroups.has(gid)) continue // already emitted at its first member
    const group = groupById(gid, s)
    if (!group) {
      // assignment points at a folder that no longer exists — show top-level
      entries.push({ kind: 'module', module: m })
      continue
    }
    seenGroups.add(gid)
    entries.push({
      kind: 'group',
      group,
      modules: visible.filter((x) => effectiveGroupId(x, s) === gid),
      custom: customIds.has(gid)
    })
  }

  // empty user-created folders still belong on screen
  for (const g of s.customGroups) {
    if (seenGroups.has(g.id)) continue
    entries.push({ kind: 'group', group: withOverrides(g, s), modules: [], custom: true })
  }
  return entries
}

/** Move `draggedId` to sit immediately before `targetId` in the id list. */
export function reorderIds(ids: string[], draggedId: string, targetId: string): string[] {
  if (draggedId === targetId || !ids.includes(draggedId)) return ids
  const without = ids.filter((x) => x !== draggedId)
  const ti = without.indexOf(targetId)
  if (ti === -1) return ids
  without.splice(ti, 0, draggedId)
  return without
}

/* --------------------------- drag & drop tokens ---------------------------- *
 * A drag carries either a bare module id or `group:<groupId>` for a whole
 * folder. Dragging a folder moves ALL its members as one block, so the folder
 * tile (anchored at its first member) lands where you drop it.
 * --------------------------------------------------------------------------- */

export const GROUP_DRAG_PREFIX = 'group:'

export function groupDragToken(groupId: string): string {
  return `${GROUP_DRAG_PREFIX}${groupId}`
}

export function isGroupDrag(token: string | null): boolean {
  return !!token && token.startsWith(GROUP_DRAG_PREFIX)
}

/**
 * Token-aware reorder for the Home grid / nav. The target token anchors the
 * insertion point (a module id, or a folder token = before that folder's first
 * member). Returns the new moduleOrder, or null when the drop is a no-op
 * (self-drop, empty folder, anchor inside the dragged block…).
 */
export function reorderNav(s: GroupSettings, dragToken: string, targetToken: string): string[] | null {
  if (dragToken === targetToken) return null
  const ordered = orderedModules(s.moduleOrder, s.moduleOverrides)
  const ids = ordered.map((m) => m.manifest.id)
  const byId = new Map(ordered.map((m) => [m.manifest.id, m] as const))
  const membersOf = (gid: string): string[] =>
    ids.filter((id) => {
      const m = byId.get(id)
      return !!m && effectiveGroupId(m, s) === gid
    })

  const block = isGroupDrag(dragToken)
    ? membersOf(dragToken.slice(GROUP_DRAG_PREFIX.length))
    : ids.includes(dragToken)
      ? [dragToken]
      : []
  if (block.length === 0) return null

  const anchor = isGroupDrag(targetToken)
    ? membersOf(targetToken.slice(GROUP_DRAG_PREFIX.length))[0]
    : targetToken
  if (!anchor || block.includes(anchor)) return null

  const without = ids.filter((id) => !block.includes(id))
  const ti = without.indexOf(anchor)
  if (ti === -1) return null
  without.splice(ti, 0, ...block)
  return without
}
