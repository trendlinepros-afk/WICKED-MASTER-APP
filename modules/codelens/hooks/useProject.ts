import { useCallback, useState } from 'react'
import { codelensApi } from '../lib/bridge'
import type { ScanResult } from '../shared/types'

export interface ProjectState {
  scan: ScanResult | null
  scanning: boolean
  error: string | null
  openFolder(): Promise<void>
  scanPath(dir: string): Promise<void>
  rescan(): Promise<void>
  clearError(): void
}

export function useProject(onScanned?: () => void): ProjectState {
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scanPath = useCallback(
    async (dir: string) => {
      setScanning(true)
      setError(null)
      try {
        const res = await codelensApi.scanProject(dir)
        if (res.ok) {
          setScan(res.data)
          onScanned?.()
        } else {
          setError(res.error)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setScanning(false)
      }
    },
    [onScanned]
  )

  const openFolder = useCallback(async () => {
    const dir = await codelensApi.selectFolder()
    if (dir) await scanPath(dir)
  }, [scanPath])

  const rescan = useCallback(async () => {
    if (scan) await scanPath(scan.rootPath)
  }, [scan, scanPath])

  return { scan, scanning, error, openFolder, scanPath, rescan, clearError: () => setError(null) }
}
