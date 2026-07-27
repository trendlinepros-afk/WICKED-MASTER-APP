# Market News

The wickeddash dashboard news card as its own tool in the **Stocks** folder:
market-wide Finnhub headlines (general category), cached until the **6:00 AM
ET** news-day rollover, with an optional per-ticker filter (company news, last
30 days). Headlines open in the system browser.

Reuses the shared Finnhub client from `modules/stock-planner/ipc/market/` —
one client, one cache, no duplication. Needs the `finnhub` key
(Settings → API Keys); without it the tool explains what to add.
