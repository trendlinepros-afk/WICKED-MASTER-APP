import { create } from 'zustand'
import type { JobProfileJson } from './types'

/* ====================================================================== *
 *  Flag catalog — ported 1:1 from FlagCatalog.cs / FlagDefinition.cs.
 *  The curated set of robocopy flags exposed in the UI, with plain-English
 *  explanations. Defaults reflect what nearly everyone wants: copy the
 *  whole tree, multithreaded, with sane retry behavior (robocopy's own
 *  defaults retry one million times, waiting 30 seconds each).
 * ====================================================================== */

export type FlagKind = 'toggle' | 'numeric' | 'text'

export interface FlagDefinition {
  /** The robocopy switch, e.g. "/E" or "/MT". */
  switch: string
  /** Short friendly name shown next to the checkbox. */
  title: string
  /** Plain-English explanation of what the flag does. */
  description: string
  kind: FlagKind
  /** Checked by default (the 99% case). */
  defaultOn?: boolean
  defaultNumber?: number
  minNumber?: number
  maxNumber?: number
  /** Watermark hint for text flags. */
  textHint?: string
  /** Text flag takes a single file path (gets a Browse button, /LOG-style formatting). */
  isFilePath?: boolean
  /** Deletes or moves data — warning styling plus run confirmation. */
  dangerous?: boolean
  /** Only works elevated; UI hints to run the job elevated. */
  needsAdmin?: boolean
  /** Flags sharing a group are mutually exclusive (checking one unchecks the rest). */
  exclusionGroup?: string
}

export interface FlagCategory {
  name: string
  /** lucide-react icon name (mapped to a component in index.tsx). */
  icon: string
  isDanger?: boolean
  flags: FlagDefinition[]
}

export const FLAG_CATEGORIES: FlagCategory[] = [
  {
    name: 'What to copy',
    icon: 'Copy',
    flags: [
      {
        switch: '/E',
        kind: 'toggle',
        defaultOn: true,
        exclusionGroup: 'subdirs',
        title: 'Copy subfolders, including empty ones',
        description:
          'Recreates the complete folder tree from the source. This is what most people want.'
      },
      {
        switch: '/S',
        kind: 'toggle',
        exclusionGroup: 'subdirs',
        title: 'Copy subfolders, but skip empty ones',
        description:
          'Same as above, except folders with nothing in them are not created in the destination.'
      },
      {
        switch: '/COPYALL',
        kind: 'toggle',
        needsAdmin: true,
        title: 'Copy everything about each file',
        description:
          'Also copies security permissions, owner and auditing info — not just the file contents and timestamps. Requires running as administrator.'
      },
      {
        switch: '/DCOPY:T',
        kind: 'toggle',
        title: 'Keep folder timestamps',
        description:
          "Folders in the destination keep the 'date modified' of the originals instead of showing the time of the copy."
      }
    ]
  },
  {
    name: 'Mirror & move',
    icon: 'ArrowLeftRight',
    isDanger: true,
    flags: [
      {
        switch: '/MIR',
        kind: 'toggle',
        dangerous: true,
        exclusionGroup: 'mode',
        title: 'Mirror: make the destination exactly match the source',
        description:
          'DELETES files and folders in the destination that no longer exist in the source. Great for backups — dangerous if you pick the wrong destination.'
      },
      {
        switch: '/MOVE',
        kind: 'toggle',
        dangerous: true,
        exclusionGroup: 'mode',
        title: 'Move everything instead of copying',
        description: 'Files AND folders are DELETED from the source after they are copied.'
      },
      {
        switch: '/MOV',
        kind: 'toggle',
        dangerous: true,
        exclusionGroup: 'mode',
        title: 'Move files only',
        description:
          'Files are DELETED from the source after copying; the empty folder structure stays behind.'
      }
    ]
  },
  {
    name: 'What to skip',
    icon: 'FilterX',
    flags: [
      {
        switch: '/XO',
        kind: 'toggle',
        title: "Don't overwrite newer files in the destination",
        description:
          'If a file in the destination was changed more recently than the source copy, it is left alone.'
      },
      {
        switch: '/XF',
        kind: 'text',
        textHint: 'e.g.  *.tmp *.bak thumbs.db',
        title: 'Skip files that match…',
        description:
          'Space-separated names or wildcards. Files matching any of them are not copied.'
      },
      {
        switch: '/XD',
        kind: 'text',
        textHint: 'e.g.  node_modules $RECYCLE.BIN',
        title: 'Skip folders that match…',
        description:
          'Space-separated names or wildcards. Folders matching any of them are ignored entirely.'
      }
    ]
  },
  {
    name: 'Speed & reliability',
    icon: 'Gauge',
    flags: [
      {
        switch: '/MT',
        kind: 'numeric',
        defaultOn: true,
        defaultNumber: 8,
        minNumber: 1,
        maxNumber: 128,
        title: 'Copy several files at the same time',
        description:
          'Uses multiple threads — dramatically faster when copying lots of small files. 8 is a good balance; go higher on fast disks and networks.'
      },
      {
        switch: '/R',
        kind: 'numeric',
        defaultOn: true,
        defaultNumber: 2,
        minNumber: 0,
        maxNumber: 1000000,
        title: 'Retries per failed file',
        description:
          "How many times to retry a file that fails to copy. Robocopy's own default is 1,000,000 — you don't want that."
      },
      {
        switch: '/W',
        kind: 'numeric',
        defaultOn: true,
        defaultNumber: 5,
        minNumber: 0,
        maxNumber: 3600,
        title: 'Seconds to wait between retries',
        description: "Robocopy's own default is 30 seconds, which makes failures painfully slow."
      },
      {
        switch: '/Z',
        kind: 'toggle',
        title: 'Restartable mode',
        description:
          'If a big file transfer is interrupted, it resumes where it left off instead of starting over. A little slower — best for large files over flaky networks.'
      },
      {
        switch: '/B',
        kind: 'toggle',
        needsAdmin: true,
        title: 'Backup mode',
        description:
          "Copies files even when you'd normally get 'Access denied', using Windows backup rights. Requires running as administrator."
      },
      {
        switch: '/J',
        kind: 'toggle',
        title: 'Unbuffered copying (huge files)',
        description:
          'Faster for very large files such as videos or disk images. Needs Windows 8 / Server 2012 or newer.'
      }
    ]
  },
  {
    name: 'Network & compatibility',
    icon: 'Globe',
    flags: [
      {
        switch: '/FFT',
        kind: 'toggle',
        title: 'Assume NAS-style timestamps',
        description:
          'Prevents endlessly re-copying unchanged files when the destination is a NAS, a Linux/Samba share, or a FAT-formatted drive (their clocks are less precise).'
      },
      {
        switch: '/DST',
        kind: 'toggle',
        title: 'Ignore daylight-saving differences',
        description: 'Treats files whose timestamps differ by exactly one hour as identical.'
      },
      {
        switch: '/XJ',
        kind: 'toggle',
        title: 'Skip junction points',
        description:
          'Avoids following Windows junctions/links, which can cause infinite loops in folders like C:\\Users.'
      }
    ]
  },
  {
    name: 'Report & logging',
    icon: 'FileText',
    flags: [
      {
        switch: '/LOG',
        kind: 'text',
        isFilePath: true,
        textHint: 'e.g.  C:\\Temp\\robocopy.log',
        title: 'Save a report file',
        description:
          'Writes a full report of everything robocopy did to this file. (/TEE is added automatically so you still see live output here.)'
      },
      {
        switch: '/V',
        kind: 'toggle',
        title: 'Extra detail (verbose)',
        description: 'The output also lists every skipped file and the reason it was skipped.'
      }
    ]
  }
]

export const ALL_FLAGS: FlagDefinition[] = FLAG_CATEGORIES.flatMap((c) => c.flags)

/* ====================================================================== *
 *  Command builder — ported 1:1 from CommandBuilder.cs.
 *  Handles the classic pitfalls: a quoted path with a trailing backslash
 *  ("C:\src\") makes the closing quote part of the argument, so trailing
 *  separators are stripped — except drive roots, where the backslash is
 *  doubled instead ("C:\\").
 * ====================================================================== */

export interface FlagSelection {
  def: FlagDefinition
  on: boolean
  /** Numeric value or free text, depending on kind. */
  value: string
}

/** Trims quotes/whitespace and trailing separators (keeping drive roots like C:\). */
export function normalizePath(path: string | null | undefined): string {
  let p = (path ?? '').trim()
  p = p.replace(/^"+/, '').replace(/"+$/, '').trim()
  if (p.length === 0) return p

  while (p.length > 0 && (p.endsWith('\\') || p.endsWith('/'))) p = p.slice(0, -1)

  // "C:" alone means "current directory on C:" to robocopy — restore the root slash.
  if (p.length === 2 && p[1] === ':') p += '\\'

  return p
}

/** Always quotes; doubles a trailing backslash so it can't escape the closing quote. */
export function quotePath(path: string | null | undefined): string {
  let p = path ?? ''
  if (p.endsWith('\\')) p += '\\'
  return '"' + p + '"'
}

function quoteToken(token: string): string {
  return token.includes(' ') ? '"' + token + '"' : token
}

/** Splits on spaces, honoring "quoted tokens with spaces". */
function tokenize(text: string): string[] {
  const out: string[] = []
  let current = ''
  let inQuotes = false
  for (const ch of text) {
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ' ' && !inQuotes) {
      if (current.length > 0) {
        out.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current.length > 0) out.push(current)
  return out
}

function buildFlagArgument(sel: FlagSelection): string | null {
  const def = sel.def
  switch (def.kind) {
    case 'toggle':
      return def.switch

    case 'numeric': {
      const trimmed = (sel.value ?? '').trim()
      // int.TryParse semantics: optional sign, digits only — otherwise the default.
      let n = /^[+-]?\d+$/.test(trimmed) ? parseInt(trimmed, 10) : (def.defaultNumber ?? 0)
      n = Math.max(def.minNumber ?? 0, Math.min(def.maxNumber ?? 1000000, n))
      return `${def.switch}:${n}`
    }

    case 'text': {
      const text = (sel.value ?? '').trim()
      if (text.length === 0) return null // nothing to do without a value

      if (def.isFilePath)
        return `${def.switch}:${quotePath(text.replace(/^"+/, '').replace(/"+$/, ''))}`

      const tokens = tokenize(text).map(quoteToken)
      return `${def.switch} ${tokens.join(' ')}`
    }
  }
}

export function buildArguments(
  source: string,
  destination: string,
  flags: readonly FlagSelection[],
  customFlags = '',
  dryRun = false
): string {
  const parts: string[] = [quotePath(normalizePath(source)), quotePath(normalizePath(destination))]

  let hasLog = false
  for (const f of flags) {
    if (!f.on) continue
    const arg = buildFlagArgument(f)
    if (!arg) continue
    parts.push(arg)
    if (f.def.switch.toUpperCase() === '/LOG') hasLog = true
  }

  // Keep live output visible in the app while logging to a file.
  if (hasLog) parts.push('/TEE')
  if (dryRun) parts.push('/L')

  const custom = customFlags.trim()
  if (custom.length > 0) parts.push(custom)

  return parts.join(' ')
}

/* ====================================================================== *
 *  Exit-code translator — ported 1:1 from ExitCodeTranslator.cs.
 *  Robocopy's exit code is a bitmask, not a normal error code:
 *  1 = files copied, 2 = extra files in destination, 4 = mismatches,
 *  8 = some files failed, 16 = fatal error. Anything below 8 is success.
 * ====================================================================== */

export type VerdictSeverity = 'success' | 'warning' | 'error'

export interface Verdict {
  severity: VerdictSeverity
  title: string
  details: string[]
}

export function translateExitCode(exitCode: number): Verdict {
  const v: Verdict = { severity: 'success', title: '', details: [] }

  if (exitCode < 0) {
    v.severity = 'warning'
    v.title = 'Cancelled — the copy was stopped before it finished.'
    return v
  }

  if (exitCode >= 16) {
    v.severity = 'error'
    v.title = 'Fatal error — robocopy could not run this job.'
    v.details.push(
      "Usually this means a path doesn't exist, is typed wrong, or you don't have permission to access it. Check the output above for details."
    )
    return v
  }

  if ((exitCode & 8) !== 0) {
    v.severity = 'error'
    v.title = 'Finished with failures — some files could NOT be copied.'
    v.details.push(
      'Files may have been locked by another program or blocked by permissions. Check the output above for lines marked ERROR.'
    )
  } else if ((exitCode & 4) !== 0) {
    v.severity = 'warning'
    v.title = 'Finished with warnings.'
  } else {
    v.severity = 'success'
    v.title =
      exitCode === 0
        ? 'Nothing to do — source and destination were already in sync.'
        : 'Success!'
  }

  if ((exitCode & 1) !== 0) v.details.push('Files were copied.')
  if ((exitCode & 2) !== 0)
    v.details.push(
      "The destination contains some extra files or folders that aren't in the source (nothing was deleted)."
    )
  if ((exitCode & 4) !== 0)
    v.details.push(
      'Some items in source and destination have the same name but different types (file vs. folder) — these were not touched.'
    )

  return v
}

/* ====================================================================== *
 *  Zustand store — job state + run state.
 * ====================================================================== */

export interface FlagState {
  on: boolean
  value: string
}

export function defaultFlagState(): Record<string, FlagState> {
  const out: Record<string, FlagState> = {}
  for (const def of ALL_FLAGS) {
    out[def.switch] = {
      on: def.defaultOn ?? false,
      value: def.kind === 'numeric' ? String(def.defaultNumber ?? 0) : ''
    }
  }
  return out
}

export interface RobocopyState {
  // job definition
  source: string
  destination: string
  customFlags: string
  flags: Record<string, FlagState>
  runElevated: boolean
  /** last-session restore already attempted (survives route remounts) */
  sessionRestored: boolean

  // run state
  running: boolean
  runIsDry: boolean
  startedAt: number | null
  finishedAt: number | null
  output: string
  filesCopied: number
  errors: number
  verdict: Verdict | null

  // actions
  setSource: (v: string) => void
  setDestination: (v: string) => void
  swapPaths: () => void
  setCustomFlags: (v: string) => void
  setRunElevated: (v: boolean) => void
  setFlagOn: (sw: string, on: boolean) => void
  setFlagValue: (sw: string, value: string) => void
  setSessionRestored: () => void
  setVerdict: (v: Verdict | null) => void
  collectProfile: () => JobProfileJson
  applyProfile: (profile: JobProfileJson) => void
  startRun: (args: string, dry: boolean) => void
  appendOutput: (lines: string[]) => void
  finishRun: (code: number) => void
}

export const useRobocopyStore = create<RobocopyState>()((set, get) => ({
  source: '',
  destination: '',
  customFlags: '',
  flags: defaultFlagState(),
  runElevated: false,
  sessionRestored: false,

  running: false,
  runIsDry: false,
  startedAt: null,
  finishedAt: null,
  output: '',
  filesCopied: 0,
  errors: 0,
  verdict: null,

  setSource: (v) => set({ source: v }),
  setDestination: (v) => set({ destination: v }),
  swapPaths: () => set((s) => ({ source: s.destination, destination: s.source })),
  setCustomFlags: (v) => set({ customFlags: v }),
  setRunElevated: (v) => set({ runElevated: v }),

  setFlagOn: (sw, on) =>
    set((s) => {
      const def = ALL_FLAGS.find((d) => d.switch === sw)
      if (!def) return s
      const flags = { ...s.flags, [sw]: { ...s.flags[sw], on } }
      // Flags sharing a group are mutually exclusive (checking one unchecks the rest).
      if (on && def.exclusionGroup) {
        for (const other of ALL_FLAGS) {
          if (other.switch !== sw && other.exclusionGroup === def.exclusionGroup)
            flags[other.switch] = { ...flags[other.switch], on: false }
        }
      }
      return { flags }
    }),

  setFlagValue: (sw, value) =>
    set((s) => ({ flags: { ...s.flags, [sw]: { ...s.flags[sw], value } } })),

  setSessionRestored: () => set({ sessionRestored: true }),
  setVerdict: (v) => set({ verdict: v }),

  // Same shape CollectProfile() produced in MainWindow.xaml.cs.
  collectProfile: () => {
    const s = get()
    const profile: JobProfileJson = {
      Source: s.source,
      Destination: s.destination,
      CustomFlags: s.customFlags,
      Flags: {}
    }
    for (const def of ALL_FLAGS) {
      const st = s.flags[def.switch]
      let value: string
      if (def.kind === 'numeric') {
        const trimmed = (st?.value ?? '').trim()
        value = /^[+-]?\d+$/.test(trimmed) ? String(parseInt(trimmed, 10)) : String(def.defaultNumber ?? 0)
      } else {
        value = st?.value ?? ''
      }
      profile.Flags![def.switch] = { On: st?.on ?? false, Value: value }
    }
    return profile
  },

  // Same semantics as ApplyProfile() in MainWindow.xaml.cs: only switches
  // present in the file are touched; unknown switches in the file are ignored.
  applyProfile: (profile) =>
    set((s) => {
      const flags = { ...s.flags }
      for (const def of ALL_FLAGS) {
        const setting = profile.Flags?.[def.switch]
        if (!setting) continue
        const prev = flags[def.switch]
        let value = prev?.value ?? ''
        if (def.kind === 'numeric') {
          const trimmed = (setting.Value ?? '').trim()
          if (/^[+-]?\d+$/.test(trimmed)) value = String(parseInt(trimmed, 10))
        } else if (def.kind === 'text') {
          value = setting.Value ?? ''
        }
        flags[def.switch] = { on: setting.On, value }
      }
      return {
        source: profile.Source ?? '',
        destination: profile.Destination ?? '',
        customFlags: profile.CustomFlags ?? '',
        flags
      }
    }),

  startRun: (args, dry) =>
    set({
      running: true,
      runIsDry: dry,
      startedAt: Date.now(),
      finishedAt: null,
      output: `> robocopy ${args}\n\n`,
      filesCopied: 0,
      errors: 0,
      verdict: null
    }),

  appendOutput: (lines) =>
    set((s) => {
      // Live counters, best-effort — same heuristics as RobocopyRunner.HandleLine.
      let filesCopied = s.filesCopied
      let errors = s.errors
      for (const line of lines) {
        const t = line.trimStart()
        if (
          t.startsWith('New File') ||
          t.startsWith('Newer') ||
          t.startsWith('Older') ||
          t.startsWith('Modified')
        ) {
          filesCopied++
        } else if (line.includes('ERROR')) {
          errors++
        }
      }
      let output = lines.length ? s.output + lines.join('\n') + '\n' : s.output
      // Keep the pane bounded so multi-hour jobs don't eat all memory.
      if (output.length > 2_000_000) output = output.slice(-1_000_000)
      return { output, filesCopied, errors }
    }),

  finishRun: (code) =>
    set((s) => {
      if (!s.running) return s
      const verdict = translateExitCode(code)
      if (s.runIsDry) verdict.title = 'Preview finished — nothing was copied. ' + verdict.title
      return { running: false, finishedAt: Date.now(), verdict }
    })
}))
