import { useEffect, useRef, useState } from 'react'
import { Copy, KeyRound } from 'lucide-react'

const IDLE_STATUS = 'Pick a format to generate a key.'
const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n)
  crypto.getRandomValues(buf)
  return buf
}

function generateHex(length: number): string {
  return Array.from(randomBytes(length), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** URL-safe base64 of `length` random bytes, unpadded (matches Python's token_urlsafe). */
function generateBase64(length: number): string {
  const bytes = randomBytes(length)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Unbiased alphanumeric via rejection sampling (62 * 4 = 248). */
function generateAlphanumeric(length: number): string {
  let out = ''
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 248) {
        out += ALPHANUMERIC[b % 62]
        if (out.length === length) break
      }
    }
  }
  return out
}

function generateUuid(): string {
  return crypto.randomUUID()
}

const FORMATS: { name: string; generate: (length: number) => string }[] = [
  { name: 'Hex', generate: generateHex },
  { name: 'Base64 (URL-safe)', generate: generateBase64 },
  { name: 'Alphanumeric', generate: generateAlphanumeric },
  { name: 'UUID v4', generate: generateUuid } // fixed size, ignores length
]

export default function SecretKeyGenerator(): React.JSX.Element {
  const [length, setLength] = useState(32)
  const [output, setOutput] = useState('')
  const [status, setStatus] = useState(IDLE_STATUS)
  const statusJob = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (statusJob.current) clearTimeout(statusJob.current)
  }, [])

  const flashStatus = (message: string): void => {
    setStatus(message)
    if (statusJob.current) clearTimeout(statusJob.current)
    statusJob.current = setTimeout(() => setStatus(IDLE_STATUS), 2000)
  }

  const copyToClipboard = async (key: string): Promise<void> => {
    if (!key) return
    await navigator.clipboard.writeText(key)
    flashStatus('Copied to clipboard ✓')
  }

  const generate = (fn: (length: number) => string): void => {
    const clamped = Math.max(8, Math.min(128, Math.trunc(length) || 32))
    setLength(clamped)
    const key = fn(clamped)
    setOutput(key)
    copyToClipboard(key)
  }

  return (
    <div className="flex h-full items-start justify-center overflow-y-auto p-10">
      <div className="w-full max-w-2xl rounded-2xl border border-edge bg-surface p-8">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-raised text-accent">
            <KeyRound size={20} />
          </span>
          <h1 className="text-xl font-bold tracking-tight">Secret Key Generator</h1>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="skg-length" className="font-medium">
            Length:
          </label>
          <input
            id="skg-length"
            type="number"
            min={8}
            max={128}
            value={length}
            onChange={(e) => setLength(Number(e.target.value))}
            className="w-20 rounded-lg border border-edge bg-raised px-2 py-1.5"
          />
          <span className="text-muted">
            (bytes for Hex/Base64, chars for Alphanumeric — UUID ignores it)
          </span>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {FORMATS.map(({ name, generate: fn }) => (
            <button
              key={name}
              onClick={() => generate(fn)}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
            >
              {name}
            </button>
          ))}
        </div>

        <div className="mt-5 flex gap-2">
          <input
            readOnly
            value={output}
            placeholder="Generated key appears here"
            className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-3 py-2 font-mono text-sm"
          />
          <button
            onClick={() => copyToClipboard(output)}
            className="flex items-center gap-2 rounded-lg bg-raised px-4 py-2 text-sm font-medium hover:bg-edge/60"
          >
            <Copy size={15} />
            Copy
          </button>
        </div>

        <p className="mt-3 text-sm text-muted">{status}</p>
      </div>
    </div>
  )
}
