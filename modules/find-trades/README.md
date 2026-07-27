# Find Trades

An AI **screener agent** in the Stocks folder. You describe what you're hunting
for in plain English; the tool turns it into a structured screen, runs it
against the **live market snapshot + news**, and comes back with matching
tickers and a one-line thesis for each.

## How it works (3 stages)

1. **Criteria → ScreenPlan.** Your request (with the last few chat turns for
   context) is sent to the AI in JSON mode and parsed into a `ScreenPlan`
   (`lib/plan.ts`, Zod-validated, tolerant): source, direction, price/%/volume/
   market-cap ranges, sectors, keywords, needs-news, limit.
2. **Deterministic screen.** The plan runs against the shared market layer
   (`stock-planner/ipc/market`): the full US snapshot (or premarket/afterhours
   movers, or IPOs, or explicit tickers) → numeric filters → rank → enrich the
   top survivors with sector (classified via the Trade Journal's SIC mapper),
   market cap, and news (Finnhub, else Massive) → sector/cap/keyword/news
   filters. **No numbers are invented — the data is the source of truth.**
3. **Rank + explain.** The surviving candidates (with their real data) go back
   to the AI, which picks the best fits and writes a short thesis + risk flags.
   The thesis is joined back onto the real rows.

## Keys

- **Massive / Polygon** — required (market snapshot, details).
- **An AI key** — required (the screener brain). Provider preference is
  **Anthropic (Claude) → Gemini → DeepSeek → OpenAI**; whichever keys you have,
  the first available is used. With a Claude key the tool runs a cost-aware
  two-tier setup: **Haiku 4.5** turns your request into a screen plan, **Sonnet
  5** reads the live data and writes the pick theses.
- **Finnhub** — optional, richer company news (falls back to Massive news).

Keys come from the shell vault; none are sent to the renderer.

## MCP

Only the **deterministic** `find-trades__screen` is exposed to agents (explicit
numeric criteria in, matching tickers out). The AI chat consumes vault AI keys,
so it stays off MCP per the module contract.

Educational screening for ideas to research — not financial advice.
