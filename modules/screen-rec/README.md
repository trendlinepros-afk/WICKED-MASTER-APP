# ScreenRec

Hotkey screen recording for content sessions. Record as many clips as you like
from any app, then complete the session to get **one 1920×1080 MP4** with your
voice and an optional music track baked in.

## Flow

| You press | What happens |
| --- | --- |
| **Ctrl+R** (no default screen) | A picker covers every monitor: click one or press its number. The chosen area is outlined. |
| **R** | Recording starts (after the optional 3/5 s countdown). A small REC pill with a timer and mic meter sits at the top of that screen — hidden from the video. |
| **Ctrl+R** (default screen set) | Recording starts immediately on that screen — no picker, no R. |
| **Ctrl+R** while recording | Stops; the clip is added to the open session ("Clip 3 saved · 0:42"). |
| **Esc** | Cancels the picker / countdown. |

Open ScreenRec → **Complete session & render** → pick fps, fit/fill, quality,
an MP3 (or WAV/M4A/FLAC…) and its level in dB (remembered as your preset,
with Background/Noticeable/Loud presets, loop, fades and optional ducking under
your voice) → **Render video**. The session then closes; the next Ctrl+R starts
a new one.

## Settings

- **Hotkey** — any combination (click, press keys; the old one is paused while
  you choose). While enabled it is system-wide, so e.g. browsers no longer see
  Ctrl+R (F5 still refreshes).
- **Screen to record** — monitors drawn in their real layout; click one to make
  it the default, or "Ask me every time". *Identify* flashes each number.
- **What to capture** — screen without taskbar (default: the monitor's work
  area), entire screen, or a custom area drawn on a live screenshot (optionally
  locked to 16:9 so the video has no bars).
- **Audio** — microphone (live level meter), mic volume, noise reduction, and
  optionally computer sound mixed in.
- **Recording** — 30/60 fps, quality, countdown, REC pill.
- **Folders** — finished videos (`Videos\ScreenRec`) and raw clips
  (`Videos\ScreenRec\Raw clips\Session …`), both changeable.

Screen, microphone and custom-area choices are stored per PC
(`machine-<pc>.json`), because monitor and device ids differ between machines;
portable preferences (hotkey, fps, music preset…) are in `settings.json`.
Raw clips live outside WICKED's data, so Backup / Cloud Sync never carry
gigabytes of video.

## How it works

- **Shell services.** The hotkey comes from `ctx.registerGlobalShortcut`; the
  picker overlays, REC pill and the recorder are shell *helper windows*
  (`ctx.createHelperWindow`) built from the HTML in `ipc/pages.ts`. Overlays and
  the pill use `excludeFromCapture`. Plain keys (R, Esc, 1–9) are grabbed
  system-wide only while the picker is up.
- **Capture** (`recorderHtml`): Chromium desktop capture of the chosen monitor at
  native resolution + the microphone (+ loopback computer sound) mixed in
  WebAudio → MediaRecorder (H.264 when available, else VP9/VP8, Opus audio) in
  1 s chunks streamed to `Clip NNN.webm`. A crash or closing WICKED mid-clip
  loses at most a second; the clip is recovered on next launch.
- **Finishing a clip**: stream-copy remux to MKV (seekable, measurable), a
  cropped thumbnail, the measured length. The crop (taskbar / custom area) is
  stored per clip and applied at render time, so changing settings later never
  alters existing clips.
- **Render** (`lib/render-plan.ts`, `ipc/render.ts`): each clip → crop → scale
  to fit (or fill) 1920×1080 → constant frame rate (screen capture only emits
  frames on change) → exact clip length, audio padded/silence-filled → one
  x264 encode; segments are concatenated with the video stream-copied, then the
  voice (±dB) is mixed with the music (`volume=<dB>`, loop, fades,
  `sidechaincompress` ducking, limiter) → AAC → MP4 (`+faststart`). Clips
  recorded while a render runs roll into the next session.

Tested headless: geometry/hotkey helpers, the full render pipeline on real
MediaRecorder output (VFR, silent clips, crops, fit/fill, 30/60 fps, music
loop/duck), the recorder page's MediaRecorder/mixing/chunk protocol in
Chromium, and the main-process state machine with a mocked Electron.

## MCP

`screen-rec__status`, `__screens`, `__history` (read-only), `__record`
(confirm-gated when starting), `__render` and `__discard-session`
(confirm-gated, destructive).
