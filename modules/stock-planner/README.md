# Stock Planner

Port of the wickeddash Stock Planner: a guided research desk per stock —
**Find → Analysis (AI report card) → Trendlines (screenshot vision) → Summary
(PDF export)** — plus screeners, an IPO finder, compare, and a docked
market-aware AI assistant. Lives in the **Stocks** folder.

## Shared market-data layer (`ipc/market/`)

This module hosts the market layer the other stock tools reuse (import it —
don't duplicate it):

- `massive.ts` — Polygon-compatible client. **Bearer-header auth** (not
  Polygon's `?apiKey=`), 15s timeout, every failure fails soft to null/[].
  Aggregates, grouped daily closes (5-min cache/date), reference search +
  details + financials, IPO calendar (5-min cache), per-ticker + full-market
  snapshots (20s cache), Benzinga earnings, news fallback.
- `finnhub.ts` — news + earnings (12s timeout). General news cached until the
  **6 AM ET** news-day rollover.
- `yahoo.ts` — unofficial last-resort fallbacks (quote; earnings via the
  cookie+crumb dance, creds cached 30 min). Nothing load-bearing.
- `sessions.ts` — DST-aware ET session logic via Intl (pre 4:00–9:30, regular
  9:30–16:00, after 16:00–20:00, weekends closed). Unit-tested.
- `quotes.ts` — the "JBLU bug" quote resolution: 0/negative = missing;
  `lastTrade → minute → day → prevDay → prevClose`; change derived only when
  both sides are real. **P/E = marketCap / net income** — a net loss yields a real
  NEGATIVE P/E (not "N/A"); only zero/missing income is null. Unit-tested.
- `tickerdata.ts` — concurrent fan-out assembling the research picture; the
  earnings cascade **Finnhub → Massive/Benzinga → Yahoo** returns
  `{date, isEstimate, source}` or null — prompts forbid guessing. P/E falls back to
  Finnhub's reported trailing P/E when our fundamentals are thin.

## Report card & PDF

- **Past Earnings** — the AI report injects a real, non-AI section listing the last
  4 reported quarters (`getEarningsHistory`): each quarter's expected vs reported
  EPS and the report date, with the beat/miss delta.
- **Chart** — the PDF embeds the user's trendline screenshots when provided;
  **when none are given it draws a generated 2-year daily price line** instead
  (`:price-series` → `lib/pdf.ts`), so every report has a chart.
- **PDF header** auto-shrinks the title/subtitle to fit the header band, so a long
  company name is never clipped.
- `screeners.ts` — session-gated pre-market (requires day volume 0) /
  after-hours / daily / period (7/30/182/365d via grouped closes, walking back
  ≤6 days to real trading days). Filters: price ≥ $1, volume ≥ 1k extended /
  50k daily+period.

Keys come from the shell vault: `massive`, `finnhub` (Settings → API Keys).

## AI

`ipc/ai.ts`: AUTO cascade Gemini → DeepSeek → OpenAI (vault keys). Ported
quirk kept: **JSON report calls pin Gemini to a non-thinking model**
(default `gemini-2.5-flash`; override via store key `stock-planner.reportModel`)
so thinking tokens can't truncate the JSON. Reports are Zod-validated
ReportSpecs parsed defensively (`ipc/report.ts`): strict → coerce/clamp →
`closeTruncatedJson` mid-stream repair, unwrapping `{report:{…}}` envelopes.
The chat injects live-data context (`ipc/chatContext.ts`): the doc's ticker,
cashtag/bare-symbol mentions filtered through a stopword list (max 3, with a
title+recent-messages fallback), the IPO calendar on "IPO" mentions, and a
summary of the existing report. MCP exposes **read-only market tools only** —
the AI channels consume vault keys, so per the contract they're not on the MCP
surface.

## Data

Per-ticker analysis docs (report JSON + chat + up to 4 screenshots ≤8MB as
data: URLs) under `userData/modules/stock-planner/docs/`. Starting an analysis
reuses the ticker's doc. PDF exports (jsPDF, navy/cyan brand, stat cards,
screenshots, page footers) save to `Documents\Stock Trading\{TICKER — Company}\`.
The TradingView panel is the free widgetembed iframe in a `<webview>` — no key,
separate from the licensed Advanced Charts library (different tool, later).
