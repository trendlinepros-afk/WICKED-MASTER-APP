import type { VersionInfo } from '../types'

/** Group versions into chains (a full + its incrementals), oldest chain first, oldest version first. */
export function chainsFrom(versions: VersionInfo[]): VersionInfo[][] {
  const byBase = new Map<string, VersionInfo[]>()
  for (const v of [...versions].sort((a, b) => a.createdAt - b.createdAt)) {
    const list = byBase.get(v.base) ?? []
    list.push(v)
    byBase.set(v.base, list)
  }
  return [...byBase.values()].sort((a, b) => a[0].createdAt - b[0].createdAt)
}
