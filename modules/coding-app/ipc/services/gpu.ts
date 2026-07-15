import { spawnSync } from 'child_process'
import { logger } from './logger'

/**
 * Best-effort detection of total GPU VRAM (GB). Tries, in order:
 *  1. `nvidia-smi` (accurate for NVIDIA GPUs, reports memory.total in MiB).
 *  2. On Windows, read `HardwareInformation.qwMemorySize` from the display
 *     adapter's registry key via PowerShell (works for AMD/Intel/NVIDIA).
 * Returns null if nothing worked, so the UI can ask the user to enter it.
 */
export function detectVramGb(): number | null {
  const nvidia = fromNvidiaSmi()
  if (nvidia != null) return nvidia
  if (process.platform === 'win32') {
    const reg = fromWindowsRegistry()
    if (reg != null) return reg
  }
  return null
}

function fromNvidiaSmi(): number | null {
  try {
    const r = spawnSync(
      'nvidia-smi',
      ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
      { windowsHide: true, encoding: 'utf-8', timeout: 8000 }
    )
    if (r.status !== 0 || !r.stdout) return null
    const valuesMiB = r.stdout
      .trim()
      .split('\n')
      .map((line) => parseInt(line.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0)
    if (!valuesMiB.length) return null
    // Use the largest GPU present. MiB -> GB, rounded to the nearest GB.
    const maxMiB = Math.max(...valuesMiB)
    return Math.round(maxMiB / 1024)
  } catch (err) {
    logger.warn('nvidia-smi VRAM detection failed', err)
    return null
  }
}

function fromWindowsRegistry(): number | null {
  try {
    const command =
      "(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\*' -ErrorAction SilentlyContinue " +
      "| Where-Object { $_.'HardwareInformation.qwMemorySize' } " +
      "| ForEach-Object { $_.'HardwareInformation.qwMemorySize' } " +
      '| Measure-Object -Maximum).Maximum'
    const r = spawnSync('powershell', ['-NoProfile', '-Command', command], {
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 8000
    })
    if (r.status !== 0 || !r.stdout) return null
    const bytes = parseInt(r.stdout.trim(), 10)
    if (!Number.isFinite(bytes) || bytes <= 0) return null
    return Math.round(bytes / 1024 ** 3)
  } catch (err) {
    logger.warn('Registry VRAM detection failed', err)
    return null
  }
}
