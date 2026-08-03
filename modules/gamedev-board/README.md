# GameDev Project Board

Port of the standalone `GameDevHelper.html` (single-file vanilla-JS app launched via
an Edge `--app` kiosk window) to a React WICKED module.

Carried over 1:1:

- Folders → cards (title, notes, screenshots, checklist), newest cards first
- Paste a screenshot with Ctrl+V — lands on the last-clicked card, or creates a new
  card in the current folder; drag-drop and file-browse also work
- Work-session timer (persists across restarts via saved `timerStart`), session-note
  prompt on stop, Today/Total tallies
- Time log view: stats, inline-editable entries (date/start/end/note), manual "Add
  entry" (defaults to the last hour), cross-midnight durations handled
- Export/import JSON backup — **same format as the old app**, so existing
  `gamedevhelper-backup-*.json` files import directly (that's the data-migration
  path; IndexedDB from the old kiosk profile is isolated and can't be read directly)

Changed for WICKED:

- **The freeform canvas is the only board view — the card view is retired.** A
  folder opens as a canvas: click anywhere to start typing (an empty note you never
  fill in is discarded on blur), paste a screenshot with Ctrl+V and it lands exactly
  where you clicked, drag items by the grip, resize from the corner. Everything
  persists to IndexedDB (`canvasItems` store).
- Legacy card data is not shown anywhere, but old backups still import/export
  losslessly (card rows round-trip through the DB), and deleting a folder cleans up
  any legacy card rows it contained.
- Storage is the same IndexedDB schema (`gamedevhelper` v2) but now lives in the
  WICKED renderer profile
- The old in-app light/dark toggle is gone — the shell's theme applies
- Runtime favicon drawing dropped (shell owns the window)
