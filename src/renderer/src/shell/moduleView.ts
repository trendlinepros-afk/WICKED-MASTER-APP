import type { CSSProperties } from 'react'
import type { CardSize, ModuleGroup, ShellSettings } from '@shared/types'
import { modules, type RegisteredModule } from './registry'

type Overrides = ShellSettings['moduleOverrides']

/* ------------------------------ card colors ------------------------------ *
 * Ten stark, easy-to-tell-apart accent colors a user can paint an app tile
 * with (pencil-edit → Color). Deliberately NO yellow/orange — that reads as a
 * folder. Values are hex so tiles can tint with an alpha suffix (e.g. `${c}22`).
 * ------------------------------------------------------------------------- */
export const CARD_COLORS: { name: string; value: string }[] = [
  { name: 'Red', value: '#ef4444' },
  { name: 'Pink', value: '#ec4899' },
  { name: 'Magenta', value: '#d946ef' },
  { name: 'Purple', value: '#a855f7' },
  { name: 'Indigo', value: '#6366f1' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Cyan', value: '#06b6d4' },
  { name: 'Teal', value: '#14b8a6' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Slate', value: '#64748b' }
]

/** The user's chosen accent hex for a tile, or undefined for the default look. */
export function moduleColor(id: string, overrides: Overrides): string | undefined {
  return overrides[id]?.color || undefined
}

/* ------------------------------- card sizes ------------------------------ *
 * Four preset tile sizes chosen in Settings → Appearance. `min` drives the
 * responsive grid column width; the rest scale the tile's internals. Every
 * class string is a literal so Tailwind's JIT keeps it.
 * ------------------------------------------------------------------------- */
export interface CardSizeSpec {
  label: string
  /** minimum grid column width in px (repeat(auto-fill, minmax(min,1fr))) */
  min: number
  /** grid gap class */
  gap: string
  /** tile padding class */
  pad: string
  /** icon-chip size class (h/w) */
  chip: string
  /** lucide icon pixel size */
  icon: number
  /** inner header gap class */
  inner: string
  /** app-name text size class */
  name: string
}

export const CARD_SIZES: Record<CardSize, CardSizeSpec> = {
  sm: { label: 'Small', min: 180, gap: 'gap-3', pad: 'p-4', chip: 'h-9 w-9', icon: 18, inner: 'gap-2.5', name: 'text-sm' },
  md: { label: 'Medium', min: 240, gap: 'gap-4', pad: 'p-5', chip: 'h-10 w-10', icon: 20, inner: 'gap-3', name: 'text-base' },
  lg: { label: 'Large', min: 300, gap: 'gap-5', pad: 'p-6', chip: 'h-12 w-12', icon: 24, inner: 'gap-3.5', name: 'text-lg' },
  xl: { label: 'Extra large', min: 360, gap: 'gap-5', pad: 'p-7', chip: 'h-14 w-14', icon: 28, inner: 'gap-4', name: 'text-xl' }
}

export function cardSpec(size: CardSize | undefined): CardSizeSpec {
  return CARD_SIZES[size ?? 'md'] ?? CARD_SIZES.md
}

/** Inline grid-template for a tile grid at the given size. */
export function cardGridStyle(size: CardSize | undefined): CSSProperties {
  return { gridTemplateColumns: `repeat(auto-fill, minmax(${cardSpec(size).min}px, 1fr))` }
}

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
  | 'moduleOrder'
  | 'moduleOverrides'
  | 'disabledModules'
  | 'navHiddenModules'
  | 'navHiddenGroups'
  | 'customGroups'
  | 'moduleGroupOverrides'
  | 'groupOverrides'
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

/**
 * Visible members of a folder, in the user's order (direct tools only). A tool
 * whose assigned folder no longer exists resolves to the top level ('') so it
 * never vanishes from the home screen.
 */
export function groupModules(groupId: string, s: GroupSettings): RegisteredModule[] {
  return orderedModules(s.moduleOrder, s.moduleOverrides).filter((m) => {
    if (s.disabledModules.includes(m.manifest.id)) return false
    const gid = effectiveGroupId(m, s)
    const resolved = gid && groupById(gid, s) ? gid : ''
    return resolved === groupId
  })
}

/* -------------------------------- nesting -------------------------------- *
 * User-created folders may live inside another folder (ModuleGroup.parent).
 * Home and the folder screen render each scope the same way: sub-folders on
 * top under a "Folders" heading, then the scope's own tools under "Misc Tools".
 * Shipped (manifest) folders never nest, so they're always top-level.
 * ------------------------------------------------------------------------- */

/** A folder's parent id, or '' for top level. Guards against dangling refs. */
export function groupParentId(groupId: string, s: GroupSettings): string {
  const g = groupById(groupId, s)
  const p = g?.parent
  return p && groupById(p, s) ? p : ''
}

/** Walk up to the top-most ancestor folder id (cycle-safe). */
export function topAncestorId(groupId: string, s: GroupSettings): string {
  let cur = groupId
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const p = groupParentId(cur, s)
    if (!p) break
    cur = p
  }
  return cur
}

/** Folders whose parent is `parentId` ('' = top level), sorted by name. */
export function childGroups(parentId: string, s: GroupSettings): ModuleGroup[] {
  return allGroups(s).filter((g) => groupParentId(g.id, s) === parentId)
}

/** Total visible tools inside a folder, counting every sub-folder (cycle-safe). */
export function folderToolCount(groupId: string, s: GroupSettings, seen = new Set<string>()): number {
  if (seen.has(groupId)) return 0
  seen.add(groupId)
  let n = groupModules(groupId, s).length
  for (const c of childGroups(groupId, s)) n += folderToolCount(c.id, s, seen)
  return n
}

/** Every folder nested (at any depth) under `groupId` (cycle-safe). */
export function descendantGroupIds(groupId: string, s: GroupSettings, acc = new Set<string>()): Set<string> {
  for (const c of childGroups(groupId, s)) {
    if (!acc.has(c.id)) {
      acc.add(c.id)
      descendantGroupIds(c.id, s, acc)
    }
  }
  return acc
}

/** Breadcrumb trail from the top-most ancestor down to `groupId` (cycle-safe). */
export function groupPath(groupId: string, s: GroupSettings): ModuleGroup[] {
  const path: ModuleGroup[] = []
  let cur = groupId
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const g = groupById(cur, s)
    if (!g) break
    path.unshift(g)
    cur = groupParentId(cur, s)
  }
  return path
}

/** A sub-folder tile's data for a scope's "Folders" section. */
export interface ScopeFolder {
  group: ModuleGroup
  custom: boolean
  /** tools inside, counting sub-folders */
  toolCount: number
  /** direct sub-folder count */
  folderCount: number
}

/**
 * The two sections shown for one scope: `parentId === ''` is the home screen,
 * otherwise it's the inside of a folder. `folders` are the child folders (top),
 * `modules` are the scope's own tools (the "Misc Tools" section, below).
 */
export function scopeSections(
  parentId: string,
  s: GroupSettings
): { folders: ScopeFolder[]; modules: RegisteredModule[] } {
  const customIds = new Set(s.customGroups.map((g) => g.id))
  const folders: ScopeFolder[] = childGroups(parentId, s).map((g) => ({
    group: g,
    custom: customIds.has(g.id),
    toolCount: folderToolCount(g.id, s),
    folderCount: childGroups(g.id, s).length
  }))
  return { folders, modules: groupModules(parentId, s) }
}

/**
 * Collapse the ordered module list into nav entries: a module in a folder is
 * folded into that folder's single entry, which takes the position of its
 * highest-ordered member (so drag-ordering keeps working). A shipped folder
 * with no visible members disappears; a user-created folder always shows (so a
 * freshly made, still-empty folder doesn't vanish).
 *
 * `sidebar: true` additionally drops modules the user hid from the left menu
 * (navHiddenModules) — those still appear on the home screen.
 */
export function navEntries(s: GroupSettings, opts: { sidebar?: boolean } = {}): NavEntry[] {
  const navHidden = opts.sidebar ? (s.navHiddenModules ?? []) : []
  const hiddenGroups = opts.sidebar ? (s.navHiddenGroups ?? []) : []
  const visible = orderedModules(s.moduleOrder, s.moduleOverrides).filter(
    (m) => !s.disabledModules.includes(m.manifest.id) && !navHidden.includes(m.manifest.id)
  )
  const entries: NavEntry[] = []
  const seenGroups = new Set<string>()
  const customIds = new Set(s.customGroups.map((g) => g.id))
  // A group entry lists only its DIRECT tools; nested folders are reached by
  // opening the folder. Modules inside a sub-folder surface their top-level
  // ancestor here so the ancestor still appears in the nav / home grid.
  const directMembers = (gid: string): RegisteredModule[] =>
    visible.filter((x) => effectiveGroupId(x, s) === gid)

  for (const m of visible) {
    const gid = effectiveGroupId(m, s)
    if (!gid) {
      entries.push({ kind: 'module', module: m })
      continue
    }
    if (!groupById(gid, s)) {
      // assignment points at a folder that no longer exists — show top-level
      entries.push({ kind: 'module', module: m })
      continue
    }
    const topId = topAncestorId(gid, s)
    if (seenGroups.has(topId)) continue // already emitted at its first member
    if (hiddenGroups.includes(topId)) {
      // folder hidden from the sidebar (still on the home screen)
      seenGroups.add(topId)
      continue
    }
    const top = groupById(topId, s)
    if (!top) {
      entries.push({ kind: 'module', module: m })
      continue
    }
    seenGroups.add(topId)
    entries.push({ kind: 'group', group: top, modules: directMembers(topId), custom: customIds.has(topId) })
  }

  // empty top-level user-created folders still belong on screen
  for (const g of s.customGroups) {
    if (g.parent && groupById(g.parent, s)) continue // nested — shown inside its parent
    if (seenGroups.has(g.id) || hiddenGroups.includes(g.id)) continue
    entries.push({ kind: 'group', group: withOverrides(g, s), modules: [], custom: true })
  }
  return entries
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
 * insertion point (a module id, or a folder token = that folder's member block).
 * `after` drops the dragged tile *after* the target instead of before it, so the
 * natural "drag right/down past a tile" gesture works and the very last slot is
 * reachable. Returns the new moduleOrder, or null when the drop is a no-op
 * (self-drop, empty folder, anchor inside the dragged block, or no change).
 */
export function reorderNav(
  s: GroupSettings,
  dragToken: string,
  targetToken: string,
  after = false
): string[] | null {
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

  // A folder target moves as a member block: anchor before its first member, or
  // (when dropping past it) after its last, so a whole folder can be stepped over.
  const targetMembers = isGroupDrag(targetToken)
    ? membersOf(targetToken.slice(GROUP_DRAG_PREFIX.length))
    : [targetToken]
  const anchor = after ? targetMembers[targetMembers.length - 1] : targetMembers[0]
  if (!anchor || block.includes(anchor)) return null

  const without = ids.filter((id) => !block.includes(id))
  const ti = without.indexOf(anchor)
  if (ti === -1) return null
  without.splice(after ? ti + 1 : ti, 0, ...block)
  // Signal a no-op (e.g. dropping just before the tile it already precedes) so
  // callers can skip a pointless write.
  return without.length === ids.length && without.every((id, i) => id === ids[i]) ? null : without
}
