/**
 * Drag-and-drop path resolution.
 *
 * The standalone app resolved dropped Files to absolute paths through
 * Electron's webUtils.getPathForFile. The WICKED shell preload exposes the
 * same capability as window.wicked.getPathForFile; the legacy `File.path`
 * property is tried as a fallback for older runtimes.
 */

export const DROP_UNAVAILABLE =
  'Could not resolve the dropped files to paths — use the Import button instead.'

export function droppedPaths(e: React.DragEvent): string[] {
  return Array.from(e.dataTransfer.files)
    .map((f) => {
      try {
        const viaShell = window.wicked.getPathForFile?.(f)
        if (viaShell) return viaShell
      } catch {
        /* fall through to legacy property */
      }
      return (f as File & { path?: string }).path ?? ''
    })
    .filter(Boolean)
}
