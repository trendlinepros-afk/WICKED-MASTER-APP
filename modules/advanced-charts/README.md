# Advanced Charts

A **multi-chart** candlestick workspace built on **Lightweight Charts**
(TradingView's free, MIT-licensed library — bundled with the app), fed by the
same **Massive/Polygon** market data the rest of the Stocks tools use. If your
**Massive** key is set in Settings → API Keys, charts just work.

## Use

- **Charts dropdown** (top): show 1, 2, 4, 6, 8, 10 or 12 charts in a grid on
  one page. The choice persists.
- Every chart launches **blank** — type a ticker into a chart's box and press
  Enter to populate it.
- **Candles dropdown** (top): candle duration — 1m, 5m, 15m, 30m, 1h, 2h, 4h
  (the default), Daily, Weekly. Changing it **overrides every chart at once**.
- Each chart also has its **own** duration picker (top-right of the tile) to
  diverge from the rest — until the top dropdown is changed again, which snaps
  all charts back to one duration.
- Candles + a volume histogram render inline, colored with the app theme
  (green up / red down). Crosshair, zoom and pan are built in.

## Per-ticker notes

Under every chart is a small two-line note box. Notes are keyed to the
**ticker**, not the chart slot: switch the chart to another ticker and its note
swaps out; load that ticker again tomorrow (in any slot) and the note is back.
Saved automatically (debounced) to
`userData/modules/advanced-charts/ticker-notes.json` — listed under Settings →
Modules data paths.

## Data

`advanced-charts:candles` → the Massive aggregates endpoint (`getAggregates`),
with a lookback window per duration (e.g. 2 days of 1m bars … 5 years of weekly
bars). Empty results (unknown symbol, or a plan/session with no bars yet) show
as a small notice rather than a blank chart.

## MCP

`advanced-charts__status` reports whether the Massive key is present (charts
render when it is). The raw market data is exposed by Stock Planner's read-only
tools; this module is the visual surface.
