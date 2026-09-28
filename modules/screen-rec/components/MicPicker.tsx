import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, RefreshCw } from 'lucide-react'
import { useRec } from '../store'
import type { MicChoice } from '../types'
import { btnSm } from './ui'

interface Device {
  deviceId: string
  label: string
}

async function listMics(): Promise<Device[]> {
  try {
    // labels are only visible once the page has used a microphone
    const s = await navigator.mediaDevices.getUserMedia({ audio: true })
    s.getTracks().forEach((t) => t.stop())
  } catch {
    /* no mic / blocked — list what we can */
  }
  const all = await navigator.mediaDevices.enumerateDevices()
  return all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications').map((d) => ({ deviceId: d.deviceId, label: d.label }))
}

const NONE = '__none__'

/** Microphone dropdown + live level meter for the selected device. */
export default function MicPicker({ gainDb }: { gainDb: number }): React.JSX.Element {
  const s = useRec()
  const mic = s.machine.mic
  const [devices, setDevices] = useState<Device[]>([])
  const [level, setLevel] = useState(0)
  const [meterErr, setMeterErr] = useState('')
  const gain = useRef(Math.pow(10, gainDb / 20))
  gain.current = Math.pow(10, gainDb / 20)

  const refresh = (): void => void listMics().then(setDevices)
  useEffect(() => {
    refresh()
    const onChange = (): void => refresh()
    navigator.mediaDevices.addEventListener('devicechange', onChange)
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange)
  }, [])

  // resolve the stored choice against this window's device list (ids can differ per window — fall back to the name)
  const selectedId = !mic ? NONE : devices.some((d) => d.deviceId === mic.deviceId) ? mic.deviceId : (devices.find((d) => d.label && d.label === mic.label)?.deviceId ?? (mic.deviceId === 'default' ? 'default' : mic.deviceId))

  useEffect(() => {
    if (!mic) {
      setLevel(0)
      return
    }
    let stop = false
    let raf = 0
    let stream: MediaStream | null = null
    let ac: AudioContext | null = null
    setMeterErr('')
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: selectedId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
        if (stop) return stream.getTracks().forEach((t) => t.stop())
        ac = new AudioContext()
        const src = ac.createMediaStreamSource(stream)
        const an = ac.createAnalyser()
        an.fftSize = 1024
        src.connect(an)
        const buf = new Float32Array(an.fftSize)
        let shown = 0
        const tick = (): void => {
          an.getFloatTimeDomainData(buf)
          let p = 0
          for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]))
          p *= gain.current
          shown = Math.max(p, shown * 0.9)
          setLevel(shown)
          raf = requestAnimationFrame(tick)
        }
        tick()
      } catch (e) {
        setMeterErr(e instanceof Error && e.name === 'NotAllowedError' ? 'Windows is blocking microphone access (Settings → Privacy & security → Microphone).' : 'This microphone could not be opened.')
      }
    })()
    return () => {
      stop = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      void ac?.close()
    }
  }, [mic, selectedId])

  const choose = (id: string): void => {
    if (id === NONE) return void s.saveMachine({ mic: null })
    const d = devices.find((x) => x.deviceId === id)
    const next: MicChoice = id === 'default' ? { deviceId: 'default', label: d?.label.replace(/^Default - /, '') ?? '' } : { deviceId: id, label: d?.label ?? '' }
    void s.saveMachine({ mic: next })
  }

  const db = level > 0 ? 20 * Math.log10(level) : -90
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
  const inList = selectedId === NONE || devices.some((d) => d.deviceId === selectedId)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {mic ? <Mic size={16} className="shrink-0 text-muted" /> : <MicOff size={16} className="shrink-0 text-muted" />}
        <select value={selectedId} onChange={(e) => choose(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-edge bg-bg px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none">
          <option value={NONE}>No microphone</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.deviceId === 'default' ? `Windows default${d.label ? ` (${d.label.replace(/^Default - /, '')})` : ''}` : d.label || 'Microphone'}
            </option>
          ))}
          {!inList && mic && <option value={selectedId}>{mic.deviceId === 'default' ? 'Windows default microphone — none found' : `${mic.label || 'Saved microphone'} — not connected`}</option>}
        </select>
        <button className={btnSm} onClick={refresh} title="Look for microphones again">
          <RefreshCw size={12} />
        </button>
      </div>
      {mic && (
        <div>
          <div className="relative h-2.5 overflow-hidden rounded-full bg-raised">
            <div className={`h-full rounded-full transition-[width] duration-75 ${db > -3 ? 'bg-danger' : db > -12 ? 'bg-warn' : 'bg-ok'}`} style={{ width: `${pct}%` }} />
            <span className="absolute inset-y-0 w-px bg-ink/30" style={{ left: `${((-12 + 60) / 60) * 100}%` }} />
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-muted">
            <span>{meterErr || 'Talk normally — the bar should reach the green/yellow edge, not red.'}</span>
            <span className="tabular-nums">{db > -90 ? `${db.toFixed(0)} dB` : ''}</span>
          </div>
        </div>
      )}
    </div>
  )
}
