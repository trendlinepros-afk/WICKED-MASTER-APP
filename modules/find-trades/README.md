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
   market cap, news (Finnhub, else Massive), and **technical signals** (below) →
   sector/cap/keyword/news + signal filters. **No numbers are invented — the data
   is the source of truth.**
3. **Rank + explain.** The surviving candidates (with their real data + signals)
   go back to the AI, which picks the best fits and writes a short thesis + risk
   flags. The thesis is joined back onto the real rows.

## Trade Score & technical signals (the "is this move real?" layer)

Movement alone (price/%/volume) doesn't say a move is *tradable*. At enrichment,
the top survivors get **daily-bar signals** (`ipc/market/signals.ts`, pure +
unit-tested) computed from ~400 days of Polygon aggregates:

- **RVOL** — today's volume ÷ 20-day average (the #1 "is this real?" filter)
- **Gap %** (open vs prior close), **ATR %** (typical daily range / mover check)
- **52-week-high proximity** (breakout candidates), **SMA 20/50 trend**, **RSI 14**

These fuse into a **unified Trade Score (0–100, A–F)** — a momentum-biased setup
grade (RVOL 30 · momentum 20 · trend 15 · breakout 12 · volatility 8 · RSI 5 ·
news 10 · social 5) — shown as a badge with the top contributing **reasons**, and
handed to the AI so it ranks with real context. The plan can filter on them:
`minRvol`, `minGapPct`/`maxGapPct`, `nearHigh`, `minAtrPct`, `requireUptrend`,
`minScore` — the AI sets these from phrases like "unusual volume", "gapping up",
"near highs", "in an uptrend", "strongest setups". Daily bars are cached ~30 min
per ticker to stay light on the Massive quota.

Each pick also carries:

- **Setup tag** (`signals.ts classifySetup`) — Gap & Go / Momentum Breakout /
  Trend Continuation / Oversold Bounce / High-Volume Mover.
- **Trade plan** (`tradePlan`) — an ATR-based entry / stop (1.5×ATR) / target
  (2R, or the 52-week high if it's just overhead) / risk-reward. Educational
  scaffolding, **not advice**.
- **News velocity** (`catalyst.ts newsVelocity`) — headline count in the last
  24h/72h as catalyst intensity, with a 🔥 hot flag at 3+/24h.
- **Catalyst classification** (`ipc/market/catalyst.ts`) from the news headlines —
  FDA / M&A / Earnings / Upgrade / Guidance… and critically a **⚠ Dilution /
  Offering** (or downgrade) AVOID flag, checked first so a dilution headline is
  never mislabeled. Fed to the AI so it warns on or skips those.

## Smart-money extras (Tier 3, Finnhub)

The top ~12 candidates are decorated (when a Finnhub key is present) with
`getFinnhubExtras` — all **fail-soft**, so a premium/absent field just shows
nothing:

- **Analyst consensus** — % bullish from the recommendation trend (Strong Buy /
  Buy / Hold / Sell).
- **Insider activity** — net Form-4 share change over ~90 days ("Insider buys").
- **Short interest % of float** — squeeze potential (only when your Finnhub plan
  exposes it), plus beta.
- **Next earnings date** — days away (Finnhub, else Massive/Benzinga), shown as an
  "Earnings in Nd" chip (amber ≤5 days). Filter with `maxDaysToEarnings`
  (runup plays) or `avoidEarnings` (don't hold through the report).

Filterable via `insiderBuying`, `minAnalystBull`, `minShortPctFloat`,
`maxDaysToEarnings`, `avoidEarnings` (the AI sets them from "insider buying",
"analyst favorite", "high short interest / squeeze", "earnings this week",
"no earnings risk"),
and surfaced as row chips + fed to the AI ranker. Extras are cached ~30 min/ticker
and capped to the top 12 to stay friendly to Finnhub's rate limit.

## Catalyst from the source (SEC EDGAR)

For the top handful of candidates the tool also hits **SEC EDGAR** (free, no key)
and flags a **recent registration/offering filing** (S-1 / S-3 / 424B / F-1) in
the last ~30 days — a **dilution risk straight from the source**, shown as a red
**⚠ SEC offering** chip and promoted to the AVOID catalyst even if the news
hasn't caught it. Also notes recent 8-K / Form 4. Pure `classifyFilings` is
unit-tested; ticker→CIK map + submissions are cached.

## Second social source (StockTwits)

For the top few candidates the tool also reads **StockTwits** (free, finance-
specific) and shows the community **% bullish** on the recent message stream —
a cross-check on the X signal — and meaningful bullish chatter lights the Trade
Score's social bonus. Fail-soft; `classifyStream` is unit-tested.

## Watchlist &amp; alerts

Star any result (or add a ticker in the **Watchlist** dialog) to track it, then set
per-ticker alerts: **price above / below**, **up % today**, **volume spike (RVOL
≥)**, **at/near 52-week high** (`lib/watch.ts`, pure + unit-tested).

A **background monitor** (toggle in the dialog, **on by default**) checks the
watchlist every ~2 minutes while the market isn't fully closed, and fires **new**
alerts as a **system notification** + an in-app banner. Alerts are edge-triggered
with a 4-hour anti-flap cooldown (a price hovering at a threshold won't spam), and
re-arm once the condition goes false. Everything persists in the shell store
(`find-trades.watchlist` / `.monitorEnabled`). Price/%/RVOL/52w come from the same
Massive snapshot + daily-bar signals the screener uses (cached), so monitoring is
light — but it does poll while enabled, hence the off switch.

## One-click scans (presets)

Deterministic scanners on the empty screen — **no AI cost** — that map straight to
`ScreenPlan` fields and render like a chat answer, ranked by Trade Score:
**Small-cap runners**, **Gap-ups with news**, **Near 52-week highs**, **Unusual
volume**, **Large-cap momentum**, **Oversold bounce**, **Squeeze candidates**
(needs Finnhub short data), **Smart-money picks** (analyst + insider) — `PRESETS`
in `ipc.ts`; `find-trades:presets` / `:preset`.

## Trending on X (social)

A section at the top of the tool that shows the stock tickers **mentioned most on
X (Twitter)** over a chosen window — **24h, 7d, 2wk, 1mo, 90d, 6mo** — each with a
bull/bear sentiment read and a **heat rating** (`ipc/x.ts`).

- **Nothing runs automatically.** X reads cost money (per‑post billing), so a scan
  only happens when you press **Scan Tweets**. Opening the tool is free.
- **You control the cost.** A **Scan size** setting (100 / 200 / 300 tweets, at
  ~$0.005/tweet ≈ $0.50 / $1.00 / $1.50 per scan) is persisted
  (`find-trades.xScanSize`) and read in main to bound `maxPages`.
- **Past scans are saved.** Every fresh scan is written to a capped history
  (`find-trades.xScanHistory`, last 20) and offered in a **Past scans** dropdown —
  re‑viewing an old scan is free (no API call). The newest saved scan is shown on
  open (also free).
- **How.** App-only Bearer auth searches finance tweets (`has:cashtags`, with a
  broad-finance fallback if that operator isn't on your access tier), pulls the
  `$CASHTAG` entities, and tallies mentions + engagement + a lightweight lexicon
  sentiment. No AI tokens are spent — the rating is deterministic.
- **Heat rating** = buzz (mentions vs the hottest ticker) 50% + price momentum
  (today's move) 25% + tweet sentiment 25%, bucketed **Hot / Warm / Watch / Cool**.
- **Social velocity** — from each scanned tweet's timestamp (free, no extra
  calls) the tool measures per-ticker acceleration: **🔥 accelerating** when a
  ticker's mentions cluster in the recent half of the sample, **↓ fading** when
  they don't (`classifyVelocity`). The mention-history chart also flags the
  latest bucket **rising / cooling** vs its average.
- **Proposed Growth** — a second, tone-driven grade. Each post is classified
  **positive** (confirmed good news), **hopeful** (forward-looking optimism that
  hasn't happened yet), or **negative**; the per-ticker average tone becomes a
  grade **A → F** with a sentiment-implied % (bounded to ±15%) and a **confidence**
  (from how many posts were seen). It is a crowd-sentiment LEAN, **not a
  forecast** — labelled as such in the UI. Deterministic, so it adds no API/AI
  cost to a scan.
- **Validated against the market.** When a Massive key is present, tickers are
  filtered to real US equities (drops junk cashtags like `$ROPE`) and decorated
  with live price/change/volume.
- **Window reality.** Recent-search covers the **last 7 days**; **windows over 7
  days need X API Pro** (full-archive access) — the tool says so and still serves
  24h/7d on Basic.
- A short **30‑min cache** per window+size guards against an accidental
  double‑click charging twice. **Ask AI** on any row hands the ticker to the
  screener chat below.

### Exact mention history (counts)

The trending tally is a *sample*; for a **precise** read, the chart button on any
row (or the "Exact mention history" lookup box — works for any ticker) uses X's
**counts endpoint** to show mentions of one ticker **per hour** (24h window) or
**per day** (longer), with the exact total. Counts are a **separate, cheaper
resource that does NOT draw down the tweet-pull cap**, so it's cheap to run.
Recent counts cover 7 days; longer windows use full-archive counts (X API Pro).
Cached per ticker+window ~30 min.

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

Three **deterministic** read-only tools are exposed to agents: `find-trades__screen`
(explicit numeric criteria in, matching tickers out), `find-trades__trending`
(most-mentioned tickers on X over a window, rated), and `find-trades__mentions`
(exact per-hour/day mention counts for one ticker). The AI chat consumes vault AI
keys, so it stays off MCP per the module contract.

Educational screening for ideas to research — not financial advice.
