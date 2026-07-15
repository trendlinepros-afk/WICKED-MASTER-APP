import { spawnSync } from 'child_process'
import { logger } from './logger'
import type { Prereq } from '../../shared/types'

/**
 * Detects external prerequisites the app relies on. None are strictly required
 * to launch, but missing ones disable specific features, so on startup we tell
 * the user which are absent and how to install them.
 *
 *  - Ollama: required for local models (cloud APIs still work without it).
 *  - Node.js/npm: required only for running Node/Express projects in Live
 *    Preview; static/SPA previews and everything else work without it.
 */

/** Resolve a binary on PATH cross-platform. */
function onPath(binary: string): boolean {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    const res = spawnSync(finder, [binary], { windowsHide: true })
    return res.status === 0
  } catch (err) {
    logger.warn(`Prereq check failed for ${binary}`, err)
    return false
  }
}

export function checkPrereqs(): Prereq[] {
  return [
    {
      id: 'ollama',
      name: 'Ollama',
      installed: onPath('ollama'),
      impact: 'Required to run local models. Without it, only cloud API models are available.',
      downloadUrl: 'https://ollama.com/download'
    },
    {
      id: 'node',
      name: 'Node.js',
      installed: onPath('node') && onPath('npm'),
      impact: 'Required only to run Node/Express projects in Live Preview. Static and SPA previews work without it.',
      downloadUrl: 'https://nodejs.org/en/download'
    }
  ]
}

/** Prereqs that are absent — the ones worth notifying the user about. */
export function missingPrereqs(): Prereq[] {
  return checkPrereqs().filter((p) => !p.installed)
}
