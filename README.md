# WICKED

Unified Windows desktop suite — one Electron shell, eleven app modules.

## Stack

- Electron 35 + electron-vite 3 (main / preload / renderer)
- React 18.3 + TypeScript 5.7 + React Router 6
- Tailwind CSS 3.4 with CSS-variable theme tokens (light/dark/system)
- Zustand 5 for state, electron-store for persistence
- electron-updater + electron-builder (self-hosted feed now, GitHub Releases later —
  one-line switch in `electron-builder.yml`)

## Development

```
npm install
npm run dev        # electron-vite dev with HMR
npm run typecheck
npm run build:win  # NSIS installer into release/
```

## Modules

Modules live in `/modules/<id>/` and are auto-discovered at build time — see
[modules/README.md](modules/README.md) for the contract. Shell code is in `src/`
(`main`, `preload`, `renderer`, `shared`).

`_sources/` (git-ignored) holds clones of the original standalone apps during the
migration; see `docs/compatibility-report.md` for the cross-app dependency picture.
