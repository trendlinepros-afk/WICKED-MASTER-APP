# WICKED Sound

FxSound-style **system-wide EQ** inside WICKED: mix profiles ("YouTube",
"Music", "Movie", …), a source selector with every output device plus System
Default, a power button that toggles the mix on/off instantly, a live wave, a
**Link** feature tying a make/model of output device to a mix, an **Auto**
mode that follows the Windows default output, and AI tuning.

## How it works (the engine)

User-mode apps cannot reshape audio that other programs play — that has to
happen inside the Windows audio pipeline. So, like FxSound ships a driver,
WICKED Sound drives **[Equalizer APO](https://sourceforge.net/projects/equalizerapo/)**
(free, open-source Audio Processing Object; one-time install + reboot, tick
your playback devices in its Configurator). The module then owns everything
above it by writing Equalizer APO's config files, which the engine hot-reloads
the moment they change:

- `config.txt` is replaced **once** with a marker + `Include: wicked-sound.txt`
  (the user's original is backed up into the module's data folder first —
  Settings → Modules shows the path).
- `wicked-sound.txt` is rewritten on every change: a `Device:` scope (the
  selected output, or `all` for System Default), `Preamp:` and a 10-band
  `GraphicEQ:` line. Power OFF writes a passthrough file — instant bypass.
- Writes go straight to disk when the config folder allows it (Equalizer APO's
  default). If the folder demands admin rights, the write retries once through
  an elevated PowerShell copy (per-action elevation, per the module contract).

## Features / quirks

- **Mixes**: built-ins (Flat / YouTube / Music / Movie + starter curves for the
  user's own hardware) come from code and can't be deleted; editing one clones
  it into a custom copy first. Slider edits debounce 500 ms before writing.
- **Effects levers** (FxSound-style, per-mix, each 0-10) → Equalizer APO DSP:
  **Bass Boost** = low shelf @110 Hz (≤ +9 dB); **Clarity** = high shelf
  @6.5 kHz (≤ +7 dB); **Dynamic Boost** = loudness contour (low shelf 70 Hz +
  high shelf 9.5 kHz + presence peak 2.5 kHz); **Ambience** = an early
  reflection — the opposite channel copied into a virtual channel, delayed
  14 ms, high-passed at 300 Hz and mixed back in quietly; **Surround Sound** =
  mid/side stereo widening via negative crossfeed (`Copy: L=a*L-b*R …`).
  A computed extra negative Preamp line pays for the worst-case boost so
  nothing clips. Ambience/Surround assume a stereo output. The AI tuner sets
  the levers too, not just the band gains.
- **Link**: pick a specific output, then "Link this output to <mix>". The link
  stores an Equalizer APO device-match token derived from the device label
  (e.g. `EDIFIER M60`).
- **Auto mode**: on default-output change (`devicechange`), a linked device
  gets its mix applied automatically; an *unlinked* device gets a starter mix
  calibrated once by AI, saved as `<device> (Auto)` and linked.
- **Known hardware**: Edifier M60 (66 W desktop speakers), beyerdynamic
  DT 770 Pro, Astro A40 wireless are described in `KNOWN_DEVICES` — their
  traits feed both the on-screen tuning tips and the AI prompts.
- **AI tuning uses GEMINI ONLY** (explicit user choice — cheaper). The shared
  `callAi` cascade is handed a key set with every other provider nulled; no
  Gemini key = the feature politely disables.
- **Live wave**: Windows loopback capture via the desktop capturer (the video
  track is required to start capture and stopped immediately); a WebAudio
  analyser draws the log-frequency spectrum with the active EQ curve overlaid.
  Analysis only — the stream is never routed to the speakers (no echo).
- Only ONE device scope is ever written to the engine (the current target).
  Links are metadata for Auto/UI — they don't stack extra filter sections,
  which keeps Equalizer APO's cumulative-section semantics from double-EQing.
- Settings/mixes/links live under the `wicked-sound.settings` key in
  `wicked-modules.json` → included in Backup & Cloud Sync. The Equalizer APO
  install itself is device-local (reinstall on a new PC).
