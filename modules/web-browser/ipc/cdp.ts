/**
 * Minimal Chrome DevTools Protocol client for the web-browser module.
 *
 * Talks to a real Chrome started with `--remote-debugging-port` (bound to
 * 127.0.0.1 only). Uses Node's built-in WebSocket (undici), which sends NO
 * Origin header — Chrome only rejects debugger connections carrying a
 * *disallowed* Origin, so this connects without weakening security via
 * `--remote-allow-origins` (which would let any website's JS attach too).
 */

export interface CdpTarget {
  id: string
  type: string
  title: string
  url: string
  /** absent while real DevTools is attached to the tab */
  webSocketDebuggerUrl?: string
}

export interface CdpVersion {
  browser: string | null
}

const HTTP_TIMEOUT_MS = 4_000
const CONNECT_TIMEOUT_MS = 6_000
const COMMAND_TIMEOUT_MS = 30_000

/* ------------------------- HTTP endpoints (/json/*) ---------------------- */

async function devtoolsHttp(
  port: number,
  path: string,
  method: 'GET' | 'PUT' = 'GET'
): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: ctrl.signal })
    const text = await resp.text()
    if (!resp.ok) throw new Error(`DevTools ${path} returned ${resp.status}: ${text.slice(0, 200)}`)
    if (!text.trim()) return null
    // /json/activate and /json/close reply with plain text, not JSON
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Resolves iff a debuggable Chrome is listening on the port. */
export async function getVersion(port: number): Promise<CdpVersion> {
  const v = (await devtoolsHttp(port, '/json/version')) as Record<string, unknown> | null
  return { browser: v && typeof v.Browser === 'string' ? v.Browser : null }
}

function normalizeTarget(raw: unknown): CdpTarget | null {
  if (typeof raw !== 'object' || raw === null) return null
  const t = raw as Record<string, unknown>
  if (typeof t.id !== 'string') return null
  return {
    id: t.id,
    type: typeof t.type === 'string' ? t.type : 'other',
    title: typeof t.title === 'string' ? t.title : '',
    url: typeof t.url === 'string' ? t.url : '',
    webSocketDebuggerUrl:
      typeof t.webSocketDebuggerUrl === 'string' ? t.webSocketDebuggerUrl : undefined
  }
}

export async function listTargets(port: number): Promise<CdpTarget[]> {
  const raw = await devtoolsHttp(port, '/json/list')
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeTarget).filter((t): t is CdpTarget => t !== null)
}

export async function openTarget(port: number, url: string): Promise<CdpTarget | null> {
  const path = `/json/new?${encodeURI(url)}`
  try {
    return normalizeTarget(await devtoolsHttp(port, path, 'PUT'))
  } catch {
    // Chrome < 109 accepted only GET here; >= 109 requires PUT
    return normalizeTarget(await devtoolsHttp(port, path, 'GET'))
  }
}

export async function activateTarget(port: number, id: string): Promise<void> {
  await devtoolsHttp(port, `/json/activate/${encodeURIComponent(id)}`)
}

export async function closeTarget(port: number, id: string): Promise<void> {
  await devtoolsHttp(port, `/json/close/${encodeURIComponent(id)}`)
}

/* --------------------- WebSocket command channel ------------------------- */

interface WsEvent {
  data?: unknown
}
interface WsLike {
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (ev: WsEvent) => void): void
}

// tsconfig.node has no DOM lib, so the (runtime-present) global is untyped
function wsConstructor(): new (url: string) => WsLike {
  const ctor = (globalThis as Record<string, unknown>).WebSocket
  if (typeof ctor !== 'function')
    throw new Error('The WebSocket client is not available in this Electron runtime.')
  return ctor as unknown as new (url: string) => WsLike
}

export type CdpSend = (
  method: string,
  params?: Record<string, unknown>
) => Promise<Record<string, unknown>>

/**
 * Open a DevTools websocket to one target, hand `fn` a request/response
 * `send(method, params)` and always close the socket afterwards. Protocol
 * events (messages without an id) are ignored — this client is for one-shot
 * commands, not subscriptions.
 */
export async function withCdp<T>(wsUrl: string, fn: (send: CdpSend) => Promise<T>): Promise<T> {
  const Ws = wsConstructor()
  const ws = new Ws(wsUrl)

  interface Pending {
    resolve: (v: Record<string, unknown>) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
  const pending = new Map<number, Pending>()
  let nextId = 1
  let open = false

  const failAll = (message: string): void => {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(message))
    }
    pending.clear()
  }

  ws.addEventListener('message', (ev) => {
    let msg: { id?: unknown; result?: unknown; error?: { message?: unknown } }
    try {
      msg = JSON.parse(String(ev.data)) as typeof msg
    } catch {
      return
    }
    if (typeof msg.id !== 'number') return
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error)
      p.reject(
        new Error(
          typeof msg.error.message === 'string' ? msg.error.message : 'DevTools command failed.'
        )
      )
    else p.resolve((msg.result ?? {}) as Record<string, unknown>)
  })
  ws.addEventListener('close', () => {
    open = false
    failAll('The DevTools connection closed unexpectedly.')
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out connecting to the Chrome DevTools socket.')),
      CONNECT_TIMEOUT_MS
    )
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      open = true
      resolve()
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('Could not connect to the Chrome DevTools socket.'))
    })
  })

  const send: CdpSend = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (!open) {
        reject(new Error('The DevTools connection is closed.'))
        return
      }
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`DevTools command ${method} timed out.`))
      }, COMMAND_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        clearTimeout(timer)
        pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })

  try {
    return await fn(send)
  } finally {
    try {
      ws.close()
    } catch {
      /* already closed */
    }
  }
}
