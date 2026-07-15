import { app } from 'electron';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import * as db from './db';
import { DESKTOP_ONLY_CHANNELS, RPC_CHANNELS } from '../shared/rpc';
import type { PortalStatus } from '../types';

// The LAN web portal: while WICKED runs, the built renderer is served over
// HTTP(S) so any browser on the local network can use the AI chat against the
// same data. The browser gets /__portal/bridge.js, which recreates
// `window.wicked` by relaying every ai-chat:* invoke to the same handlers the
// desktop renderer uses. Access requires a per-install token carried in the
// portal URL (?token=…) and sent as a header on every data request.
//
// Port notes (WICKED suite):
//  - OFF by default. Starts only when the user enables it in the module's
//    settings (ipc.ts calls sync() after settings saves and once at startup).
//  - Instead of monkey-patching ipcMain.handle, ipc.ts hands over its explicit
//    channel → handler registry, so the portal mirrors exactly the ai-chat:*
//    surface and nothing else.
//  - API keys can no longer leak here: key values never transit IPC (provider
//    calls run in the main process), so no portal response can contain one.

export type PortalHandler = (event: unknown, ...args: unknown[]) => unknown;

let handlers = new Map<string, PortalHandler>();

/** ipc.ts hands over its full ai-chat:* handler registry. */
export function setHandlers(registry: Map<string, PortalHandler>): void {
  handlers = registry;
}

const DESKTOP_ONLY = new Set(DESKTOP_ONLY_CHANNELS);
const PORTAL_CHANNELS = new Set(Object.values(RPC_CHANNELS));
const MAX_BODY_BYTES = 128 * 1024 * 1024; // message attachments arrive as base64 JSON
const DEFAULT_PORT = 8967;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

let rendererDist = '';
let server: http.Server | null = null;
let httpsServer: https.Server | null = null;
let currentPort = 0;
let currentHttpsPort = 0;
let lastError = '';

export function init(): void {
  // electron-vite emits the renderer next to the main bundle: out/renderer.
  // In dev there is no built renderer — the portal then serves a hint page
  // for static requests while the RPC endpoint still works.
  rendererDist = path.join(app.getAppPath(), 'out', 'renderer');
}

// Start/stop/restart the server to match the saved settings. Called at module
// registration and whenever the portal settings change.
export function sync(): void {
  const settings = db.getSettings();
  if (!settings.webPortalEnabled) {
    stop();
    return;
  }
  if (!db.getPortalToken()) {
    db.setPortalToken(randomBytes(8).toString('hex'));
  }
  const port =
    Number.isInteger(settings.webPortalPort) &&
    settings.webPortalPort > 0 &&
    settings.webPortalPort < 65536
      ? settings.webPortalPort
      : DEFAULT_PORT;
  if (server && currentPort === port) return;

  stop();
  lastError = '';
  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    handleRequest(req, res).catch((err) => {
      console.warn('[ai-chat portal]', (err as Error).message);
      if (!res.headersSent) res.writeHead(500);
      res.end('Internal error');
    });
  };
  const srv = http.createServer(onRequest);
  srv.on('error', (err) => {
    lastError = (err as Error).message;
    server = null;
    currentPort = 0;
  });
  srv.listen(port, '0.0.0.0', () => {
    currentPort = port;
    console.log(`[ai-chat portal] serving on port ${port}`);
  });
  server = srv;

  // HTTPS twin on port+1: phone browsers refuse microphone access on plain
  // http origins, so voice in the portal needs a secure (if self-signed)
  // context. Failure here must never take down the http portal.
  void startHttps(port < 65535 ? port + 1 : port - 1, onRequest);
}

async function startHttps(
  port: number,
  onRequest: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<void> {
  try {
    const { key, cert } = await loadOrCreateCert();
    const srv = https.createServer({ key, cert }, onRequest);
    srv.on('error', (err) => {
      console.warn('[ai-chat portal] https:', (err as Error).message);
      httpsServer = null;
      currentHttpsPort = 0;
    });
    srv.listen(port, '0.0.0.0', () => {
      currentHttpsPort = port;
      console.log(`[ai-chat portal] https serving on port ${port}`);
    });
    httpsServer = srv;
  } catch (err) {
    console.warn('[ai-chat portal] https disabled:', (err as Error).message);
  }
}

// Self-signed cert for the LAN portal, persisted in the module's data folder
// and regenerated when the machine's LAN addresses are no longer all covered
// by its SANs. `selfsigned` is imported lazily so the module adds no startup
// cost while the portal is off.
async function loadOrCreateCert(): Promise<{ key: string; cert: string; ips: string[] }> {
  const file = path.join(db.moduleDataDir(), 'portal-cert.json');
  const ips = lanAddresses().filter((ip) => ip !== 'localhost');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      key: string;
      cert: string;
      ips: string[];
      createdAt: number;
    };
    const fresh = Date.now() - saved.createdAt < 9 * 365 * 24 * 3600_000;
    if (fresh && ips.every((ip) => saved.ips.includes(ip))) return saved;
  } catch {
    // Missing or unreadable — generate below.
  }
  const { generate: generateCert } = await import('selfsigned');
  const pems = await generateCert([{ name: 'commonName', value: 'WICKED AI Chat Portal' }], {
    notAfterDate: new Date(Date.now() + 3650 * 24 * 3600_000),
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          ...ips.map((ip) => ({ type: 7 as const, ip })),
        ],
      },
    ],
  });
  const record = { key: pems.private, cert: pems.cert, ips, createdAt: Date.now() };
  try {
    fs.writeFileSync(file, JSON.stringify(record), 'utf-8');
  } catch (err) {
    console.warn('[ai-chat portal] could not persist cert:', (err as Error).message);
  }
  return record;
}

export function stop(): void {
  server?.close();
  server = null;
  currentPort = 0;
  httpsServer?.close();
  httpsServer = null;
  currentHttpsPort = 0;
}

export function getStatus(): PortalStatus {
  const settings = db.getSettings();
  const token = db.getPortalToken();
  const running = !!server && server.listening;
  const httpsRunning = !!httpsServer && httpsServer.listening;
  const ips = lanAddresses();
  const urls = [
    ...(running ? ips.map((ip) => `http://${ip}:${currentPort}/?token=${token}`) : []),
    ...(httpsRunning ? ips.map((ip) => `https://${ip}:${currentHttpsPort}/?token=${token}`) : []),
  ];
  return {
    enabled: settings.webPortalEnabled,
    running,
    port: running ? currentPort : settings.webPortalPort || DEFAULT_PORT,
    urls,
    error: lastError || undefined,
  };
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out.length > 0 ? out : ['localhost'];
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

  if (pathname === '/__portal/bridge.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(bridgeJs());
    return;
  }

  if (pathname === '/__portal/rpc') {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    await handleRpc(req, res);
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end();
    return;
  }
  serveStatic(pathname, res);
}

async function handleRpc(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const json = (status: number, value: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };

  const token = db.getPortalToken();
  if (!token || req.headers['x-portal-token'] !== token) {
    json(401, { ok: false, error: 'Invalid or missing portal token' });
    return;
  }

  let body: { channel?: string; args?: unknown[] };
  try {
    body = JSON.parse(await readBody(req)) as typeof body;
  } catch (err) {
    json(400, { ok: false, error: (err as Error).message });
    return;
  }

  const channel = String(body.channel ?? '');
  if (!PORTAL_CHANNELS.has(channel)) {
    json(404, { ok: false, error: `Unknown method: ${channel}` });
    return;
  }
  if (DESKTOP_ONLY.has(channel)) {
    json(200, { ok: false, error: 'This action is only available in the desktop app.' });
    return;
  }
  const handler = handlers.get(channel);
  if (!handler) {
    json(404, { ok: false, error: `No handler for: ${channel}` });
    return;
  }

  try {
    const args = Array.isArray(body.args) ? body.args : [];
    const result = await handler({ portal: true }, ...args);
    json(200, { ok: true, result: result === undefined ? null : result });
  } catch (err) {
    json(200, { ok: false, error: (err as Error).message });
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function serveStatic(pathname: string, res: http.ServerResponse): void {
  if (!rendererDist || !fs.existsSync(path.join(rendererDist, 'index.html'))) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end(
      'WICKED AI Chat web portal: no built UI found (dev mode). The portal UI works in the installed app; the RPC endpoint is live.'
    );
    return;
  }

  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const root = path.normalize(rendererDist + path.sep);
  const filePath = path.normalize(path.join(rendererDist, rel));
  if (!filePath.startsWith(root) && filePath + path.sep !== root) {
    res.writeHead(403);
    res.end();
    return;
  }

  if (rel !== '/' && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // Everything else (including /) gets the app shell with the bridge injected
  // ahead of the module scripts, so window.wicked exists before the app runs.
  const html = fs
    .readFileSync(path.join(rendererDist, 'index.html'), 'utf-8')
    .replace('<head>', '<head>\n    <script src="/__portal/bridge.js"></script>');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

// The browser-side bridge. Generated (not a static asset) so the channel
// allow-list is always the one this build was compiled with. Kept to plain
// ES5-style JS since it is served raw, without any build step. It recreates
// `window.wicked` (invoke → HTTP RPC; on → inert) and provides safe fallbacks
// for the WICKED shell's own channels so the shell UI can boot in a browser.
function bridgeJs(): string {
  return `(function () {
  'use strict';

  window.__wickedPortal = true;

  // crypto.randomUUID is unavailable on insecure (http://) origins.
  if (window.crypto && !window.crypto.randomUUID) {
    window.crypto.randomUUID = function () {
      var b = new Uint8Array(16);
      window.crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      var h = Array.prototype.map
        .call(b, function (x) { return ('0' + x.toString(16)).slice(-2); })
        .join('');
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' +
        h.slice(16, 20) + '-' + h.slice(20);
    };
  }

  var AI_CHAT_CHANNELS = ${JSON.stringify(Object.values(RPC_CHANNELS))};
  var API_KEYS_STATUS_CHANNEL = ${JSON.stringify(RPC_CHANNELS.apiKeysStatus)};
  var allowed = {};
  AI_CHAT_CHANNELS.forEach(function (c) { allowed[c] = true; });

  // The token arrives once via ?token=… and is kept in localStorage.
  var token = '';
  try {
    var u = new URL(window.location.href);
    var t = u.searchParams.get('token');
    if (t) {
      window.localStorage.setItem('wickedPortalToken', t);
      u.searchParams.delete('token');
      window.history.replaceState(null, '', u.pathname + u.search + u.hash);
    }
    token = window.localStorage.getItem('wickedPortalToken') || '';
    // Land straight on the AI chat module (the shell uses a hash router).
    if (!window.location.hash) window.location.hash = '#/m/ai-chat';
  } catch (e) { /* private mode etc. */ }

  var deniedShown = false;
  function showDenied() {
    if (deniedShown) return;
    deniedShown = true;
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(0,0,0,.88);color:#fff;font-family:sans-serif;' +
      'text-align:center;padding:24px;';
    d.innerHTML = '<div style="max-width:420px"><h2 style="margin-bottom:8px">Access denied</h2>' +
      '<p>Open the portal with the full link (including <code>?token=…</code>) shown in the ' +
      'desktop app under <b>AI Chat → Settings → Web portal</b>.</p></div>';
    var add = function () { document.body.appendChild(d); };
    if (document.body) add();
    else window.addEventListener('DOMContentLoaded', add);
  }

  function rpc(channel, args) {
    return window.fetch('/__portal/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-portal-token': token },
      body: JSON.stringify({ channel: channel, args: args }),
    }).then(function (res) {
      if (res.status === 401) {
        showDenied();
        throw new Error('Web portal: access denied.');
      }
      return res.json();
    }).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'Request failed');
      return j.result;
    });
  }

  // Safe fallbacks for the WICKED shell's own channels, so the shell UI can
  // boot in a plain browser. Key presence is proxied to the module's mirrored
  // status channel; everything mutating is politely refused.
  function shellFallback(channel, args) {
    switch (channel) {
      case 'shell:settings-get':
      case 'shell:settings-set':
        return Promise.resolve({
          theme: 'system',
          disabledModules: [],
          update: { autoCheck: false, intervalHours: 4 },
        });
      case 'shell:apikeys-status':
        return rpc(API_KEYS_STATUS_CHANNEL, []);
      case 'shell:app-version':
        return Promise.resolve('portal');
      case 'shell:update-check':
      case 'shell:update-install':
      case 'shell:update-postpone':
        return Promise.resolve(null);
      case 'shell:apikeys-set':
      case 'shell:apikeys-clear':
        return Promise.resolve({ ok: false, error: 'Manage API keys in the desktop app.' });
      case 'shell:open-external':
        if (/^https?:\\/\\//i.test(String(args[0]))) window.open(args[0], '_blank', 'noopener');
        return Promise.resolve(null);
      default:
        return Promise.reject(new Error('Not available in the web portal: ' + channel));
    }
  }

  window.wicked = {
    invoke: function (channel) {
      var args = Array.prototype.slice.call(arguments, 1);
      if (allowed[channel]) return rpc(channel, args);
      return shellFallback(channel, args);
    },
    // No push events over the portal — subscriptions are inert. Chat streaming
    // still works: the stream invoke resolves with the final text.
    on: function () { return function () {}; },
  };
})();
`;
}
