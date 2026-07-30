# Trade Journal

_(module id `trade-analytics` — the route, data folder and MCP tool prefix keep that
id; the tool is named **Trade Journal** everywhere it's shown.)_

Import your **Webull order-records CSV** and get an analytics dashboard: realized
P&L, win rate, profit factor, expectancy, an equity curve, per-symbol and timing
breakdowns, a live **open-positions** view (buys with no sell yet), and an **AI
coach** that critiques your process.

## Importing

In Webull: **Orders → Export** to CSV, then in the module click **Import CSV** or
**drag the file** onto the window. You can import as often as you like — including
reports that overlap ones you already imported.

- **De-duplication.** Webull exports carry no order id, so each row gets a stable
  fingerprint (`lib/parse.ts` → `execHash`) from symbol + side + status + placed/
  filled times + prices + quantities. Executions are stored in SQLite with that
  fingerprint as the PRIMARY KEY and inserted with `INSERT OR IGNORE`, so a row
  already present is skipped. The status bar shows `N new · M dupes skipped`.
- Multiple files can be imported at once.

## Market sectors

The Overview shows **Realized P&L by market sector**. Each symbol is classified
into a broad sector (`lib/sector.ts`) from Polygon/Massive fundamentals, cached in
`sectors.json`.

- **Drill in.** Click any sector row to open a simplified per-sector page: its
  headline stats (realized P&L, win rate, profit factor, avg hold) and a table of
  every symbol you traded in that sector with per-symbol P&L, trade count, W/L and
  win rate. **Back** returns to the dashboard.
- **Fix a wrong sector.** In **Edit trade**, the **Market sector** field defaults to
  **Auto-detect** but can be set by hand. A manual pick is stored per-symbol
  (`sector-overrides.json`) and **always wins over auto-detection**, so it applies to
  **every past and future trade of that symbol**. Choose *Auto-detect* again to clear
  it. Overrides are included in Backup & Cloud Sync.

## How trades are built (`lib/analytics.ts`)

Executions are grouped per symbol and replayed in fill-time order through a
**signed-FIFO** engine (Buy = +qty, Sell/Short = −qty; a Buy against a short
position covers it first). A **trade** is one round-trip *episode*: the position
leaves flat, takes entries, is reduced by exits, and returns to flat. Realized
P&L is booked per matched lot. An episode that never returns to flat is an **open
position** — that's how the dashboard flags "bought but not sold yet".

- Only **Filled** rows with qty > 0 feed the P&L engine; Cancelled/unfilled rows
  are stored but ignored for stats.
- Times are parsed with an explicit Eastern offset (EDT/EST) so results don't
  depend on the machine's timezone.
- The Webull order export has **no fees** column, so P&L is gross of commissions
  (Webull equities are typically commission-free; regulatory fees aren't in the
  file). Unrealized P&L on open positions needs live prices (not in the export),
  so open positions show cost basis only.

The parser + engine are pure and were validated against a real 591-row export
(0 parse errors, equity curve reconciles to total realized P&L to the cent, FIFO
cross-checked by hand).

## Tabs

- **Overview** — KPI tiles, equity curve, win/loss donut, avg win/loss, streaks,
  long-vs-short, volume, best/worst symbol.
- **Trades** — every round-trip trade (open ones flagged), entry/exit/hold/P&L.
  Hover a row to **edit** or **delete** it, or use **Add trade** to enter one by
  hand (symbol, direction, qty, entry/exit price + ET time, optional partial
  exit and account). Editing/deleting acts on the underlying executions — the
  source of truth — so FIFO and every stat stay correct; a hand-entered exit
  price left blank means the position is still open. Manual rows carry a UUID
  key so they never collide with or get de-duped against imported fills.

**Account isolation.** Each account's executions are FIFO-matched on their own, so
a buy in one account can never close a position in another. A given fill (by
content hash) lives in **exactly one account**: importing a CSV whose fills
already exist under a different account skips them (reported as "already in
another account"), so accounts stay 100% separate and no trade is double-counted.
If data from an older build ended up in more than one account, a **"Clean up
duplicates"** banner appears — it keeps each fill in a single account (the
earliest-created named account that holds it) and removes the extra copies, which
also fixes inflated open-position counts.
- **Open Positions** — the "no sell yet" list with cost basis and age.
- **Symbols** — P&L-by-symbol bar chart + a sortable-by-P&L table.
- **Timing** — P&L by weekday, by hour (ET), and daily.
- **AI Coach** — sends a compact stats digest to your configured AI provider
  (Anthropic → OpenAI → Gemini → DeepSeek, from the shell vault) and returns
  process feedback. Keys are read in main at call time and never sent to the
  renderer. Process critique only — not investment advice.

Charts are hand-rolled SVG (no chart dependency) using the shell theme tokens, so
they track light/dark automatically.

## Data / MCP

- Data: `%APPDATA%/WICKED-Suite/modules/trade-analytics/trades.db` (SQLite; picked
  up by the shell's Backup & Restore automatically).
- MCP tools (read-only unless noted):
  - `trade-analytics__accounts` — list accounts (id, name, execution count) to scope the others.
  - `trade-analytics__summary` — **precise, UI-matching P&L + stats** (realized P&L,
    win rate, profit factor, expectancy, per-symbol P&L, open positions), computed with
    the same FIFO engine as the dashboard. Optional `account` (id or name); omit for every
    account + a combined view. This is the tool an agent should use for P&L — **not** raw
    executions.
  - `trade-analytics__trades` — matched round-trip trades / open positions with entry, exit,
    realized P&L, % return, hold time and status. Optional `account`, `status`, `limit`.
  - `trade-analytics__list-executions` — the raw execution audit trail (optional `account`).
    Large and low-level; prefer `__summary`/`__trades`.
  - `trade-analytics__import` (by path, de-duplicated), `trade-analytics__clear`
    (destructive, confirm-gated).

  The renderer computes analytics client-side for the UI; these tools run the **same pure
  engine** (`lib/analytics.ts`) in the main process, so what an agent reads is identical to
  what you see on screen — and is account-scoped, so accounts never bleed together.
