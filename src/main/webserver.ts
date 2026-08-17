import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import type { Server } from 'node:http'
import { readFileSync } from 'fs'
import { join } from 'path'
import { networkInterfaces } from 'os'
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'crypto'
import { promisify } from 'util'
import { ipcMain } from 'electron'
import Store from 'electron-store'
import { SHELL_IPC, type WebServerStatus } from '@shared/types'
import { invokeChannel } from './mcp/channel-registry'

/**
 * WEB SERVER — optional LAN remote access to the WHOLE app (Settings → Web
 * Server, OFF by default). When on, an Express host bound to 0.0.0.0 serves the
 * built renderer to any browser on the network, password-gated. A browser has
 * no Electron IPC, so a small injected bridge (`window.wicked`) forwards every
 * `invoke` over POST and receives `on` events over Server-Sent Events; main
 * mirrors the desktop window's `webContents.send` traffic to those clients.
 *
 * SECURITY: this is deliberate full remote control — a browser session can call
 * every IPC channel the desktop app can, so it can run the same file/OS actions.
 * Config + a scrypt hash of the password live in a DEVICE-LOCAL store that is
 * NOT in the backup/sync include-list, so nothing here ever travels off the PC.
 */

const DEFAULT_PORT = 8420
const SESSION_COOKIE = 'wk_session'

interface WebServerConfig {
  enabled: boolean
  port: number
  passSalt?: string
  passHash?: string
}

const store = new Store<WebServerConfig>({
  name: 'wicked-webserver',
  defaults: { enabled: false, port: DEFAULT_PORT }
})

let server: Server | null = null
let lastError = ''

/** Valid session tokens → issued-at ms. In memory only (restart = re-login);
 *  tokens also expire after 24h so an abandoned browser can't stay in forever. */
const sessions = new Map<string, number>()
const SESSION_TTL_MS = 24 * 3_600_000
/** Connected SSE response streams that mirror desktop events to the browser. */
const eventClients = new Set<Response>()
/** Per-IP failed-login backoff: ip → { fails, lockedUntil }. */
const loginFails = new Map<string, { fails: number; until: number }>()
let loginInFlight = false

/* --------------------------------- password ------------------------------- */

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const scryptAsync = promisify(scrypt) as (
  password: Buffer,
  salt: Buffer,
  keylen: number,
  options: typeof SCRYPT_OPTS
) => Promise<Buffer>

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(Buffer.from(password, 'utf8'), salt, 32, SCRYPT_OPTS)
}

function setWebServerPassword(password: string): { ok: boolean; error?: string } {
  const p = (password ?? '').trim()
  if (p.length < 4) return { ok: false, error: 'Use a password of at least 4 characters.' }
  const salt = randomBytes(16)
  store.set('passSalt', salt.toString('base64'))
  store.set('passHash', hashPassword(p, salt).toString('base64'))
  // changing the password must lock out anyone signed in under the old one
  sessions.clear()
  return { ok: true }
}

function hasPassword(): boolean {
  return !!store.get('passHash') && !!store.get('passSalt')
}

/** Async so the ~100ms scrypt runs on libuv's pool, not the main thread —
 *  an unauthenticated LAN loop must not be able to freeze the desktop app. */
async function verifyPasswordAsync(password: string): Promise<boolean> {
  const saltB64 = store.get('passSalt')
  const hashB64 = store.get('passHash')
  if (!saltB64 || !hashB64) return false
  try {
    const expected = Buffer.from(hashB64, 'base64')
    const actual = await scryptAsync(Buffer.from(String(password ?? ''), 'utf8'), Buffer.from(saltB64, 'base64'), 32, SCRYPT_OPTS)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

/* ------------------------------ event mirroring --------------------------- */

/** Called by index.ts for every mainWindow.webContents.send — fanned out to SSE. */
export function broadcastToWeb(channel: string, args: unknown[]): void {
  if (eventClients.size === 0) return
  let payload: string
  try {
    payload = JSON.stringify({ channel, args })
  } catch {
    return // non-serializable event — skip (desktop still got it)
  }
  const line = `data: ${payload}\n\n`
  for (const res of eventClients) {
    try {
      res.write(line)
    } catch {
      /* client gone; cleaned up on its own 'close' */
    }
  }
}

/* -------------------------------- lan urls -------------------------------- */

function lanUrls(port: number): string[] {
  const out: string[] = []
  try {
    const ifaces = networkInterfaces()
    for (const list of Object.values(ifaces)) {
      for (const ni of list ?? []) {
        if (ni.family === 'IPv4' && !ni.internal) out.push(`http://${ni.address}:${port}`)
      }
    }
  } catch {
    /* ignore */
  }
  return out
}

/* ------------------------------- the bridge ------------------------------- */

/** The browser-side `window.wicked` shim (classic script; runs before the app). */
const BRIDGE_JS = `(function(){
  var listeners = new Map();
  function connect(){
    try {
      var es = new EventSource('/__wicked/events');
      es.onmessage = function(e){
        try {
          var m = JSON.parse(e.data);
          var set = listeners.get(m.channel);
          if (set) set.forEach(function(fn){ try { fn.apply(null, m.args || []); } catch(_){} });
        } catch(_){}
      };
      es.onerror = function(){ /* EventSource auto-reconnects */ };
    } catch(_){ setTimeout(connect, 2000); }
  }
  connect();
  window.wicked = {
    invoke: function(channel){
      var args = Array.prototype.slice.call(arguments, 1);
      return fetch('/__wicked/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: channel, args: args })
      }).then(function(r){
        if (r.status === 401) { window.location.href = '/login'; return; }
        return r.json();
      }).then(function(j){
        if (!j) return;
        if (!j.ok) throw new Error(j.error || 'Request failed');
        return j.result;
      });
    },
    on: function(channel, listener){
      var set = listeners.get(channel);
      if (!set) { set = new Set(); listeners.set(channel, set); }
      set.add(listener);
      return function(){ set.delete(listener); };
    },
    getPathForFile: function(){ return ''; }
  };
})();`

const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WICKED — Sign in</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
    background:#111318; color:#e6e9ef; font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .card { width:min(360px,90vw); background:#171a21; border:1px solid #2a2f3a; border-radius:16px; padding:28px; }
  h1 { margin:0 0 4px; font-size:20px; }
  p { margin:0 0 20px; color:#9aa3b2; font-size:13px; }
  input { width:100%; box-sizing:border-box; padding:11px 12px; border-radius:10px; border:1px solid #2a2f3a;
    background:#0d0f14; color:#e6e9ef; font-size:15px; outline:none; }
  input:focus { border-color:#e11d48; }
  button { margin-top:12px; width:100%; padding:11px; border:none; border-radius:10px; background:#e11d48;
    color:#fff; font-size:15px; font-weight:600; cursor:pointer; }
  .err { margin-top:12px; color:#f87171; font-size:13px; min-height:18px; }
</style></head><body>
  <form class="card" onsubmit="return doLogin(event)">
    <h1>WICKED</h1>
    <p>Enter the web-server password to continue.</p>
    <input id="pw" type="password" placeholder="Password" autofocus autocomplete="current-password">
    <button type="submit">Unlock</button>
    <div class="err" id="err"></div>
  </form>
  <script>
    function doLogin(e){
      e.preventDefault();
      var pw = document.getElementById('pw').value;
      fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ password: pw }) })
        .then(function(r){ return r.json(); })
        .then(function(j){
          if (j && j.ok) { window.location.href = '/'; }
          else { document.getElementById('err').textContent = (j && j.error) || 'Wrong password.'; }
        })
        .catch(function(){ document.getElementById('err').textContent = 'Could not reach the server.'; });
      return false;
    }
  </script>
</body></html>`

/** Absolute path to the built renderer directory (packaged + dev-preview). */
function rendererDir(): string {
  return join(__dirname, '../renderer')
}

/**
 * Read index.html and inject the bridge as an EXTERNAL same-origin script (the
 * renderer's CSP is `script-src 'self'`, which forbids inline scripts). A
 * classic (non-module) script in <head> runs before the app's deferred module.
 */
function servedIndexHtml(): string {
  const html = readFileSync(join(rendererDir(), 'index.html'), 'utf8')
  const inject = `<script src="/__wicked/bridge.js"></script>`
  return html.includes('</head>') ? html.replace('</head>', `${inject}</head>`) : inject + html
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) {
      const v = part.slice(i + 1).trim()
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(v)
      } catch {
        out[part.slice(0, i).trim()] = v // malformed %-escape → raw (still just fails auth)
      }
    }
  }
  return out
}

function isAuthed(req: Request): boolean {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (!token) return false
  const issued = sessions.get(token)
  if (issued == null) return false
  if (Date.now() - issued > SESSION_TTL_MS) {
    sessions.delete(token)
    return false
  }
  return true
}

function buildApp(): Express {
  const web = express()
  web.use(express.json({ limit: '25mb' }))

  // ---- login (unauthenticated → single-flight + per-IP backoff) ----
  web.get('/login', (_req, res) => res.type('html').send(LOGIN_HTML))
  web.post('/api/login', async (req, res) => {
    const password = (req.body && typeof req.body.password === 'string' ? req.body.password : '') as string
    if (!hasPassword()) return res.status(400).json({ ok: false, error: 'No password is set on the server.' })
    const ip = req.socket.remoteAddress ?? 'unknown'
    const rec = loginFails.get(ip)
    if (rec && rec.until > Date.now())
      return res.status(429).json({ ok: false, error: 'Too many attempts — wait 30 seconds.' })
    if (loginInFlight) return res.status(429).json({ ok: false, error: 'Busy — try again.' })
    loginInFlight = true
    let good = false
    try {
      good = await verifyPasswordAsync(password)
    } finally {
      loginInFlight = false
    }
    if (!good) {
      const fails = (rec?.fails ?? 0) + 1
      loginFails.set(ip, { fails, until: fails >= 5 ? Date.now() + 30_000 : 0 })
      return res.status(401).json({ ok: false, error: 'Wrong password.' })
    }
    loginFails.delete(ip)
    const token = randomBytes(24).toString('hex')
    sessions.set(token, Date.now())
    // Session cookie (no Max-Age) → cleared when the browser closes, so each new
    // visit re-prompts. httpOnly + SameSite=Lax; not Secure (plain-HTTP LAN).
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/`)
    return res.json({ ok: true })
  })
  web.post('/api/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (token) sessions.delete(token)
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
    return res.json({ ok: true })
  })

  // ---- auth gate for everything below ----
  const gate = (req: Request, res: Response, next: NextFunction): void => {
    if (isAuthed(req)) return next()
    if (req.path.startsWith('/__wicked/')) {
      res.status(401).json({ ok: false, error: 'Not authenticated.' })
      return
    }
    res.redirect('/login')
  }

  // ---- remote IPC bridge (authed) ----
  web.post('/__wicked/invoke', gate, async (req, res) => {
    const channel = req.body && typeof req.body.channel === 'string' ? req.body.channel : ''
    const args = req.body && Array.isArray(req.body.args) ? req.body.args : []
    if (!channel) {
      res.status(400).json({ ok: false, error: 'channel is required.' })
      return
    }
    try {
      const result = await invokeChannel(channel, ...args)
      res.json({ ok: true, result })
    } catch (err) {
      res.json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // The browser `window.wicked` shim (served as a file to satisfy `script-src 'self'`).
  web.get('/__wicked/bridge.js', gate, (_req, res) => {
    res.type('application/javascript').send(BRIDGE_JS)
  })

  web.get('/__wicked/events', gate, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    res.write(': connected\n\n')
    eventClients.add(res)
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        /* ignore */
      }
    }, 25_000)
    req.on('close', () => {
      clearInterval(ping)
      eventClients.delete(res)
    })
  })

  // ---- the app itself (authed) ----
  // index.html carries the injected bridge; assets are served statically; any
  // other path is an SPA route → serve index.html so client routing works.
  web.get(['/', '/index.html'], gate, (_req, res) => res.type('html').send(servedIndexHtml()))
  web.use(gate, express.static(rendererDir(), { index: false }))
  web.get('*', gate, (req, res) => {
    if (req.path.includes('.')) {
      res.status(404).end() // a missing real asset, not a route
      return
    }
    res.type('html').send(servedIndexHtml())
  })

  return web
}

/* -------------------------------- lifecycle ------------------------------- */

export function getWebServerStatus(): WebServerStatus {
  const port = store.get('port') || DEFAULT_PORT
  return {
    enabled: store.get('enabled') === true,
    running: server !== null,
    port,
    hasPassword: hasPassword(),
    urls: server ? lanUrls(port) : [],
    error: lastError
  }
}

function startServer(): Promise<WebServerStatus> {
  return new Promise((resolve) => {
    if (server) return resolve(getWebServerStatus())
    if (!hasPassword()) {
      lastError = 'Set a password before starting the web server.'
      return resolve(getWebServerStatus())
    }
    lastError = ''
    sessions.clear() // fresh start → everyone must log in again
    const port = store.get('port') || DEFAULT_PORT
    try {
      const web = buildApp()
      server = web.listen(port, '0.0.0.0', () => {
        console.log(`[webserver] WICKED on http://0.0.0.0:${port} (LAN remote access ON)`)
        resolve(getWebServerStatus())
      })
      server.on('error', (err) => {
        lastError = err instanceof Error ? err.message : String(err)
        console.error('[webserver] listen error', err)
        // an error AFTER a successful listen must not strand an open socket
        // behind a null ref (unstoppable, reported as not-running)
        const s = server
        server = null
        try {
          s?.closeAllConnections()
          s?.close()
        } catch {
          /* already down */
        }
        resolve(getWebServerStatus())
      })
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      server = null
      resolve(getWebServerStatus())
    }
  })
}

function stopServer(): Promise<WebServerStatus> {
  return new Promise((resolve) => {
    sessions.clear()
    for (const res of eventClients) {
      try {
        res.end()
      } catch {
        /* ignore */
      }
    }
    eventClients.clear()
    if (!server) return resolve(getWebServerStatus())
    // Detach first and FORCE-close: server.close() alone waits for in-flight
    // requests (an open SSE stream or a long invoke would keep the "off" toggle
    // pending forever and the status stuck on running).
    const s = server
    server = null
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      console.log('[webserver] stopped')
      resolve(getWebServerStatus())
    }
    try {
      s.close(finish)
      s.closeAllConnections()
    } catch {
      finish()
    }
    setTimeout(finish, 2000) // belt-and-braces: the IPC reply must always come
  })
}

async function setEnabled(value: boolean): Promise<WebServerStatus> {
  store.set('enabled', value === true)
  return value ? startServer() : stopServer()
}

/** Register the web-server IPC + auto-start if it was left enabled last run. */
export function registerWebServerIpc(): void {
  ipcMain.handle(SHELL_IPC.webServerStatus, () => getWebServerStatus())
  ipcMain.handle(SHELL_IPC.webServerSetEnabled, (_e, value: unknown) => setEnabled(value === true))
  ipcMain.handle(SHELL_IPC.webServerSetPassword, (_e, password: unknown) => {
    const res = setWebServerPassword(typeof password === 'string' ? password : '')
    if (!res.ok) {
      lastError = res.error ?? 'Could not set password.'
      return getWebServerStatus()
    }
    lastError = ''
    return getWebServerStatus()
  })
  ipcMain.handle(SHELL_IPC.webServerSetPort, async (_e, raw: unknown) => {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      lastError = 'Port must be between 1024 and 65535.'
      return getWebServerStatus()
    }
    store.set('port', n)
    if (server) {
      await stopServer()
      return startServer()
    }
    return getWebServerStatus()
  })

  if (store.get('enabled') === true && hasPassword()) void startServer()
}

export function stopWebServer(): Promise<WebServerStatus> {
  return stopServer()
}
