/**
 * WICKED brand assets, drawn from the same vector geometry as build/icon.png
 * (see the repo's icon: two sharp V glyphs — the right one a checkmark with a
 * diagonal-cut arm — a floating diamond, and a 4-point sparkle).
 */

const MARK_PATH =
  'M72.0 156.0L130.0 156.0L174.0 262.0L218.0 156.0L276.0 156.0L174.0 384.0Z ' +
  'M370.2 233.6L382.0 262.0L401.2 215.8L476.7 172.3L382.0 384.0L326.1 259.0Z ' +
  'M277.0 224.0L317.0 274.0L277.0 324.0L237.0 274.0Z ' +
  'M428.0 54.0L447.2 98.8L492.0 118.0L447.2 137.2L428.0 182.0L408.8 137.2L364.0 118.0L408.8 98.8Z'

/** The square app mark: black rounded tile with the white W + sparkle. */
export function BrandMark({ size = 32 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden className="shrink-0">
      <rect width="512" height="512" rx="118" fill="#0d0e12" />
      <path fill="#ffffff" d={MARK_PATH} />
    </svg>
  )
}

/** Mark + metallic WICKED wordmark — the in-app logo lockup (top-left nav). */
export function BrandLogo({ markSize = 30 }: { markSize?: number }): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <BrandMark size={markSize} />
      <span
        className="truncate bg-gradient-to-b from-zinc-600 via-zinc-800 to-black bg-clip-text text-[17px] font-black uppercase tracking-tight text-transparent dark:from-white dark:via-zinc-300 dark:to-zinc-500"
        style={{ fontStretch: 'condensed' }}
      >
        WICKED
      </span>
    </span>
  )
}
