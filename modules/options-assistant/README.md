# Options Assistant

A chat assistant that finds the **single best options contract on your
watchlist** for the move you want. Tell it the direction (up → calls, down →
puts) and the expiration timeframe (zero-day, 2 days, a week, a month…), hit
**Find the trade**, and it:

1. pulls live quotes for every watchlist ticker through **your Webull
   OpenAPI**,
2. downloads each ticker's **near-the-money option chain** for every candidate
   expiry inside the window (calls or puts to match your direction, strikes
   clamped around spot),
3. grabs **live option quotes** (bid/ask/mid, spread, est. cost per contract),
4. layers in context per ticker — **next earnings date** (flagging earnings
   inside your window), **news headlines**, and **short-term trend** from the
   market-data feed,
5. hands the whole dossier to the AI, which ranks everything and returns **the
   pick** (with why / risks / entry note / confidence), runners-up, and the
   tickers it would avoid — or honestly says nothing is worth trading.

The result renders as a card in the chat; follow-up questions ("why not the
$230s?", "what's my exit if it gaps down?") go to the same assistant grounded
on the latest scan's data.

## Setup (Settings → API Keys)

- **Webull OpenAPI — App Key** and **App Secret** (required). Create them on
  the Webull site under *OpenAPI Management → App Management*; your market-data
  subscription must cover US stock + option quotes. Use **Test connection** in
  the header to verify instantly.
- **An AI key** (Anthropic / Gemini / DeepSeek / OpenAI) — required for the
  analysis and chat.
- **Massive/Polygon** (recommended — trend context) and **Finnhub**
  (recommended — earnings dates + news). Both optional; the scan degrades
  gracefully without them.

## Watchlist

Build it in the left rail (type tickers), or click **From Webull** to import a
watchlist you already built in the Webull app (uses the OpenAPI watchlist
endpoints). Capped at 25 tickers to keep scans fast and the analysis focused.

## How the Webull client works

`webull.ts` is a dependency-free signed HTTP client for the Webull OpenAPI —
a TypeScript port of the official SDK's HMAC-SHA256 signing (sorted
sign-params + percent-encoded string-to-sign, key = app secret + `&`, base64
signature in `x-signature`). All calls are GETs against `api.webull.com`;
responses are parsed defensively (field names vary between snake/camel case)
and OCC option symbols (`AAPL260522C00300000`) are decoded locally for
expiry/strike/type. Credentials come from the central vault and never leave
the main process.

Rate-limit friendly: snapshot calls are chunked (20 symbols max per request),
chain calls run through a 3-worker pool, and 429s get one automatic backoff
retry.

## MCP

- `options-assistant__status`, `__watchlist`, `__history` — read-only.
- `options-assistant__watchlist-add` / `__watchlist-remove`.
- `options-assistant__chain` — near-the-money chain for one ticker + window.
- The AI scan/chat consumes vault AI keys and stays **off** MCP per the module
  contract; agents can call `__chain` and reason over the raw data themselves.

## Notes

- Horizons count **market days** (weekends skipped; a "0 day" scan on Saturday
  means Monday's expiry). Long windows query near days + Fridays (capped at 6
  expiry dates per ticker).
- Everything the assistant says is analysis, not financial advice; options can
  go to zero.
