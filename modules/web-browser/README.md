# Web Browser

A browser module with two complementary modes:

1. **In-app browser** — a tabbed `<webview>` browser embedded in the WICKED window:
   address bar (URL or Google search), back/forward/reload, per-site logins that
   persist (`persist:web-browser` session partition), bookmarks (stored by the
   module), and tab-session restore. Popups / `target=_blank` open as new in-app
   tabs (routed through the main process, scoped to this module's partition only).
2. **Full Chrome** — launches the user's real Google Chrome with a **dedicated
   WICKED profile** (`userData/modules/web-browser/chrome-profile`) and a
   localhost-only DevTools automation port. This is where Chrome extensions —
   including **Claude in Chrome** — and Chrome-sync bookmarks work: sign into
   your Google account in that Chrome once and sync brings them in. The module's
   MCP tools automate these tabs (list/open/navigate/read/screenshot/eval).

## Why two modes (the honest platform constraints)

- **Chrome extensions cannot run inside Electron.** Electron embeds Chromium's
  engine but not Chrome's extension platform (no Web Store, no side panel,
  no identity/sync APIs). Anything extension-dependent must run in real Chrome.
- **Chrome 136+ refuses `--remote-debugging-port` on the default profile**, so
  automation *requires* a separate `--user-data-dir`. That's why Full Chrome uses
  a dedicated persistent profile rather than the user's day-to-day one — sign in
  to sync once and it has the same bookmarks/extensions from then on.

## Automation / MCP

All automation targets Full Chrome over the Chrome DevTools Protocol:

- `web-browser__status`, `__launch-chrome`, `__tabs`, `__open`, `__navigate`,
  `__activate-tab`, `__page-content` (text/HTML), `__screenshot` (PNG to file),
  `__eval` (destructive, confirm-gated), `__close-tab` (destructive, confirm-gated)
- In-app browser: `__bookmarks`, `__bookmark-add`, `__bookmark-remove`,
  `__open-in-app` (fire-and-forget tab in the embedded browser)

Security notes:

- The DevTools port binds to **127.0.0.1 only**, and we do **not** pass
  `--remote-allow-origins`. The CDP client is Node's built-in WebSocket, which
  sends **no Origin header** — Chrome accepts it while still rejecting drive-by
  connection attempts from websites (which always carry an Origin).
- Default port is **9224** (not 9222, to avoid dev-tooling collisions); override
  via the shared store key `web-browser.debugPort` if ever needed.
- `eval` runs with the user's logged-in session in that tab, hence the
  destructive confirm gate on the MCP path.

## Quirks

- **Search defaults to DuckDuckGo, not Google.** Google actively blocks embedded
  (non-Chrome) browsers behind an "unusual traffic" reCAPTCHA wall that can loop
  forever. DuckDuckGo doesn't, so it's the sane default. You can still type
  `google.com` directly, and for a Google experience that always works, use Full
  Chrome. (The address bar treats bare domains as URLs and everything else as a
  DuckDuckGo search.)
- **UA + Client Hints are set together, in main.** The embedded browser presents
  a clean Chrome-on-Windows identity via `session.setUserAgent` **and** a matching
  rewrite of the `Sec-CH-UA*` request headers (`modules/web-browser/ipc.ts`).
  Spoofing only the UA string (e.g. the `<webview useragent>` attribute) leaves
  Chromium's client-hint brand list saying "Electron" — that UA/hint mismatch is
  exactly what trips Google's bot wall — so the tag deliberately sets no
  `useragent`. Some sites may still refuse embedded logins; use Full Chrome.
- If DevTools is manually opened on a Full Chrome tab, that tab's automation
  socket is busy; tools return a clear error asking to close DevTools.
- If a Chrome window using the WICKED profile is somehow running *without* the
  automation port, launch waits ~20s then explains how to recover (close those
  windows, relaunch).
- Screenshots require bringing the tab to the front (Chrome can't capture
  background tabs); the tool does this automatically.
- The in-app browser deliberately keeps at least one tab open (a start page).

## Data paths

- `userData/modules/web-browser/bookmarks.json` — in-app bookmarks
- `userData/modules/web-browser/chrome-profile/` — Full Chrome user-data-dir
- `userData/modules/web-browser/screenshots/` — automation screenshots
