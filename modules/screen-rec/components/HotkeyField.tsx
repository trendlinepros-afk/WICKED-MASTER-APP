import { useEffect, useRef, useState } from 'react'
import { Keyboard } from 'lucide-react'
import { inv, useRec } from '../store'
import { acceleratorFromEvent, DEFAULT_HOTKEY } from '../lib/hotkey'
import { btn, btnSm, Keys } from './ui'

/** Shows the record hotkey and captures a new one (the old one is paused meanwhile). */
export default function HotkeyField(): React.JSX.Element {
  const s = useRec()
  const [listening, setListening] = useState(false)
  const [err, setErr] = useState('')
  const ref = useRef<HTMLButtonElement>(null)

  const stopListening = (): void => {
    setListening(false)
    void inv('hotkey-suspend', false)
  }
  useEffect(() => {
    if (!listening) return
    ref.current?.focus()
    return () => void inv('hotkey-suspend', false)
  }, [listening])

  const onKey = async (e: React.KeyboardEvent): Promise<void> => {
    if (!listening) return
    e.preventDefault()
    if (e.key === 'Escape') return stopListening()
    const accel = acceleratorFromEvent(e.nativeEvent)
    if (!accel) return
    setListening(false)
    const r = await s.saveSettings({ hotkey: accel, hotkeyEnabled: true })
    if (!r.ok) {
      setErr(r.error ?? 'That combination is not available')
      void inv('hotkey-suspend', false)
    } else setErr('')
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          ref={ref}
          onKeyDown={(e) => void onKey(e)}
          onBlur={() => listening && stopListening()}
          onClick={() => {
            if (listening) return
            setErr('')
            setListening(true)
            void inv('hotkey-suspend', true)
          }}
          className={`flex min-w-[180px] items-center justify-center gap-2 rounded-lg border-2 px-4 py-2.5 ${listening ? 'border-accent bg-accent/10 text-accent' : 'border-edge bg-bg hover:border-accent/60'}`}
        >
          {listening ? (
            <span className="flex items-center gap-2 text-sm font-medium">
              <Keyboard size={15} /> Press the new keys…
            </span>
          ) : (
            <Keys accel={s.hotkey.accelerator} big />
          )}
        </button>
        {!listening && (
          <button className={btn} onClick={() => ref.current?.click()}>
            Change
          </button>
        )}
        {!listening && s.hotkey.accelerator !== DEFAULT_HOTKEY && (
          <button className={btnSm} onClick={() => void s.saveSettings({ hotkey: DEFAULT_HOTKEY }).then((r) => setErr(r.ok ? '' : (r.error ?? '')))}>
            Back to Ctrl+R
          </button>
        )}
        <span className={`text-xs ${s.hotkey.registered ? 'text-ok' : s.hotkey.enabled ? 'text-warn' : 'text-muted'}`}>
          {listening ? 'Esc to cancel' : s.hotkey.registered ? '● Active in every app' : s.hotkey.enabled ? '● Not active' : '● Off'}
        </span>
      </div>
      {(err || (s.hotkey.enabled && !s.hotkey.registered && s.hotkey.error && !listening)) && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-warn">
          {err || s.hotkey.error}
          {!err && (
            <button className={btnSm} onClick={() => void inv('hotkey-retry')}>
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  )
}
