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
- Runs on **Claude** via your central vault key. Add an **Anthropic** key in
  **Settings → API Keys**; without it the advisor shows a prompt to add one.

## Conversations

Previous chats are listed on the left; start new ones with **New chat**. They're
stored in the module store (`ai-advisor.conversations`), so they're **included in
Backup & Cloud Sync**.

## MCP

`mcp.ts` exposes read-only `ai-advisor__list-chats` and `ai-advisor__get-chat`.
The advisor's own chat is intentionally not on MCP (it already runs Claude with
the stocks tools).
