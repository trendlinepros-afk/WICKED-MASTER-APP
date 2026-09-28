/**
 * Hotkey helpers (pure): turn a keyboard event into an Electron accelerator
 * and print accelerators the way Windows users read them.
 */

export const DEFAULT_HOTKEY = 'CommandOrControl+R'

const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  Pause: 'Pause',
  ScrollLock: 'Scrolllock',
  PrintScreen: 'PrintScreen'
}

export interface KeyLike {
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

/**
 * Accelerator for a key press, or null while only modifiers are held / the
 * combo would hijack normal typing (a plain letter or digit needs a modifier;
 * F-keys and a few special keys may stand alone).
 */
export function acceleratorFromEvent(e: KeyLike): string | null {
  let key: string | null = null
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5)
  else if (/^Numpad[0-9]$/.test(e.code)) key = `num${e.code.slice(6)}`
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code]
  if (!key) return null
  const mods: string[] = []
  if (e.ctrlKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')
  const standalone = /^F\d+$/.test(key) || key === 'Pause' || key === 'Scrolllock' || key === 'PrintScreen' || key === 'Insert'
  if (!mods.length && !standalone) return null
  if (mods.length === 1 && mods[0] === 'Shift' && !standalone) return null
  return [...mods, key].join('+')
}

/** "CommandOrControl+Shift+R" → "Ctrl+Shift+R" */
export function prettyAccelerator(accel: string): string {
  return String(accel || '')
    .split('+')
    .map((p) => (p === 'CommandOrControl' || p === 'CmdOrCtrl' || p === 'Control' ? 'Ctrl' : p === 'Super' ? 'Win' : p.startsWith('num') ? `Num ${p.slice(3)}` : p))
    .join('+')
}
