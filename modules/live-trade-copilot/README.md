# Live Trade Copilot

Watches your **TradingView chart window live** — Firefox, or any window/screen —
and calls **BUY / SELL / HOLD / WAIT** for 1–10 minute scalp holds, naming
technical patterns as they form.

## How a session works

1. **Pick window to watch** — a thumbnail grid of every open window (Electron
   `desktopCapturer`). Click your Firefox/TradingView window; the live preview
   renders inside WICKED.
2. Type the **ticker** on the chart, pick the check cadence (10/15/30/60s) and
   the model — **Fast (Haiku)** for cheap frequent checks or **Smart (Sonnet)**
   for deeper reads — and **Start watching**.
3. Every tick the renderer grabs ONE JPEG frame of the captured window and
   sends it to the main process, which blends it with **live Webull data**
   (hybrid engine): the day's 1-minute OHLCV bars *including the still-forming
   bar* (`real_time_required`), NBBO top-of-book, VWAP, day range, 20-bar SMA.
   The vision model is told to trust the **numbers** for exact prices and the
   **image** for indicators/drawings/structure.
4. The verdict renders as the big color banner (BUY green / SELL red / HOLD
   amber / WAIT gray) with confidence, bias, a one-liner and an exit hint, and
   every check lands in the **Callouts** feed: pattern chips
   (forming / confirmed / failed), support/resistance levels, and 2–3 sentences
   of reasoning. A rolling memory of the last 10 calls keeps the model
   consistent tick-to-tick (and it must explain flips).
5. **Position-aware**: toggle "I'm flat" / "I'm in @ $X" any time — when in a
   position the prompt weighs exit management first (HOLD = stay, SELL = exit
   NOW).
6. **Chime** (WebAudio, no assets): two rising notes when the call flips into
   BUY, two falling for SELL. Toggleable.

## Signal tracking & hypothetical P/L

Every flip **into BUY** marks a hypothetical **long entry** at that tick's live
price; a flip **into SELL** marks a **short entry**. The trade closes on the
**opposite flip**, a **10-minute timeout** (the max scalp hold), or **session
end** — whichever comes first — and the % gain/loss is computed (a falling
price on a short counts as a gain). Openings and closes appear in the feed
(`▶ long opened @217.45` / `✔ short closed +0.62% (flip)`). Vision-only ticks
(no live quote) record the signal "(no price)" and stay out of the stats.
Closed signals persist (`live-trade-copilot.signals`, newest 500).

## Pause / Resume

**Pause** (next to Stop) halts the checks but keeps everything — session
memory, open signal, feed. **Resume** continues where it left off. A paused
open signal past its 10-minute window closes on the first check after resume.
The 60-minute session cap counts wall-clock time, paused or not.

## Analytics

The **Analytics** button above the capture window switches the right panel to
the consolidated track record: signals / win rate / avg % / net cumulative % /
long-short split cards, a cumulative-% sparkline, per-pattern win rates, and
the recent-signals table. Works idle or mid-session (the capture keeps running
underneath).

## The Brain — transcripts & learning

- On every **Stop**, the full session is written as markdown into **The Brain
  vault**: `Notes/Live Trade Copilot/Sessions/<date> <ticker>.md` (signals
  table + complete verdict log). Browsable in The Brain, searchable via
  `the-brain__search`, and **included in Backup & Cloud Sync**.
- `Notes/Live Trade Copilot/Brain.md` holds the copilot's accumulated
  knowledge: a STATS section (recomputed every session from the signal store)
  and a LESSONS section — after each session that fired signals, a cheap AI
  review distills 2-4 dated bullet lessons (e.g. about whipsaw flips or
  unreliable patterns).
- **The learning loop closes at analysis time**: each check's prompt includes
  the track record digest (win rates overall/by side, best/worst patterns) and
  the latest lessons, so the copilot calibrates against its own history.

## Guard rails

- The prompt demands **equal priority for LONG and SHORT setups** (a breakout
  or VWAP reclaim is a BUY candidate exactly as a breakdown is a SELL) and has
  an explicit **anti-whipsaw rule**: never flip into a call you'd plausibly
  reverse within a minute — reversals within 2 checks must state what changed.

- WAIT is the model's default — it's instructed to only call BUY/SELL on
  concrete evidence and never to invent patterns.
- Hard **60-minute session cap**; **5 consecutive failures auto-pause**; closing
  the captured window auto-pauses with a "re-pick the window" callout (Resume
  keeps the session's memory).
- If Webull bars fail (no keys, bad ticker, rate limit) the tick **degrades to
  vision-only** with a visible warning — the session never dies over data.
- Costs shown are rough estimates (~$0.005/check Fast, ~$0.02 Smart).
- Analysis, not financial advice — the banner says so permanently.

## Quirks / implementation notes

- Capture uses the **legacy Electron path** (`chromeMediaSource: 'desktop'`
  getUserMedia constraints fed by a main-process `desktopCapturer` source id) —
  the app installs no display-media handler, and none is needed.
- Frames travel renderer→main via `invoke` only; the shell's
  `webContents.send` is mirrored to LAN web-server clients, so no frame data
  ever goes main→renderer.
- Webull wrappers (`getMinuteBars`, `getNbbo`) live in the shared client
  `modules/options-assistant/webull.ts`; field names are parsed tolerantly
  (string numerics, s/ms timestamps, nested `bars` arrays).
- Session summaries (ticker, duration, checks, signal count) persist in the
  module store (`live-trade-copilot.sessions`, newest 20).

## MCP

- `live-trade-copilot__status` — read-only session/verdict probe.
- `live-trade-copilot__analytics` — read-only track record (win rates, per
  pattern, recent signals). No AI tokens. The vision loop stays off MCP.
