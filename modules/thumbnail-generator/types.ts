/**
 * Thumbnail Generator — shared types (main + renderer). Type-only.
 * Backed by the Pikzels v2 API (https://api.pikzels.com).
 */

export type Model = 'pkz_2' | 'pkz_3' | 'pkz_4' | 'pkz_4_5'
export type Format = '16:9' | '9:16' | '1:1'
export type ImageWeight = 'low' | 'medium' | 'high'
export type LibraryKind = 'persona' | 'style'
export type TrainStatus = 'processing' | 'completed' | 'failed'

export interface LibraryItem {
  /** Pikzels pikzonality id */
  id: string
  kind: LibraryKind
  name: string
  status: TrainStatus
  progress: number
  /** current special instructions (empty = none) */
  specialInstructions: string
  /** older instruction versions, newest first */
  instructionHistory: { at: number; text: string }[]
  /** preview file names under modules/thumbnail-generator/library/<id>/ */
  previews: string[]
  source: 'files' | 'youtube' | 'existing'
  sourceUrl: string
  createdAt: number
  updatedAt: number
  error: string
}

export interface ImageRef {
  /** local file (main reads it) */
  path?: string
  /** public URL (YouTube thumbnail etc.) */
  url?: string
  /** display only */
  label?: string
  /** data URL for the renderer preview */
  preview?: string
}

export interface GenerateRequest {
  mode: 'text' | 'image'
  prompt: string
  model: Model
  format: Format
  /** 1–10 variations */
  count: number
  /** image mode: a YouTube watch link, an image URL, or a local file */
  image?: ImageRef
  /** image mode, pkz_2 only */
  imageWeight?: ImageWeight
  /** reference image that guides the layout/subject */
  support?: ImageRef
  personaId?: string
  styleId?: string
}

export interface Score {
  main: number
  subscores: Record<string, number>
  suggestion: string
}

export interface Generated {
  id: string
  jobId: string
  index: number
  at: number
  kind: 'text' | 'image' | 'edit'
  prompt: string
  promptCompacted: string
  model: Model | string
  format: Format
  personaId: string
  styleId: string
  status: 'queued' | 'running' | 'done' | 'failed'
  /** absolute path of the downloaded file */
  file: string
  fileName: string
  /** Pikzels output URL (expires after ~24 h) */
  outputUrl: string
  requestId: string
  /** credits the API reported for this call, if it did */
  creditsUsed: number | null
  error: string
  score: Score | null
}

export interface Job {
  id: string
  at: number
  items: Generated[]
  /** all items finished (any status) */
  done: boolean
  cancelled: boolean
}

export interface TitleResult {
  outputs: string[]
  reasoning: string
  promptCompacted: string
}

export interface YtThumb {
  videoId: string
  title: string
  /** best-known working thumbnail URL */
  url: string
}

export interface YtLookup {
  kind: 'video' | 'channel'
  label: string
  items: YtThumb[]
}

export interface ModuleSettings {
  /** '' = <Downloads>/Thumbnail Generator */
  downloadDir: string
  /** credits charged per thumbnail by model (editable; learned from API responses when they report it) */
  creditsPerModel: Record<Model, number>
  creditsPersona: number
  creditsStyle: number
  creditsTitle: number
  creditsScore: number
  creditsEdit: number
  /** what you pay per month for `planCredits` credits (0 = unknown → no $ shown) */
  planPrice: number
  planCredits: number
  /** parallel generations */
  concurrency: number
  /** last credits-remaining figure the API reported, if any */
  creditsRemaining: number | null
}

export interface KeyStatus {
  hasKey: boolean
}
