# Trade Now

A snapshot of the **moment you buy** a stock. You just bought → open the tool,
type the ticker, hit **Snap**. The tool freezes that instant:

- Company name and the price at purchase (from your Massive/Polygon feed,
  15-minute delayed)
- 52-week high / low (computed from a year of daily bars at capture time)
- **The chart as it looked right then** — ~90 days of 4h candles ending at your
  buy, with a BUY marker at the exact date/time and price. The bars are stored
  inside the snapshot, so the chart re-renders identically forever; it never
  updates with later data.
- Two note fields — **Why I bought** and **My prediction** — editable any time,
  auto-saved.

Opening a snapshot later also fetches the **current** price and shows the %
move since your buy, so you can grade the prediction against what actually
happened.

## Storage

`userData/modules/trade-now/snapshots.json` — one JSON array of frozen
snapshots (bars included). Listed under Settings → Modules data paths; rides
along in backups and Cloud Sync.

## MCP

- `trade-now__list` — all snapshots (without bars). Read-only.
- `trade-now__snapshot` — take a snapshot of a ticker right now (optionally
  with reason/prediction).
- `trade-now__update-notes` — edit a snapshot's notes.
- `trade-now__delete` — destructive, confirm-gated.

## Quirks

- The chart marker sits on the last captured bar — with a 15-minute-delayed
  feed that bar is the freshest one available at capture time.
- Snapshots taken outside market hours freeze the most recent session's data
  (that IS the state of the world at that moment).
