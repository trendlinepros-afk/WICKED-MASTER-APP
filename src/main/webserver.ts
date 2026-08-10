import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import type { Server } from 'node:http'
import { readFileSync } from 'fs'
import { join } from 'path'
import { networkInterfaces } from 'os'
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { ipcMain, type BrowserWindow } from 'electron'
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

/** Valid session tokens — in memory only, so an app restart forces re-login. */
const sessions = new Set<string>()
/** Connected SSE response streams that mirror desktop events to the browser. */
const eventClients = new Set<Response>()

/* --------------------------------- password ------------------------------- */

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(Buffer.from(password, 'utf8'), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

export function setWebServerPassword(password: string): { ok: boolean; error?: string } {
  const p = (password ?? '').trim()
  if (p.length < 4) return { ok: false, error: 'Use a password of at least 4 characters.' }
  const salt = randomBytes(16)
  store.set('passSalt', salt.toString('base64'))
  store.set('passHash', hashPassword(p, salt).toString('base64'))
  return { ok: true }
}

function hasPassword(): boolean {
  return !!store.get('passHash') && !!store.get('passSalt')
}

function verifyPassword(password: string): boolean {
  const saltB64 = store.get('passSalt')
  const hashB64 = store.get('passHash')
  if (!saltB64 || !hashB64) return false
  try {
    const expected = Buffer.from(hashB64, 'base64')
    const actual = hashPassword(String(password ?? ''), Buffer.from(saltB64, 'base64'))
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
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function isAuthed(req: Request): boolean {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  return !!token && sessions.has(token)
}

function buildApp(): Express {
  const web = express()
  web.use(express.json({ limit: '25mb' }))

  // ---- login (unauthenticated) ----
  web.get('/login', (_req, res) => res.type('html').send(LOGIN_HTML))
  web.post('/api/login', (req, res) => {
    const password = (req.body && typeof req.body.password === 'string' ? req.body.password : '') as string
    if (!hasPassword()) return res.status(400).json({ ok: false, error: 'No password is set on the server.' })
    if (!verifyPassword(password)) return res.status(401).json({ ok: false, error: 'Wrong password.' })
    const token = randomBytes(24).toString('hex')
    sessions.add(token)
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
        server = null
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
    server.close(() => {
      server = null
      console.log('[webserver] stopped')
      resolve(getWebServerStatus())
    })
  })
}

async function setEnabled(value: boolean): Promise<WebServerStatus> {
  store.set('enabled', value === true)
  return value ? startServer() : stopServer()
}

/** Register the web-server IPC + auto-start if it was left enabled last run. */
export function registerWebServerIpc(_getMainWindow: () => BrowserWindow | null): void {
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

/** True while the LAN server is running (index.ts stops it on quit). */
export function webServerRunning(): boolean {
  return server !== null
}

export function stopWebServer(): Promise<WebServerStatus> {
  return stopServer()
}
