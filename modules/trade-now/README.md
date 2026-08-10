# Trade Now

Open a position the moment you buy, then track it to the end. Type the ticker,
enter how many shares (and optionally the price you paid — blank uses the
current market price), optionally set **when you bought** (a date/time picker —
leave blank for now, or back-date a trade you took on a previous day), and hit
**Snap the buy**. Trade Now captures the company name and 52-week range and
records your first buy at that time.

## Position tracking

Each position holds an **order ledger** of buy/sell legs (price + quantity +
date), all editable after the fact:

- **Average down / add** — add more BUY legs any time; the average buy price and
  cost basis update.
- **Sell / scale out** — add SELL legs with the price and quantity you sold.
- A position is **In Trade** until the shares sold cover the shares bought; once
  fully sold it flips to **Closed**. The list on the left shows each position's
  status at a glance.

Computed live (average-cost basis): open shares, average buy price, total order
value (Σ price × quantity) for buys and sells, market value + unrealized P/L on
the open shares (from the delayed feed), and realized P/L on what you've sold.

## The chart

The chart marks **every** order — **green dots for buys** (below the bar),
**red dots for sells** (above) — each labeled with its quantity and price, and
refreshes as you add legs. It always loads **at least ~6 months of history**
(ending now) so there's real context to zoom out into even on a brand-new
position; the default view frames the trade (about the last three months, or
the trade's full span if it's older). Older trades load their whole span. The
bar interval scales with how much is loaded (hourly out to ~8 months, then
coarser).

**Zoom / pan.** Scroll to zoom and drag to pan (native lightweight-charts).
Set the view however you like — that's what the PDF captures.

**Draw trendlines.** Toggle **Draw trendline**, then **click two points** to
drop a line between them; **drag the white endpoint dots** to fine-tune each
end precisely. Undo / Clear sit alongside. Lines are anchored to data (logical
index + price) so they hold their place through zoom/pan and persist on the
position (`drawings`). Toggle drawing **off** to go back to zoom/pan. On
**Export PDF** the report chart is rendered light-themed for the white page,
framed to the **exact view you have on screen**, with your trendlines
composited on top.

## Printable PDF

**Export PDF** (top-right of a position — works whether the trade is open or
closed) saves a printable report to `Downloads/Trade Now/` and reveals it. The
top of the document is a grid of small metric cards — ticker, company, status,
quantity, average buy price, average sold price, buy date, sold date, and
profit/loss (green when up, red when down). Below that: a secondary stat line,
the full order ledger, the chart image (with green dots for buys, red dots for
sells), and your notes. The renderer builds the PDF with jsPDF (chart via
`takeScreenshot()`); main writes the bytes to Downloads.

## Storage & migration

`userData/modules/trade-now/snapshots.json` — positions with their leg ledger,
52-week range and notes (listed under Settings → Modules). Older single-buy
snapshots (from v1) are migrated automatically to a one-buy ledger on load
(quantity unknown → 0, which you can edit in).

## MCP

- `trade-now__list` — positions with full ledger + computed summary (read-only).
- `trade-now__snapshot` — open a position (symbol, quantity, optional buyPrice).
- `trade-now__add-leg` — add a buy or sell order to a position.
- `trade-now__update-notes` — edit reason/prediction.
- `trade-now__delete` — destructive, confirm-gated.
