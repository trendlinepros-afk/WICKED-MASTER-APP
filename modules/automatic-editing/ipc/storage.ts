/**
 * Folder layout for the user's master projects folder.
 *
 * The master folder (chosen at first run, or a default under the module's
 * data folder) holds two auto-created subfolders:
 *   - Projects/  — one folder per project (its work dir + project.json)
 *   - Assets/    — shared music, SFX, graphics, and logos the user drops in
 *
 * mkdir is idempotent, so "scan the folder and map to Projects/Assets if they
 * exist, otherwise create them" is exactly a recursive mkdir.
 */
import fs from 'fs'
import path from 'path'
import { moduleDataDir } from './paths'
import { getSettingsStore } from './settings'

export interface FolderLayout {
  master: string
  projects: string
  assets: string
}

/** The chosen master folder, or the default under the module data dir. */
export function masterDir(): string {
  const configured = getSettingsStore().getSettings().projectsDir
  return configured && configured.trim() ? path.resolve(configured) : moduleDataDir()
}

/** Ensure `master` holds a Projects/ and Assets/ subfolder. Idempotent: existing
 *  folders are mapped to, missing ones are created. Returns the resolved paths. */
export function ensureLayout(master: string): FolderLayout {
  const resolved = path.resolve(master)
  const projects = path.join(resolved, 'Projects')
  const assets = path.join(resolved, 'Assets')
  fs.mkdirSync(projects, { recursive: true })
  fs.mkdirSync(assets, { recursive: true })
  return { master: resolved, projects, assets }
}

/** Where individual project folders live: <master>/Projects. */
export function projectsRoot(): string {
  return ensureLayout(masterDir()).projects
}

/** Where shared assets live: <master>/Assets. */
export function assetsRoot(): string {
  return ensureLayout(masterDir()).assets
}
