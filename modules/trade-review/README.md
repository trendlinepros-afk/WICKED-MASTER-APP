# Trade Review

The wickeddash post-trade analysis tool as its own tile in the **Stocks**
folder. Drop in filled orders (any broker CSV, or screenshots via AI vision),
see buys/sells mapped onto a **1-minute execution chart** with dashed
round-trip P&L connectors, and get an AI **trading coach** review graded
against a trendline/swing strategy (flags chasing, panic exits, cut winners,
held losers, scalping a swing plan). Coach chat is stateless: every call
re-sends the session digest + last 20 turns.

Since it shares the Trade Journal's parser, it accepts every format that does —
Webull, Robinhood, Schwab, Fidelity, IBKR, E\*TRADE, tastytrade, NinjaTrader,
**Tradovate** (futures orders), OANDA, TradingView/EightCap. **Futures** get the
right contract point value (`MYMZ6` $0.50/pt, `MNQZ6` $2/pt, ES $50…), so
round-trip P&L, stats and the coach are exact even for a Tradovate orders export
that carries no P&L column. Note the **1-minute price chart needs an intraday
feed the stock-data plan doesn't include for futures**, so it shows an
explanatory note instead of candles for contracts like `MYMZ6`; the numbers and
coach are unaffected (they come straight from the fills).

## Shared engines (imported, not duplicated)

- CSV parsing runs **client-side** with the Trade Journal's tested parser
  (`modules/trade-analytics/lib/parse.ts`); screenshot extraction is a
  strict-prompt vision call ("do not invent rows"), Zod-validated, then pushed
  through the same broker-time parsing.
- Round trips + summary come from the Trade Journal's signed-FIFO engine
  (`lib/analytics.ts`) — leftover quantity flips the position, residual shares
  surface as open positions. Symbols ranked by fill count drive the tabs.
- Candles: Massive single-day 1-minute bars via the shared market layer
  (session date derived from the first fill, ET). "No data" state when the
  Massive key is missing.
- The review returns the same ReportSpec JSON and reuses Stock Planner's PDF
  renderer (brand label "WICKED · TRADE REVIEW"); the chart SVG is rasterized
  to a 2× PNG for the PDF.

## Persistence

**Session-state only** (ported behavior) — nothing is stored. Only exported
PDFs are written, to `Documents\Stock Trading\{TICKER…}\` with the
`{TICKER} trade analysis — MM-DD-YYYY.pdf` name (replace-on-same-name). Folder
matching uses the ported **word-boundary prefix rule** so RPD never lands in
RPDX's folder (`ipc/folders.ts`, unit-tested).
