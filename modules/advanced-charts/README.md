# Advanced Charts

The wickeddash TradingView **Charting Library** workspace as its own tool in
the **Stocks** folder: candlesticks, all drawing tools, indicators, timeframes,
with layouts + drawings saved locally.

## The licensed library (you supply it)

TradingView's Advanced Charts library is free but **access-gated and not
redistributable**, so it is NOT bundled. One-time setup: request access at
tradingview.com/advanced-charts → download the private repo → point the tool
at the `charting_library` folder ("Locate library…"). Until then the tool
shows setup instructions instead of breaking (ported behavior).

## Architecture

`ipc/server.ts` runs an express host on 127.0.0.1 (random port, started when
the tool opens) serving: the chart page (widget config ported: AAPL/15m/dark,
ET timezone, header_saveload on, localstorage settings off, #0b1022/#21d4fd
loading colors, small-screen toolbar rules), the user's library folder, the
Massive-backed datafeed (`/api/search`, `/api/history` — resolution mapping in
`ipc/udf.ts`: 60→1h, 240→4h, 1D/1W/1M, else minutes; unit-tested), and layout
CRUD (JSON files under `userData/modules/advanced-charts/layouts/`, 8MB cap,
templates stubbed empty). The renderer embeds it in a `<webview>` — same
browser-side-library + local-routes architecture as the web app, and the shell
CSP stays intact.

Ported honestly: `subscribeBars` POLLS every 30s (no websocket exists in the
source; `data_status: delayed_streaming`). `pricescale` is 100 (2 decimals),
so sub-penny stocks render coarsely — same limitation as the original.
