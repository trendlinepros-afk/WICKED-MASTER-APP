# Thumbnail Generator

YouTube thumbnails through the **Pikzels v2 API** (`https://api.pikzels.com`,
`X-Api-Key` from the WICKED vault — Settings → API Keys → **Pikzels**). Every
result is downloaded the moment Pikzels returns it, because Pikzels' output
links expire after ~24 h.

## What it exposes (all of the v2 API)

| Screen | Endpoint | Notes |
| --- | --- | --- |
| Create → From a prompt | `POST /v2/thumbnail/text` | prompt, model, format, optional persona / theme / reference image |
| Create → Recreate | `POST /v2/thumbnail/image` | a **YouTube watch link**, image URL or file; optional guiding prompt (PKZ 4+), image weight (PKZ 2 only), persona / theme / reference |
| Tools → Edit | `POST /v2/thumbnail/edit` | prompt + image, optional mask (white = change) and reference |
| Tools → Score | `POST /v2/thumbnail/score` | main score, sub-scores, suggestion; also from any result card |
| Tools → Titles | `POST /v2/title/text` | from a topic and/or a thumbnail |
| Library → New persona / theme | `POST /v2/pikzonality/persona` · `/style` | exactly **3 images** (files → base64, or YouTube thumbnail URLs); async, polled via `GET /v2/pikzonality/{id}` every 5 s; `PATCH` special instructions (with a local version history); `DELETE` |

- **Models**: PKZ 4.5 (default), PKZ 4, PKZ 3, PKZ 2. The selector greys out
  models the current options rule out — personas, themes and a guiding
  recreate prompt need PKZ 4/4.5; image weight exists only on PKZ 2 — and
  switches to PKZ 4.5 automatically when a persona/theme is picked
  (`lib/models.ts: modelRestriction`). Formats 16:9 / 9:16 / 1:1, 1–10 per batch
  with a concurrency setting.
- **Cost estimate** (top-right of Create): credits per thumbnail for the chosen
  model × batch size, plus $ when the plan price/credits are set in Settings.
  Pikzels only says "10–20 credits per thumbnail depending on the model", so the
  per-model figures default to 10/10/15/20 and are **editable**; whenever a
  response carries a credits figure (`ipc/pikzels.ts: creditInfo` scans body
  keys and headers) the model's price and the remaining balance are updated
  automatically. Training/score/title/edit prices are editable too.
- **Themes from a channel or video**: paste `youtube.com/@channel` (or a video
  link) → the channel's recent thumbnails are pulled from the public page
  (`ipc/youtube.ts`, no key; maxres → sd → hq fallback) → pick three → train.
  Personas from three face photos (files) or from thumbnails you appear in.
- **Downloads**: `<Downloads>/Thumbnail Generator/` (changeable), named
  `YYYY-MM-DD HHMM <prompt slug> vN.png`. Open / show-in-folder / score /
  recreate from every result card and from History.

## Personas & themes on every PC

Pikzels has no "list my personas" call, so the app keeps its own library:
`modules/thumbnail-generator/library.json` + three preview images per item
under `library/<id>/`. That folder is part of WICKED's module data, which
**Backup and Cloud Sync** carry to every machine — so a persona trained on one
PC shows up on the others after a sync. Anything trained elsewhere (another PC
before syncing, or the Pikzels web app) can be attached with **Library → Add
existing by id**; the id is verified with Pikzels. Deleting offers "remove here
only" vs "delete everywhere".

## Robustness

- 429/5xx retried with exponential backoff (respects `Retry-After`); 401/403
  and 402 (out of credits) surface as readable messages.
- The docs we could reach don't pin down whether base64 images should be bare
  or `data:` URIs; bare is sent first and a 4xx is retried once as data URIs.
- Training left in progress when the app closes resumes polling on next launch.
- `ipc/pikzels.ts`, `ipc/youtube.ts` and `lib/models.ts` have no Electron
  imports and are covered by headless tests with a mocked `fetch`.

## MCP

`thumbnail-generator__library`, `__history`, `__settings`,
`__youtube-thumbnails`, `__titles`, and confirm-gated `__generate` / `__train`
(they spend credits).
