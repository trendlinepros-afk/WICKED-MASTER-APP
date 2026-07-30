# Risk Calculator

A position-sizing / risk workbench in the **Stocks** folder. Four tabs, all pure
math (no market data needed), with your account size + risk % shared across the
top:

- **Position Size** — account, risk %, entry and stop → **shares to buy**, dollar
  risk, position cost, % of account, risk/share, and **1R/2R/3R target prices**.
  Warns when a position would exceed your account (needs margin).
- **Risk / Reward** — entry, stop, target → **R:R ratio**, the **win rate needed
  to break even**, and (with an optional win rate) the **expectancy in R**.
- **Options** — long call/put: capital at risk (**max loss = premium**),
  breakeven, % move to breakeven, intrinsic vs. extrinsic value, and the **max
  contracts** your risk budget covers.
- **Expectancy / Kelly** — win rate + average win/loss → per-trade **expectancy**,
  payoff ratio, **profit factor**, and the **Kelly / half-Kelly** fraction.

Your last-used inputs are saved (module store → included in Backup & Cloud Sync).

## Shared math

All calculations live in `calc.ts` (pure, no electron/react), imported by both
the UI (instant) and `ipc.ts`. The MCP tools delegate to the same handlers, so
the numbers can't drift.

## MCP

`risk-calculator__position-size`, `__risk-reward`, `__option` and `__expectancy`
— read-only calculators the AI Advisor (and any MCP client) can call to size a
trade or check an edge.

_Estimates for planning only — not financial advice._
