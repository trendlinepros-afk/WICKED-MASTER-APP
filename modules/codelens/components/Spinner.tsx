import { Loader2 } from 'lucide-react'

export function Spinner({ label, className = '' }: { label?: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 text-ink/80 ${className}`}>
      <Loader2 size={15} className="animate-spin text-accent" />
      {label && <span className="text-xs">{label}</span>}
    </span>
  )
}
