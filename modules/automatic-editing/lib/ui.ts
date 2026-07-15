/**
 * Shared className constants — the standalone app used Tailwind component
 * classes (@apply in its own stylesheet) with a custom palette (ink-*, signal,
 * cut, warn, graphic, music). The WICKED shell owns the stylesheet, so those
 * become constants here, mapped onto the shell's flat theme tokens:
 *
 *   bg / surface / raised / edge / ink / muted / accent / accent-ink /
 *   danger / ok / warn
 *
 * Mapping: ink-950→bg, ink-900→surface, ink-850/800→raised, ink-700→edge,
 * ink-50..300→ink, ink-400..600→muted, signal→accent, cut→danger,
 * graphic→accent, music→ok. All tokens flip with the shell theme, so the
 * module looks right in both light and dark.
 */

export const btn =
  'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium bg-raised text-ink hover:bg-edge/70 ' +
  'transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

export const btnPrimary = `${btn} !bg-accent !text-accent-ink hover:opacity-90`

export const btnDanger = `${btn} !bg-danger/15 !text-danger hover:!bg-danger/25`

export const input =
  'w-full rounded-md bg-bg border border-edge px-3 py-1.5 text-sm text-ink placeholder:text-muted ' +
  'focus:border-accent focus:outline-none'

export const panel = 'bg-surface border border-edge rounded-lg'

export const label = 'block text-xs font-medium uppercase tracking-wider text-muted mb-1'

/** Transcript word treatment (was .word / .word-active / .word-cut). */
export const word = 'cursor-pointer rounded px-0.5 transition-colors hover:bg-edge/70'
export const wordActive = 'bg-accent/20 text-accent'
export const wordCut = 'text-muted/60 line-through decoration-danger/70'
export const segSelected = 'bg-accent/10 ring-1 ring-accent/40'
