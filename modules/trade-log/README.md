# Trade Log

A hand-written trade journal in the **Stocks** folder. Distinct from **Trade
Journal** (Webull import + analytics) and **Trade Review** (fills on a chart +
AI coach): this one is purely your own narrative — one entry per trade.

## What an entry holds

- **Entry** — the stock, when you bought, how many shares, the buy price, and a
  **"Why I bought"** note (setup / thesis / plan).
- **Exit** — the sold price, when you sold, and a **"Why I left the trade"**
  note. Left blank, the trade shows as **Open**; add a sold price and it becomes
  **Closed**.
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
