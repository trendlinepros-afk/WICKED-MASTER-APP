import { useEffect, useState } from 'react'
import { AppWindow, Cpu } from 'lucide-react'
import type { AppMeta } from '../lib/compute'
import { inv } from './format'

const cache = new Map<string, string | null>()
const waiting = new Map<string, Promise<string | null>>()

function load(path: string): Promise<string | null> {
  if (cache.has(path)) return Promise.resolve(cache.get(path)!)
  let p = waiting.get(path)
  if (!p) {
    p = inv<string | null>('icon', path)
      .catch(() => null)
      .then((u) => {
        cache.set(path, u)
        waiting.delete(path)
        return u
      })
    waiting.set(path, p)
  }
  return p
}

/** the exe's own icon (Windows shell), else a generic one */
export function AppIcon({ k, meta, size = 16 }: { k: string; meta?: AppMeta; size?: number }): React.JSX.Element {
  const path = meta?.path ?? ''
  const [url, setUrl] = useState<string | null>(path ? (cache.get(path) ?? null) : null)
  useEffect(() => {
    let live = true
    if (path) void load(path).then((u) => live && setUrl(u))
    else setUrl(null)
    return () => {
      live = false
    }
  }, [path])
  if (url) return <img src={url} width={size} height={size} className="shrink-0" alt="" />
  const Sys = !path || ['system', 'registry', 'memory compression', 'secure system'].includes(k) ? Cpu : AppWindow
  return <Sys size={size} className="shrink-0 text-muted" />
}
