# Webpage Downloader

Paste a web address, press **Download page**: the whole page — text, images,
colours/styles, fonts, frames — is saved to its own folder (in **Downloads**
by default) that opens offline in any browser.

```
Downloads/
  Test Shop & Co — Home (example.com) 2026-10-17 1259/
    index.html        ← open this
    assets/           CSS, images, fonts, frames
    screenshot.png    full-page picture (option)
    page.mhtml        single-file copy for Edge / Chrome (option)
```

## How

1. **Capture** — the shell's `ctx.capturePage` (`src/main/page-capture.ts`)
   loads the page in a hidden Chromium window with its own throw-away session
   (no WICKED cookies or logins, nothing kept), sandboxed, no preload/Node,
   popups/downloads/permissions refused, only http(s). It waits for the page
   to settle (network quiet), scrolls to the bottom in steps so lazy images
   and sections load, optionally takes a full-page PNG (DevTools
   `Page.captureScreenshot`, ≤ 16,000 px tall), then `savePage(…, 'MHTML')` —
   Chromium's archive of the page **as rendered** (the DOM after scripts ran,
   with every resource it used).
2. **Unpack** (`lib/mhtml.ts`, pure) — the MHTML parts become files; every
   reference in the HTML (`src`, `srcset`, `poster`, `style`, `<style>`,
   stylesheets, icons, frames via `cid:`) and in CSS (`url()`, `@import`) is
   rewritten to the local copy. Scripts, `<noscript>`, CSP / refresh `<meta>`,
   `<base>` and inline `on…=` handlers are removed so the copy stays exactly as
   captured. Ordinary links (`<a href>`) point at the live site.
3. **Fill the gaps** (`lib/save.ts`) — Chromium leaves some files out of MHTML
   (web fonts, favicons…). Anything the page uses that isn't in the snapshot is
   fetched from the site (Electron `net.fetch`, two rounds so a fetched
   stylesheet's own fonts come too; ≤ 300 files, 30 MB each, 300 MB total,
   20 s each) and the page is unpacked again with them.

Pages are saved one at a time (each is a whole hidden browser); paste several
addresses and they queue. A capture gives up after ~90 s.

## Limits

- Pages behind a login save as a logged-out visitor sees them (the capture
  window deliberately has none of your cookies).
- Content that only appears after clicking (tabs, "load more" buttons) isn't
  clicked; infinite scroll loads up to ~80 screens.
- Video streams (YouTube etc.) aren't downloaded — use the Playlist Downloader.

## Data

History (`history.json`) in the module data folder; save folder setting via
**Change folder** (`page-downloader.saveDir`). Delete moves a saved folder to
the Recycle Bin.

## MCP

`page-downloader__save {url}`, `__saved-pages`, `__delete` (confirm-gated).
