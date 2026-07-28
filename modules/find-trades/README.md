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

## Trending on X (social)

A section at the top of the tool that **auto-loads on open** and shows the stock
tickers **mentioned most on X (Twitter)** over a chosen window — **24h, 7d, 2wk,
1mo, 90d, 6mo** — each with a bull/bear sentiment read and a **heat rating**
(`ipc/x.ts`).

- **How.** App-only Bearer auth searches finance tweets (`has:cashtags`, with a
  broad-finance fallback if that operator isn't on your access tier), pulls the
  `$CASHTAG` entities, and tallies mentions + engagement + a lightweight
  lexicon sentiment. No AI tokens are spent — the rating is deterministic.
- **Rating** = buzz (mentions vs the hottest ticker) 50% + price momentum (today's
  move) 25% + tweet sentiment 25%, bucketed **Hot / Warm / Watch / Cool**.
- **Validated against the market.** When a Massive key is present, tickers are
  filtered to real US equities (drops junk cashtags like `$ROPE`) and decorated
  with live price/change/volume.
- **Window reality.** Recent-search covers the **last 7 days**; **windows over 7
  days need X API Pro** (full-archive access) — the tool says so and still serves
  24h/7d on Basic.
- **Quota-aware.** X's monthly tweet cap is small, so each window is **cached ~30
  min**; opening the tool repeatedly won't re-spend it. Manual **Refresh** bypasses
  the cache. **Ask AI** on any row hands the ticker to the screener chat below.

## Keys

- **Massive / Polygon** — required (market snapshot, details).
- **X (Twitter) Bearer Token** — optional, powers "Trending on X" (OAuth 2.0
  App-Only token; Basic tier reaches 7 days, Pro for longer windows).
- **An AI key** — required (the screener brain). Provider preference is
  **Anthropic (Claude) → Gemini → DeepSeek → OpenAI**; whichever keys you have,
  the first available is used. With a Claude key the tool runs a cost-aware
  two-tier setup: **Haiku 4.5** turns your request into a screen plan, **Sonnet
  5** reads the live data and writes the pick theses.
- **Finnhub** — optional, richer company news (falls back to Massive news).

Keys come from the shell vault; none are sent to the renderer.

## MCP

Two **deterministic** read-only tools are exposed to agents: `find-trades__screen`
(explicit numeric criteria in, matching tickers out) and `find-trades__trending`
(most-mentioned tickers on X over a window, rated). The AI chat consumes vault AI
keys, so it stays off MCP per the module contract.

Educational screening for ideas to research — not financial advice.
