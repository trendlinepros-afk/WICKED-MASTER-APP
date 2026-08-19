# Day Trade Dash

The all-day trading cockpit: everything a day trader glances at, on one screen.

## Layout

- **Top — three always-on charts.** Each has its own ticker box and candle
  duration (1m / 5m / 15m / 1h / 4h / D), rendered with lightweight-charts and
  refreshed every 30s (5 min for 4h/daily). Bars are shifted by the local UTC
  offset per bar before display (lightweight-charts renders labels in UTC —
  without the shift, intraday times read hours off). The tickers/timeframes
  persist in the module store (`day-trade-dash.state` in
  `wicked-modules.json`), so **Backup & Cloud Sync restore the exact layout**
  on any machine.
- **Middle left — watchlist.** Add tickers; rows show live price, day % and
  **% since added** (20s refresh); clicking a row charts it in the panel to
  the right (own timeframe picker). The since-added anchor is the price at the
  moment the ticker was added (hover a row for the date + anchor price); if no
  price was available right then (or the entry predates this feature), the
  first price seen afterwards becomes the anchor — it is never overwritten.
- **Middle center — selected chart + day's movers (50/50).** The watchlist
  chart shares the center with two stacked cards: **Day's Top Gainers** and
  **Day's Top Losers** (whole-market snapshot, penny/illiquid noise filtered:
  price ≥ $1, volume ≥ 100k, plain 1-5 letter symbols; refreshed every 60s).
  Clicking any row charts it. All ticker boxes (the three top charts + the
  watchlist add box) are REAL search fields — type a symbol or company name
  and pick from the dropdown (reference-tickers search, 250 ms debounce).
  A header Refresh button remounts the charts and refetches everything.
- **Middle right — market news.** Market-wide headlines (Massive/Polygon
  reference news, no ticker filter) that refresh **on the hour, every hour**
  (plus a manual refresh button). Each row shows source, age and related
  tickers.
- **Bottom — the tape.** A Wall-Street-style scrolling ribbon of live quotes
  (▲ green / ▼ red, pauses on hover). Symbols are managed in Settings; futures
  and indices ride via the ETF proxies traders actually watch (ES→SPY, NQ→QQQ,
  YM→DIA, RTY→IWM, CL→USO, GC→GLD, ZB→TLT, VIX→UVXY) since the Massive plan
  quotes stocks/ETFs.
- **Header — session clock.** Pre-market / Market open / After hours / Closed
  with a countdown to the next bell, in ET (reuses stock-planner's session
  math).
- **Live TV.** An always-visible panel embedding Bloomberg Television's 24/7
  YouTube live stream in a `<webview>` (the `live_stream?channel=` embed always
  resolves to the channel's current broadcast, so the link doesn't rot). No
  autoplay — hit play when wanted, which also satisfies the autoplay policy so
  sound works immediately. The webview sets `httpreferrer` because YouTube's
  embed player refuses referer-less requests with "configuration error 153".
  The URL is configurable in Settings, so any YouTube `/embed/...` stream works.

## Data & quirks

- Market data comes from the vault's **Massive/Polygon** key (bars via
  aggregates with next_url paging, quotes via per-ticker snapshots resolved
  with the shared JBLU-safe quote rules).
- One 20s poll feeds the tape, the watchlist AND the chart-header quotes in a
  single batched `quotes` call (max 60 symbols).
- Charts only `fitContent()` on the first load of a symbol/timeframe, so
  panning/zooming isn't fought by the refresh.
- MCP: `overview` / `news` (read-only), `watch-add` / `watch-remove`.
