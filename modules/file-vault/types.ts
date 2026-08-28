/**
 * Shared shapes between the File Vault renderer and main process. Pure types
 * only — this file is compiled under BOTH tsconfig projects.
 */

/** One file stored in the "WICKED Vault" folder on the user's Google Drive. */
export interface VaultFile {
  id: string
  name: string
  /** bytes (0 for Google-native docs, which have no binary size) */
  size: number
  mimeType: string
  /** Drive's server-side MD5 of the content — used to verify every transfer */
  md5: string
  modifiedTime: string
  createdTime: string
  /** open-in-Drive link */
  webViewLink: string
}

export type TransferStatus = 'queued' | 'active' | 'verifying' | 'done' | 'error' | 'cancelled'

/** One upload/download in the transfer queue (lives in main; renderer mirrors it). */
export interface Transfer {
  id: string
  kind: 'upload' | 'download'
  /** file name shown in the panel */
  name: string
  /** local file being read (upload) or written (download) */
  localPath: string
  /** Drive file id (set after an upload completes; set from the start for downloads) */
  fileId?: string
  /** total bytes (0 until known) */
  size: number
  /** bytes transferred so far */
  done: number
  status: TransferStatus
  error?: string
  /** MD5 compared against Drive's after the transfer: true = intact */
  verified?: boolean
  /** upload replaced an existing same-named vault file (Drive keeps the old version ~30 days) */
  replaced?: boolean
  startedAt: number
  finishedAt?: number
  /** rolling bytes/second while active */
  bps: number
}

/** Connection state shown by the UI (never contains a secret). */
export interface VaultStatus {
  /** OAuth client id + secret have been saved */
  clientConfigured: boolean
  /** a Google account is connected (refresh token present) */
  connected: boolean
  /** connected Google account, e.g. you@yourbiz.com */
  email: string
  /** last characters of the saved client id, so the user can recognize it */
  clientIdTail: string
  /** OS-level secret encryption (DPAPI) available */
  encAvailable: boolean
  /** where downloads default to */
  downloadDir: string
}

/** Drive storage quota (from the about endpoint). */
export interface QuotaInfo {
  email: string
  /** bytes used across Drive */
  usage: number
  /** total bytes; 0 = unlimited/pooled plan */
  limit: number
}
