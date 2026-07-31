# Paper Trading

A live paper-trading desk in the **Stocks** folder — trade against real
Polygon/Massive prices, with its own review built in. All state is local
(module store → Backup & Cloud Sync); no real orders are ever sent.

## Accounts

Top-right **Accounts** button: create, rename, switch and delete paper accounts.
A new account starts at **$5,000** by default, but you can set any starting
balance **at creation**. After that the balance only ever changes through
trades — it can't be edited by hand.

## Trading

Type a ticker to load its **Lightweight candlestick chart**; the order ticket
trades that symbol.

- **Stocks** — **Buy (long)** or **Sell / Short**, any share count, with optional
  **stop-loss**, **trailing stop** ($ distance below the peak) and **take-profit**.
  Fills at the live price; the ticket shows the **estimated order cost** as you
  type. Buying more of a stock you already hold **consolidates into one position**
  at the share-weighted **average cost**. The position card shows total size
  (cost basis) and current value, and its stop-loss / trailing / take-profit can
  be edited inline.
- **Options** — long **calls/puts** (type, strike, expiry, contracts). Priced
  **manually**: you enter the premium on entry and on close, and P&L is tracked
  against it. (Live option quotes are plan-dependent and deferred; underlying
  data drives the chart.)

Live prices poll every ~20s while the tool is open.

## P&L

- **Header**: live **Equity**, **Cash** and all-time **Total P&L**.
- **Right panel**: **Open P&L** (unrealized) and **realized Account P&L** for
  **today / this week / this month**, plus per-symbol **Symbol P&L**.
- **Positions / History / Review** tabs — the Review tab is a full trade review
  (net, win rate, avg win/loss, profit factor, best/worst) computed from your
  closed paper trades.

## Offline stops & targets (backdating)

Because the tool only runs while your desktop is on, **on open it reconciles**:
for each stock position with a stop or target, it pulls the minute history since
it last checked and, if the level was crossed while you were away, **closes the
position backdated to the exact time/price it was hit** (stop is checked before
target within a bar, conservatively).

## MCP

Read-only: `paper-trading__accounts` (accounts, positions, closed trades) and
`paper-trading__quotes` (live prices). Placing/closing trades stays a manual
action.
