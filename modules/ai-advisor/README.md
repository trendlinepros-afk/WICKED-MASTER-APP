# AI Advisor

An agentic AI chat in the **Stocks** folder. It's a trading co-pilot that can
**read everything in your Stocks tools** and reason about your trades, positions
and ideas with real data instead of guesses.

## What it can see

At every turn the advisor is handed the MCP tools of **every module in the Stocks
group** (it reuses each module's own handlers, so it always sees live data):

- **Trade Journal** — your imported Webull executions
- **Trade Log** — your hand-written journal entries
- **Trade Review** — single-day 1-minute candles
- **Stock Planner** — quotes, fundamentals, earnings, screeners, IPO calendar, compare
- **Market News** — market-wide and per-company headlines
- **Find Trades** — the live screener + backtest / graded outcomes
- **Advanced Charts** — setup/status

So "how did my NVDA trades do this month?", "is there news moving my watchlist?",
or "does this setup look good?" pull your actual journals, quotes, candles and
news before answering.

## Graphical

The advisor renders **charts inline** by emitting a ```` ```wicked-chart ```` code
block (intercepted before markdown):

- **Stock charts** — `{"kind":"candles","symbol":"NVDA","ymd":"2026-07-28"}`; the
  renderer fetches 1-minute candles (`trade-review:candles`) and draws a
  candlestick chart.
- **Archive stats** — `bar` / `line` / `pie` with inline `data:[{label,value}]`
  the model computes from your journals (e.g. P/L by symbol, by day, win/loss).

Charts are drawn as theme-aware inline SVG (no external chart library). The model
is told to visualize proactively when reviewing performance or a ticker's price.

The current model is shown in the header and by the composer.

## Paid X/Twitter — asks first

The Find Trades **X/Twitter** tools cost real money per use. The advisor *may*
use them, but **every X call pauses and asks you**:

> Using the X API costs real money (per-use billing). Is that OK?

Say **Yes** and it runs the call; say **No** and it answers without X and notes
the gap. Nothing X-related is spent without your click.

## Safe by design

- **Read-only.** Destructive tools (clearing the journal, deleting entries) and
  writes (create/update/import) are filtered out — the advisor can't place
  trades or modify your data. It advises; you act.
- **Pick your model** from the header dropdown to control cost:
  **Claude Sonnet** (best reasoning, priciest), **Claude Haiku** (~5× cheaper),
  **Gemini Flash** (cheapest, great for daily use) or **Gemini Pro**. All of them
  drive the same tools and emit the same inline charts. Your choice is saved.
- Needs the matching vault key for the selected model — an **Anthropic** key for
  the Claude models or a **Gemini** key for the Gemini models (**Settings → API
  Keys**). If the current model's key is missing, the header banner says so and
  you can switch models.
- **Cost readout**: each reply shows its tokens (in/out) and an estimated cost,
  and the header shows a running **Chat ~$** total for the conversation. Costs are
  estimates from published per-model rates (see `MODELS` in `ipc.ts`) — use them
  to compare models, not for exact billing.

## Conversations

Previous chats are listed on the left; start new ones with **New chat**. Hover a
chat for actions: **rename** (pencil), **archive** (tucks it into the collapsible
*Archived* dropdown at the bottom of the list), and **delete** (permanent, with a
confirm). They're stored in the module store (`ai-advisor.conversations`), so
they're **included in Backup & Cloud Sync**.

The chat text and column width **scale with the window** — on a large/maximized
screen the bubbles and font grow so the conversation isn't stuck tiny in a narrow
column.

## Export PDF

**Export PDF** (header, top-right) turns the current conversation into a
printable document saved to `Downloads/AI Advisor/` (revealed on save). It's
not a hand-drawn PDF: the transcript DOM is re-skinned with the app's own
stylesheet in **light theme** and printed through Chromium's real layout
engine (a hidden shell-owned window + `printToPDF`), so markdown **tables**,
the inline-SVG **charts** (bar/line/pie/candles), tool chips and per-reply
cost/model footers come out pixel-faithful — just on white, with page numbers
and sane page breaks (charts and table rows don't get sliced).

## MCP

`mcp.ts` exposes read-only `ai-advisor__list-chats` and `ai-advisor__get-chat`.
The advisor's own chat is intentionally not on MCP (it already runs Claude with
the stocks tools).
