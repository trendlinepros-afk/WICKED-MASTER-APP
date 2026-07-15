# CodeLens

Visual code intelligence for inherited codebases. Point it at any project folder and it:

- **Scans** the folder (gitignore-aware, plus built-in and custom ignore patterns; capped at
  8000 files / depth 16) and builds a file tree with language, size, line count, and a rough
  complexity score per file.
- **Maps dependencies** between files (JS/TS import/require/dynamic-import/re-export, Python
  imports, Go packages, C# namespaces, PHP include/use) and renders them as an interactive
  graph (@xyflow/react + dagre layout) colorable by file type, complexity, or findings.
- **Scans locally for risks** — hardcoded tokens/secrets/private keys, eval/exec, SQL built by
  concatenation or interpolation, XSS sinks, shell-injection patterns, weak hashes, insecure
  deserialization, plain-http URLs, and a few code-health heuristics. All offline, regex-based.
- **Explains code with AI** (optional): per-file explanations, connection summaries, finding
  walkthroughs, and a whole-project report, via Claude, OpenAI, Gemini, or DeepSeek
  (Gemini/DeepSeek ride the OpenAI-compatible endpoints). Works fully offline without a key —
  only the AI features need one.
- **Exports the project report** as Markdown or PDF (rendered in a hidden window and printed).

## Port notes (from standalone `codelens-desktop` v0.1.0)

- Source app: `X:\Coding\_Active Projects\CodeLens` (electron-vite, React 18, Tailwind).
  Renderer landed here nearly verbatim; main-process logic (`scanner`, `depgraph`, `vulnscan`,
  `ai`, `store`, `report`) moved to `ipc/` and is registered through `ipc.ts` `register(ctx)`.
- **IPC channels** renamed from the app's 14 originals to the `codelens:` namespace
  (`dialog:select-folder` → `codelens:select-folder`, `project:scan` → `codelens:scan`,
  `settings:get` → `codelens:settings-get`, `apikey:set` → `codelens:apikey-set`,
  `ai:explain-file` → `codelens:ai-explain-file`, `report:export` → `codelens:report-export`,
  etc. — full map in `shared/api.ts`). Handler logic is unchanged.
- The standalone preload exposed `window.codelens`; here `lib/bridge.ts` rebuilds the same
  typed API object (`codelensApi`) on top of `window.wicked.invoke`.
- **Persistence:** the module keeps its own `electron-store` file, `module-codelens.json`
  (provider/model choice, per-provider API keys, recent projects, custom ignores). API keys are
  encrypted with Electron `safeStorage` (Windows DPAPI); base64 fallback if unavailable. This
  store does not touch the shell's settings. A fresh install starts empty — keys/recents from
  the standalone app's `codelens.json` are **not** migrated.
- **Styling:** the app's custom dark-only `ink`/sky palette was remapped to the shell's theme
  tokens (`bg`/`surface`/`raised`/`edge`/`ink`/`muted`/`accent`/`danger`/`ok`/`warn`) so it
  follows both light and dark shell themes. React Flow chrome (controls, minimap, edges, dots)
  uses `--wk-*` CSS variables via `styles.css`, scoped under `.codelens-root`. Severity badges
  keep their fixed fg/bg pairs (self-contained, readable on both themes); standalone severity
  text uses new mid-tone colors.
- Removed: window creation/lifecycle, `setWindowOpenHandler`, titlebar/app icon assets
  (toolbar/welcome now use the lucide `Microscope` icon). The report-export PDF path still
  creates its own hidden `BrowserWindow` — that is a worker window, not app chrome.
- Quirks carried over: the scan holds one project in main-process memory at a time (the module
  is single-instance in the shell, so that's fine); AI calls re-read files from disk; graph
  hides isolated files by default and caps at 600 most-connected nodes; file preview truncates
  at 120k chars / 400 lines.
