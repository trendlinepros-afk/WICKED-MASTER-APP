/**
 * Shared shapes between the renderer (store.ts / index.tsx) and the main
 * process (ipc.ts). Keep this file free of runtime imports and DOM/Node
 * types — it is typechecked under both tsconfig.web.json and
 * tsconfig.node.json.
 */

/**
 * On-disk profile JSON. Field names are PascalCase to match what the C#
 * app's DataContractJsonSerializer wrote for `JobProfile`/`FlagSetting`
 * (ProfileStore.cs), so old `*.rcjob.json` files can be dropped into the
 * profiles folder unchanged — and profiles saved here load in the old app.
 */
export interface FlagSettingJson {
  On: boolean
  Value: string | null
}

export interface JobProfileJson {
  Source: string | null
  Destination: string | null
  CustomFlags: string | null
  Flags: Record<string, FlagSettingJson> | null
}

/** `robocopy-gui:probe` result (IsRobocopyAvailable equivalent). */
export interface ProbeResult {
  available: boolean
  path: string
  running: boolean
}

/** One saved profile in the profiles folder. */
export interface ProfileListEntry {
  /** display name (file name without `.rcjob.json`) */
  name: string
  /** file name inside the profiles folder (never a full path) */
  file: string
  modifiedMs: number
}

export interface OkResult {
  ok: boolean
  error?: string
}

export interface SaveProfileResult extends OkResult {
  file?: string
}

export interface LoadProfileResult extends OkResult {
  profile?: JobProfileJson
}

/** Payload of the `robocopy-gui:exit` webContents event. */
export interface ExitPayload {
  /** robocopy exit code; -1 = cancelled (same convention as the C# runner) */
  code: number
}
