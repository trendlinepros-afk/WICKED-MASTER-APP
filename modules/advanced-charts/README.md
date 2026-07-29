# Advanced Charts

A candlestick charting workspace built on **Lightweight Charts** (TradingView's
free, MIT-licensed library — bundled with the app), fed by the same
**Massive/Polygon** market data the rest of the Stocks tools use. No licensed
`charting_library` download or local chart server is required anymore — if your
**Massive** key is set in Settings → API Keys, charts just work.

## Use

- Type a **symbol** and press Enter.
- Pick a **timeframe**: `1D`/`5D` (intraday minutes), `1M`/`3M`/`1Y` (daily).
- Candles + a volume histogram render inline, colored with the app theme
  (green up / red down). Crosshair, zoom and pan are built in.

Data comes from `advanced-charts:candles` → the Massive aggregates endpoint
(`getAggregates`). Empty results (unknown symbol, or a plan/session with no bars
yet) are shown as a small notice rather than a blank chart.

## MCP

`advanced-charts__status` reports whether the Massive key is present (charts
render when it is). The raw market data is exposed by Stock Planner's read-only
tools; this module is the visual surface.
