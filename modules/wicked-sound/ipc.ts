import { spawn } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { callAi, type AiKeys, type AiMessage } from '../stock-planner/ipc/ai'
import {
  BANDS,
  KNOWN_DEVICES,
  builtinProfiles,
  clampFxLevel,
  clampGain,
  clampPreamp,
  defaultSettings,
  emptyFx,
  type AiTuneResult,
  type DeviceLink,
  type EqFx,
  type EqProfile,
  type SoundSettings,
  type SoundStatus
} from './types'

/* ------------------------------------------------------------------------ *
 *  WICKED SOUND — main process.
 *
 *  System-wide EQ can only happen inside the Windows audio pipeline, so the
 *  module drives Equalizer APO (the standard free, open-source Audio
 *  Processing Object) instead of pretending Electron could do it: WICKED owns
 *  the profiles, device links, Auto mode and AI tuning, and writes Equalizer
 *  APO's config files, which it hot-reloads the moment they change. Power off
 *  writes a passthrough config — instant bypass, nothing to uninstall.
 *
 *  File layout (inside <Program Files>\EqualizerAPO\config):
 *    config.txt        -> replaced ONCE with a marker + `Include: wicked-sound.txt`
 *                         (the user's original is backed up into our module dir)
 *    wicked-sound.txt  -> rewritten on every change: device scope + preamp +
 *                         GraphicEQ line for the active mix
 *
 *  Writes try the normal fs path first; when the config folder demands admin
 *  rights the write is retried once through an elevated PowerShell copy
 *  (Start-Process -Verb RunAs), per the suite's elevate-per-action rule.
 *
 *  AI tuning deliberately uses GEMINI ONLY (the user's explicit choice for
 *  this tool — cheap and plenty for EQ curves): the callAi cascade is handed a
 *  key set with every other provider nulled out.
 * ------------------------------------------------------------------------ */

const ID = 'wicked-sound'
const KEY = `${ID}.settings`
const MARKER = '# WICKED Sound — managed by the WICKED app'
const DOWNLOAD_URL = 'https://sourceforge.net/projects/equalizerapo/'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
}

function apoDir(): string {
  return join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'EqualizerAPO')
}
function apoConfigDir(): string {
  return join(apoDir(), 'config')
}
function engineInstalled(): boolean {
  return existsSync(apoConfigDir())
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/** The managed include file with the active mix (or passthrough). */
function buildMixFile(s: SoundSettings): string {
  const lines = [
    MARKER,
    '# Rewritten on every change from the WICKED Sound module — manual edits are lost.'
  ]
  if (!s.power) {
    lines.push('# Power is OFF — passthrough (no filters).')
    return lines.join('\r\n') + '\r\n'
  }
  const profile = s.profiles.find((p) => p.id === s.activeProfileId) ?? s.profiles[0]
  if (!profile) return lines.join('\r\n') + '\r\n'
  lines.push(s.target ? `Device: ${s.target}` : 'Device: all')
  lines.push(`Preamp: ${clampPreamp(profile.preampDb)} dB`)
  lines.push(`GraphicEQ: ${BANDS.map((f, i) => `${f} ${clampGain(profile.gains[i] ?? 0)}`).join('; ')}`)

  /* ---- FxSound-style effect levers (each 0-10) → Equalizer APO DSP ----
   * Bass Boost      low shelf @110 Hz, up to +9 dB
   * Clarity         high shelf @6.5 kHz, up to +7 dB
   * Dynamic Boost   loudness contour: low shelf @70 + high shelf @9.5k + presence peak
   * Ambience        early reflection: delayed (14 ms), high-passed copy of the
   *                 OPPOSITE channel mixed back in quietly (virtual channels)
   * Surround Sound  mid/side stereo width via negative crossfeed
   * An extra negative Preamp line pays for the worst-case boost so nothing clips. */
  const fx = { ...emptyFx(), ...(profile.fx ?? {}) }
  const bassDb = round1(fx.bass * 0.9)
  const clarityDb = round1(fx.clarity * 0.7)
  const dynLow = round1(fx.dynamic * 0.5)
  const dynHigh = round1(fx.dynamic * 0.4)
  const dynPres = round1(fx.dynamic * 0.2)
  const reflect = Math.round(fx.ambience * 3) / 100 // 0 .. 0.30
  const k = fx.surround * 0.06 // 0 .. 0.6
  const widenA = Math.round(((2 + k) / 2) * 1000) / 1000
  const widenB = Math.round((k / 2) * 1000) / 1000
  const widenDb = widenB > 0 ? 20 * Math.log10(widenA) : 0
  const headroom = round1(Math.max(bassDb, clarityDb, dynLow + dynPres) + widenDb + (reflect > 0 ? 1.5 : 0))
  if (bassDb > 0 || clarityDb > 0 || dynLow > 0 || reflect > 0 || widenB > 0) {
    lines.push('# Effects (Bass Boost / Clarity / Dynamic Boost / Ambience / Surround)')
    if (headroom > 0) lines.push(`Preamp: -${headroom} dB`)
    if (bassDb > 0) lines.push(`Filter: ON LSC Fc 110 Hz Gain ${bassDb} dB`)
    if (clarityDb > 0) lines.push(`Filter: ON HSC Fc 6500 Hz Gain ${clarityDb} dB`)
    if (dynLow > 0) {
      lines.push(`Filter: ON LSC Fc 70 Hz Gain ${dynLow} dB`)
      lines.push(`Filter: ON HSC Fc 9500 Hz Gain ${dynHigh} dB`)
      lines.push(`Filter: ON PK Fc 2500 Hz Gain ${dynPres} dB Q 1`)
    }
    if (reflect > 0) {
      lines.push('Copy: AMBL=L AMBR=R')
      lines.push('Channel: AMBL AMBR')
      lines.push('Delay: 14 ms')
      lines.push('Filter: ON HP Fc 300 Hz')
      lines.push('Channel: all')
      lines.push(`Copy: L=L+${reflect}*AMBR R=R+${reflect}*AMBL`)
    }
    if (widenB > 0) lines.push(`Copy: L=${widenA}*L-${widenB}*R R=${widenA}*R-${widenB}*L`)
  }
  return lines.join('\r\n') + '\r\n'
}

function buildConfigTxt(): string {
  return (
    [
      MARKER,
      '# Your previous config.txt was backed up into the WICKED data folder',
      '# (Settings -> Modules -> WICKED Sound shows the exact path).',
      'Include: wicked-sound.txt'
    ].join('\r\n') + '\r\n'
  )
}

/**
 * Copy files with admin rights via UAC. Runs an unelevated PowerShell that
 * Start-Process-es an elevated copy and reports its exit code (1223 = the UAC
 * prompt was declined).
 */
function elevatedCopy(pairs: { from: string; to: string }[]): Promise<{ ok: boolean; error?: string }> {
  const q = (p: string): string => p.replace(/'/g, "''")
  const inner = pairs.map((p) => `Copy-Item -LiteralPath '${q(p.from)}' -Destination '${q(p.to)}' -Force`).join('; ')
  const launcher =
    `try { $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-Command','${inner.replace(/'/g, "''")}') -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 1223 }`
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launcher], { windowsHide: true })
    } catch (err) {
      resolve({ ok: false, error: 'Could not start PowerShell: ' + errMsg(err) })
      return
    }
    child.on('error', (err) => resolve({ ok: false, error: errMsg(err) }))
    child.on('close', (code) =>
      resolve(
        code === 0
          ? { ok: true }
          : { ok: false, error: code === 1223 ? 'The admin prompt was cancelled.' : `Elevated copy failed (code ${code}).` }
      )
    )
  })
}

export default function register(ctx: ModuleIpcContext): void {
  const moduleDir = (): string => join(ctx.app.getPath('userData'), 'modules', ID)
  const backupFile = (): string => join(moduleDir(), 'config-backup.txt')

  const readSettings = (): SoundSettings => {
    const d = defaultSettings()
    const raw = ctx.storeGet<Partial<SoundSettings>>(KEY, {})
    const custom = Array.isArray(raw.profiles) ? raw.profiles.filter((p) => p && !p.builtin) : []
    const s: SoundSettings = {
      ...d,
      ...raw,
      // builtins always come from code (shipped tweaks propagate); customs persist
      profiles: [...builtinProfiles(), ...custom],
      links: Array.isArray(raw.links) ? raw.links : []
    }
    if (!s.profiles.some((p) => p.id === s.activeProfileId)) s.activeProfileId = 'music'
    return s
  }
  const writeSettings = (s: SoundSettings): void => ctx.storeSet(KEY, s)

  const configWritable = (): boolean => {
    if (!engineInstalled()) return false
    try {
      const probe = join(apoConfigDir(), '.wicked-probe')
      writeFileSync(probe, 'x')
      unlinkSync(probe)
      return true
    } catch {
      return false
    }
  }

  /** Push the current settings into Equalizer APO's config files. */
  const applyToEngine = async (s: SoundSettings): Promise<{ ok: boolean; error?: string }> => {
    if (!engineInstalled())
      return { ok: false, error: 'Equalizer APO is not installed yet — use "Install the engine" below.' }
    const cfgDir = apoConfigDir()
    const configTxt = join(cfgDir, 'config.txt')
    const mixTxt = join(cfgDir, 'wicked-sound.txt')

    // One-time: preserve whatever config the user had before WICKED took over.
    try {
      if (existsSync(configTxt) && !existsSync(backupFile())) {
        const cur = readFileSync(configTxt, 'utf8')
        if (!cur.includes(MARKER)) {
          mkdirSync(moduleDir(), { recursive: true })
          copyFileSync(configTxt, backupFile())
        }
      }
    } catch {
      /* backup is best-effort — never blocks applying */
    }

    const writes: { path: string; content: string }[] = [{ path: mixTxt, content: buildMixFile(s) }]
    let needConfigTxt = true
    try {
      needConfigTxt = !existsSync(configTxt) || !readFileSync(configTxt, 'utf8').includes(MARKER)
    } catch {
      needConfigTxt = true
    }
    if (needConfigTxt) writes.push({ path: configTxt, content: buildConfigTxt() })

    try {
      for (const w of writes) writeFileSync(w.path, w.content, 'utf8')
      return { ok: true }
    } catch {
      // Config folder wants admin rights → one elevated copy for all files.
      const tmpDir = ctx.app.getPath('temp')
      const pairs: { from: string; to: string }[] = []
      try {
        for (const w of writes) {
          const tmp = join(tmpDir, `wicked-sound-${Date.now()}-${pairs.length}.txt`)
          writeFileSync(tmp, w.content, 'utf8')
          pairs.push({ from: tmp, to: w.path })
        }
      } catch (err) {
        return { ok: false, error: 'Could not stage the config write: ' + errMsg(err) }
      }
      const res = await elevatedCopy(pairs)
      for (const p of pairs) {
        try {
          unlinkSync(p.from)
        } catch {
          /* temp cleanup only */
        }
      }
      return res
    }
  }

  const status = (): SoundStatus => ({
    ok: true,
    engineInstalled: engineInstalled(),
    configWritable: configWritable(),
    configPath: engineInstalled() ? join(apoConfigDir(), 'config.txt') : null,
    hasGeminiKey: !!ctx.getApiKey('gemini'),
    settings: readSettings()
  })

  ctx.ipcMain.handle(`${ID}:status`, () => status())

  ctx.ipcMain.handle(`${ID}:open-download`, async () => {
    await ctx.shell.openExternal(DOWNLOAD_URL)
    return { ok: true }
  })

  /** Patch power/active-profile/target/auto and push the result to the engine. */
  ctx.ipcMain.handle(`${ID}:set`, async (_e, raw: unknown) => {
    const r = asRecord(raw)
    const s = readSettings()
    if (typeof r.power === 'boolean') s.power = r.power
    if (typeof r.activeProfileId === 'string' && s.profiles.some((p) => p.id === r.activeProfileId))
      s.activeProfileId = r.activeProfileId
    if (typeof r.target === 'string') s.target = r.target.slice(0, 120)
    if (typeof r.targetLabel === 'string') s.targetLabel = r.targetLabel.slice(0, 160)
    if (typeof r.auto === 'boolean') s.auto = r.auto
    writeSettings(s)
    // Metadata-only changes (e.g. toggling Auto) save fine without the engine;
    // only actually turning a mix ON needs Equalizer APO present.
    const applied = engineInstalled()
      ? await applyToEngine(s)
      : s.power && (typeof r.power === 'boolean' || typeof r.activeProfileId === 'string')
        ? { ok: false as const, error: 'Equalizer APO is not installed yet — use "Install the engine" first.' }
        : { ok: true as const }
    return { ok: applied.ok, error: 'error' in applied ? applied.error : undefined, status: status() }
  })

  ctx.ipcMain.handle(`${ID}:profile-upsert`, async (_e, raw: unknown) => {
    const r = asRecord(raw)
    const s = readSettings()
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim().slice(0, 60) : `custom-${Date.now().toString(36)}`
    if (s.profiles.some((p) => p.id === id && p.builtin))
      return { ok: false, error: 'Built-in mixes cannot be edited directly — they are cloned into a custom copy first.' }
    const gains = Array.isArray(r.gains) ? r.gains.slice(0, 10).map((g) => clampGain(Number(g) || 0)) : []
    while (gains.length < 10) gains.push(0)
    const rawFx = asRecord(r.fx)
    const fx: EqFx = {
      bass: clampFxLevel(Number(rawFx.bass) || 0),
      clarity: clampFxLevel(Number(rawFx.clarity) || 0),
      ambience: clampFxLevel(Number(rawFx.ambience) || 0),
      surround: clampFxLevel(Number(rawFx.surround) || 0),
      dynamic: clampFxLevel(Number(rawFx.dynamic) || 0)
    }
    const profile: EqProfile = {
      id,
      name: (typeof r.name === 'string' && r.name.trim() ? r.name.trim() : 'Custom mix').slice(0, 60),
      preampDb: clampPreamp(Number(r.preampDb) || 0),
      gains,
      fx,
      note: typeof r.note === 'string' ? r.note.slice(0, 200) : undefined
    }
    const i = s.profiles.findIndex((p) => p.id === id)
    if (i === -1) s.profiles.push(profile)
    else s.profiles[i] = profile
    writeSettings(s)
    const applied = s.activeProfileId === id ? await applyToEngine(s) : { ok: true as const }
    return { ok: applied.ok, error: 'error' in applied ? applied.error : undefined, profile, status: status() }
  })

  ctx.ipcMain.handle(`${ID}:profile-delete`, async (_e, raw: unknown) => {
    const id = String(asRecord(raw).id ?? '')
    const s = readSettings()
    const p = s.profiles.find((x) => x.id === id)
    if (!p) return { ok: false, error: 'Mix not found.' }
    if (p.builtin) return { ok: false, error: 'Built-in mixes cannot be deleted.' }
    s.profiles = s.profiles.filter((x) => x.id !== id)
    s.links = s.links.filter((l) => l.profileId !== id)
    if (s.activeProfileId === id) s.activeProfileId = 'flat'
    writeSettings(s)
    const applied = await applyToEngine(s)
    return { ok: applied.ok, error: applied.error, status: status() }
  })

  ctx.ipcMain.handle(`${ID}:link-set`, (_e, raw: unknown) => {
    const r = asRecord(raw)
    const match = String(r.match ?? '').trim().slice(0, 120)
    const profileId = String(r.profileId ?? '')
    const s = readSettings()
    if (!match) return { ok: false, error: 'No device to link.' }
    if (!s.profiles.some((p) => p.id === profileId)) return { ok: false, error: 'Mix not found.' }
    const link: DeviceLink = { match, deviceLabel: String(r.deviceLabel ?? match).slice(0, 160), profileId }
    s.links = [...s.links.filter((l) => l.match.toUpperCase() !== match.toUpperCase()), link]
    writeSettings(s)
    return { ok: true, status: status() }
  })

  ctx.ipcMain.handle(`${ID}:link-remove`, (_e, raw: unknown) => {
    const match = String(asRecord(raw).match ?? '')
    const s = readSettings()
    s.links = s.links.filter((l) => l.match.toUpperCase() !== match.toUpperCase())
    writeSettings(s)
    return { ok: true, status: status() }
  })

  /* ------------------------------ AI tuning ------------------------------- */

  let aiBusy = false

  ctx.ipcMain.handle(`${ID}:ai-tune`, async (_e, raw: unknown): Promise<AiTuneResult> => {
    const r = asRecord(raw)
    const deviceLabel = String(r.deviceLabel ?? '').slice(0, 160)
    const goal = String(r.goal ?? '').slice(0, 500)
    const baseId = typeof r.profileId === 'string' ? r.profileId : ''
    // Gemini ONLY for this tool — every other provider is nulled out on purpose.
    const keys: AiKeys = { anthropic: null, gemini: ctx.getApiKey('gemini'), deepseek: null, openai: null }
    if (!keys.gemini) return { ok: false, error: 'Add your Gemini key in Settings → API Keys to use AI tuning.' }
    if (aiBusy) return { ok: false, error: 'An AI tune is already running.' }
    aiBusy = true
    try {
      const s = readSettings()
      const base = s.profiles.find((p) => p.id === baseId)
      const known = KNOWN_DEVICES.find((d) => deviceLabel.toUpperCase().includes(d.match.toUpperCase()))
      const messages: AiMessage[] = [
        {
          role: 'system',
          text:
            'You are a veteran audio engineer tuning a 10-band graphic EQ plus five effect levers. Bands (Hz): ' +
            BANDS.join(', ') +
            '. Gains are dB in [-12, 12]; preampDb in [-20, 6] and should offset the largest boost to avoid clipping. ' +
            'Prefer gentle, musical moves (most bands within ±4 dB). The effect levers are each 0-10: ' +
            'bass (low-shelf weight), clarity (treble shelf/air), ambience (subtle early reflections), ' +
            'surround (stereo width — keep low on headphones with strong crossfeed needs), dynamic (loudness contour punch). ' +
            'Return ONLY JSON: {"preampDb": number, "gains": [10 numbers], ' +
            '"fx": {"bass": 0-10, "clarity": 0-10, "ambience": 0-10, "surround": 0-10, "dynamic": 0-10}, ' +
            '"summary": "1-2 sentences on what you did and one tip"}.'
        },
        {
          role: 'user',
          text:
            `Output device: ${deviceLabel || 'unknown'}\n` +
            (known ? `Known hardware: ${known.name} (${known.kind}). Traits: ${known.notes}\n` : '') +
            (base
              ? `Starting curve "${base.name}": preamp ${base.preampDb} dB, gains [${base.gains.join(', ')}], fx ${JSON.stringify(
                  { ...emptyFx(), ...(base.fx ?? {}) }
                )}\n`
              : '') +
            `Goal: ${goal || 'Tune this device to sound its best for general listening.'}`
        }
      ]
      const res = await callAi(keys, messages, { json: true })
      if (!res.ok) return { ok: false, error: res.error }
      let parsed: unknown
      try {
        parsed = JSON.parse(res.text.replace(/```(?:json)?|```/g, '').trim())
      } catch {
        return { ok: false, error: 'The AI returned unreadable data — try again.' }
      }
      const o = asRecord(parsed)
      const gains = Array.isArray(o.gains) ? o.gains.slice(0, 10).map((g) => clampGain(Number(g) || 0)) : []
      if (gains.length !== 10) return { ok: false, error: 'The AI did not return 10 band gains — try again.' }
      const ofx = asRecord(o.fx)
      return {
        ok: true,
        preampDb: clampPreamp(Number(o.preampDb) || 0),
        gains,
        fx: {
          bass: clampFxLevel(Number(ofx.bass) || 0),
          clarity: clampFxLevel(Number(ofx.clarity) || 0),
          ambience: clampFxLevel(Number(ofx.ambience) || 0),
          surround: clampFxLevel(Number(ofx.surround) || 0),
          dynamic: clampFxLevel(Number(ofx.dynamic) || 0)
        },
        summary: typeof o.summary === 'string' ? o.summary.slice(0, 400) : '',
        provider: res.provider
      }
    } finally {
      aiBusy = false
    }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => [
    {
      label: 'Equalizer APO config',
      path: engineInstalled() ? join(apoConfigDir(), 'config.txt') : null,
      note: 'The audio engine WICKED Sound drives. Device-local — reinstall Equalizer APO on a new PC.'
    },
    {
      label: 'Original config backup',
      path: existsSync(backupFile()) ? backupFile() : null,
      note: 'Your pre-WICKED config.txt, saved before the module first took over.'
    },
    {
      label: 'Mixes, links & settings',
      path: null,
      note: 'Stored under the "wicked-sound.settings" key in wicked-modules.json. Included in Backup & Cloud Sync.'
    }
  ])
}
