# Trade Log

A hand-written trade journal in the **Stocks** folder. Distinct from **Trade
Journal** (Webull import + analytics) and **Trade Review** (fills on a chart +
AI coach): this one is purely your own narrative — one entry per trade.

## What an entry holds

- **Name** — the trade's title (shown in the list + header). By default it's
  **auto-generated** as `TICKER - opened → closed - Green/Red` (just
  `TICKER - opened - Open` while the trade is still open), and it **updates
  itself when you close the trade** — the close date and Green (profit) / Red
  (loss) are filled in from the sold price. Type your own name to override; clear
  it (or hit "Use auto name") to go back to auto.
- **Entry** — the stock, when you bought, how many shares, the buy price, and a
  **"Why I bought"** note (setup / thesis / plan).
- **Exit** — the sold price, when you sold, a **"Why I left the trade"** note,
  and a **stress/emotion rating**: a 5-emoji scale from 😱 Panicked → 😠 Stressed
  → 😐 Neutral → 🙂 Calm → 😄 Cheerful, so you can judge how stressed you were
  during the trade (click the chosen face again to clear it). The face shows on
  the entry's list row. Left blank, the trade shows as **Open**; add a sold price
  and it becomes **Closed**.
- **Final review** — your hindsight thoughts on the trade.

When buy price, shares and sold price are all present, the entry shows realized
**P&L** (`shares × (sell − buy)`, and %) on the card and in the header.

## Flow

Click **New journal entry** → it's created immediately (nothing is lost) and
selected for editing. Fill the entry side now; come back and add the exit + final
review when you close the trade. Edits save with the **Save** button, and are
also flushed automatically when you switch entries or leave the tool.

## Persistence

Entries are stored in the shared module store (`wicked-modules.json`) under the
`trade-log.entries` key, so they're **included in Backup & Cloud Sync**. No
market-data or AI keys are used — it's a local, offline journal.

## MCP

`mcp.ts` exposes `trade-log__list`, `trade-log__create`, `trade-log__update` and
`trade-log__remove` (delete is destructive → gated on confirm). Each delegates to
the same `trade-log:*` IPC channel the UI uses.
