# Trendline Charts

Lives in the **Stocks** folder. Pulls finished **support/resistance trendline
chart images** from [TrendlineFinder](https://trendlinefinder.com)'s private
partner API and displays / saves them. It's an image tool — there are no data
feeds to parse; you pick a ticker and parameters and get a PNG with the
trendlines already drawn.

## Setup

Add your TrendlineFinder key (`tlf_live_…`) once in **Settings → API Keys**
(provider **TrendlineFinder**). The key is stored in the central vault, read
**only in the main process**, and never sent to the renderer or embedded in any
image request the UI can see. Use **Test connection** in the header to verify it
(`GET /health`).

## Using it

- **Ticker** — a US symbol (AAPL).
- **Horizons** — which trendline **pairs** (support + resistance) to draw:
  `30d` gold, `90d` blue, `6mo` green, `1y` red. The image auto-zooms to the
  **longest** horizon selected. Support lines are solid, resistance dashed.
- **Interval** — candle size (15m / 30m / 1h / 4h / 1d).
- **Size / footer** — image dimensions and whether the TrendlineFinder footer
  lockup is shown.

**Get chart** requests the PNG; **Save PNG** writes it to
`Downloads/Trendline Charts/` (works on any machine — it resolves the user's real
Downloads folder). Recent requests are remembered as one-click chips.

## Notes / quirks

- The API caches each unique parameter combination server-side for ~60s, so
  identical requests within a minute return the identical image — the tool
  doesn't poll faster than that.
- Errors are surfaced plainly: an invalid/revoked key (401) says so and is not
  retried in a loop; an unknown ticker (404) and bad parameters (400) report
  directly; a transient upstream failure (500) is retried once automatically.
- Colors, legend and line styles are fixed by the API — the tool only chooses
  which pairs are drawn and the framing.

## Data / MCP

- Saved charts: `<user>/Downloads/Trendline Charts/*.png` (surfaced in
  Settings → Modules).
- MCP: `trendline-charts__health` (verify a key) and `trendline-charts__chart`
  (fetch + save a chart, returns the file path, span days and horizons drawn).
  Both are **credential-gated** — the caller supplies the `tlf_live_…` key as
  `apiKey`; the tools never auto-use the stored vault key on the MCP path.

## Roadmap

Intended to eventually feed the **Stock Research** tool's *3 · Trendlines* step,
so report charts can be pulled automatically instead of pasted as screenshots.
For now it stands alone here in the Stocks folder.
