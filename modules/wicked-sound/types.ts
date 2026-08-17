/** Shared types for WICKED Sound — used by main (ipc), the renderer and mcp. */

/** The 10 graphic-EQ band centers (Hz) — classic ISO octave bands. */
export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const

export interface EqProfile {
  id: string
  name: string
  /** master gain in dB (negative headroom keeps boosted bands from clipping) */
  preampDb: number
  /** one gain per BANDS entry, dB (-12 … +12) */
  gains: number[]
  /** shipped profiles can't be deleted (edits clone them into a custom copy) */
  builtin?: boolean
  /** one-liner shown on the profile card (what the mix is for) */
  note?: string
}

export interface DeviceLink {
  /** substring Equalizer APO matches against the device name (e.g. "EDIFIER M60") */
  match: string
  /** the full renderer-side device label the link was made from */
  deviceLabel: string
  profileId: string
}

export interface SoundSettings {
  power: boolean
  activeProfileId: string
  /**
   * Which output the mix applies to: '' = System Default (all devices), else an
   * Equalizer APO device-match substring (see DeviceLink.match).
   */
  target: string
  /** human label for the picked target ('' = System Default) */
  targetLabel: string
  /** Auto mode: when the default output changes, apply that device's linked mix */
  auto: boolean
  profiles: EqProfile[]
  links: DeviceLink[]
}

export interface SoundStatus {
  ok: boolean
  /** Equalizer APO install detected (Program Files\EqualizerAPO) */
  engineInstalled: boolean
  /** the config folder exists and is writable without elevation */
  configWritable: boolean
  configPath: string | null
  hasGeminiKey: boolean
  settings: SoundSettings
  error?: string
}

export interface AiTuneResult {
  ok: boolean
  preampDb?: number
  gains?: number[]
  summary?: string
  provider?: string
  error?: string
}

/**
 * The user's own output devices — known make/model context handed to the AI
 * tuner and used to seed starter profiles, so tuning advice is specific to the
 * hardware actually in use.
 */
export const KNOWN_DEVICES: { match: string; name: string; kind: string; notes: string }[] = [
  {
    match: 'EDIFIER',
    name: 'Edifier M60',
    kind: '66 W powered desktop speakers',
    notes:
      'Compact near-field desktop speakers. Small cabinets: sub-bass below ~60 Hz rolls off, ' +
      'lower-mid (150–300 Hz) can sound boxy on a desk, treble is fairly smooth. ' +
      'Gentle low-shelf lift and a small 200–300 Hz cut usually helps.'
  },
  {
    match: 'DT 770',
    name: 'beyerdynamic DT 770 Pro',
    kind: 'closed-back studio headphones',
    notes:
      'Famed for a bright treble peak around 8 kHz that gets fatiguing — a -3 to -5 dB dip there ' +
      'is the classic fix. Bass is already elevated; mids are slightly recessed and enjoy a small ' +
      '1–3 kHz presence lift.'
  },
  {
    match: 'A40',
    name: 'Astro A40 (wireless)',
    kind: 'gaming headset',
    notes:
      'Open-ish gaming tuning: mid-bass emphasis and relaxed treble. For competitive play a ' +
      '2–6 kHz presence boost helps footsteps; for media, tame 100–200 Hz slightly and open the top end.'
  }
]

const flat = (): number[] => new Array(10).fill(0)

/** Shipped profiles. Gains are per BANDS: [31,62,125,250,500,1k,2k,4k,8k,16k]. */
export function builtinProfiles(): EqProfile[] {
  return [
    { id: 'flat', name: 'Flat', preampDb: 0, gains: flat(), builtin: true, note: 'Engine on, no coloration — the reference' },
    {
      id: 'youtube',
      name: 'YouTube',
      preampDb: -2,
      gains: [-2, -1, 0, 1, 1, 2, 3, 3, 1, 0],
      builtin: true,
      note: 'Voice clarity for talk videos — presence lift, rumble tamed'
    },
    {
      id: 'music',
      name: 'Music',
      preampDb: -3,
      gains: [3, 2, 1, 0, -1, 0, 1, 2, 2, 3],
      builtin: true,
      note: 'Gentle V — fuller lows and airy highs, mids untouched'
    },
    {
      id: 'movie',
      name: 'Movie',
      preampDb: -3,
      gains: [4, 3, 1, 0, 1, 2, 3, 2, 0, 1],
      builtin: true,
      note: 'Cinema — LFE weight plus dialog intelligibility'
    },
    {
      id: 'edifier-m60',
      name: 'Edifier M60',
      preampDb: -2,
      gains: [2, 3, 1, -2, -1, 0, 1, 1, 1, 2],
      builtin: true,
      note: 'Starter curve for the M60 desktop speakers'
    },
    {
      id: 'dt770',
      name: 'DT 770 Pro',
      preampDb: -1,
      gains: [0, 0, -1, 0, 0, 1, 2, 1, -4, -1],
      builtin: true,
      note: 'Starter curve — tames the 8 kHz beyerdynamic spike'
    },
    {
      id: 'astro-a40',
      name: 'Astro A40',
      preampDb: -2,
      gains: [1, 0, -1, -1, 0, 1, 3, 3, 1, 1],
      builtin: true,
      note: 'Starter curve — footstep presence, less mid-bass bloom'
    }
  ]
}

export function defaultSettings(): SoundSettings {
  return {
    power: false,
    activeProfileId: 'music',
    target: '',
    targetLabel: '',
    auto: false,
    profiles: builtinProfiles(),
    links: []
  }
}

export const clampGain = (n: number): number => Math.max(-12, Math.min(12, Math.round(n * 10) / 10))
export const clampPreamp = (n: number): number => Math.max(-20, Math.min(6, Math.round(n * 10) / 10))
