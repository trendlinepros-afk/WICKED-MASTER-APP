# Finance Tracker

Lives in the **Finance** folder. Import your **credit-card statements (CSV)** and
get a picture of where the money goes: auto-categorized spending, a transactions
ledger you can correct, and automatic **subscription detection** — across
**multiple card accounts**.

## Importing

Download a statement as **CSV** from your card's website, then **Import CSV** (or
drag the file onto the window). The parser auto-detects the common bank export
shapes (Chase, Amex, Capital One, Discover, Citi, BofA…):

- Finds the header row and its date / description / amount (or debit+credit) columns.
- Normalizes the sign convention so **charges are positive**; credits, refunds and
  card **payments** are negative (payments are categorized `Payments & Credits` and
  excluded from spending analytics).
- **De-duplication**: every row gets a content hash (date + description + amount
  + a per-file ordinal so two identical same-day charges both survive). Re-importing
  overlapping statements never double-counts. PDFs aren't supported — use your
  bank's CSV export.

## Accounts

**Accounts** (top right): create one per credit card, rename, delete (deleting an
account removes its transactions; learned rules are kept). The header dropdown
switches between **All accounts** and a single card; imports land in the selected
account (or the first one when "All" is selected).

## Categories & the learning loop

Each transaction is auto-categorized by merchant keywords into ~14 buckets
(Groceries, Dining & Drinks, Gas & Auto, Streaming & Software, Bills & Utilities…).
On the **Transactions** tab you can, per row:

- **Rename** it (click the name),
- change its **Category** (dropdown),
- check/uncheck the **Sub** box.

Every edit is saved as a **merchant rule** (keyed by the normalized merchant), so:

1. it's **propagated** to that merchant's other rows you haven't individually edited, and
2. **every future import applies it automatically** — next month's statement comes
   in already renamed, categorized and sub-flagged the way you taught it.

## Subscriptions

Flagged two ways on import: **known merchants** (Netflix, Spotify, iCloud, gyms…)
and a **recurrence detector** (≥2 similar-amount charges on a weekly / monthly /
quarterly / annual cadence). The **Subscriptions** tab groups them by merchant with
last charge, cadence and **estimated monthly cost** (annual plans are divided by 12),
plus the total per month. Unchecking one there un-flags the merchant everywhere and
is remembered (it won't be re-flagged on future imports).

## Data / MCP

- Data: `%APPDATA%/WICKED-Suite/modules/finance-tracker/finance.db` (SQLite —
  transactions, accounts, merchant rules). Included in Backup & Cloud Sync.
- MCP: `finance-tracker__accounts`, `__spending` (by category, optional month),
  `__subscriptions`, `__transactions` (read-only); `__import` (by path, additive);
  `__clear` (destructive, confirm-gated).
