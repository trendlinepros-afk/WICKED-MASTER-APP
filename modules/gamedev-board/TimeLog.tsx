import { useRef, useState } from 'react'
import { Clock, Plus, Trash2 } from 'lucide-react'
import {
  dateInput,
  entryDur,
  fmtDur,
  fmtHours,
  timeInput,
  todaySec,
  useBoard,
  type TimeEntry
} from './store'
import { ConfirmModal } from './Modals'

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-edge bg-surface px-4 py-3 shadow-sm">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-[23px] font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function EntryRow({ entry }: { entry: TimeEntry }): React.JSX.Element {
  const { patchEntry, deleteEntry } = useBoard()
  const [confirm, setConfirm] = useState(false)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [note, setNote] = useState(entry.note ?? '')
  const [date, setDate] = useState(dateInput(entry.start))
  const [start, setStart] = useState(timeInput(entry.start))
  const [end, setEnd] = useState(timeInput(entry.end))

  const recompute = (d: string, s: string, e: string): void => {
    const sMs = new Date(`${d}T${s}`).getTime()
    const eMs = new Date(`${d}T${e}`).getTime()
    if (!Number.isNaN(sMs) && !Number.isNaN(eMs)) patchEntry(entry.id, { start: sMs, end: eMs })
  }

  const inputCls =
    'rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[13px] hover:border-edge focus:border-accent focus:bg-surface focus:outline-none'

  return (
    <tr className="border-b border-edge last:border-b-0">
      <td className="px-3 py-1.5">
        <input
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value)
            recompute(e.target.value, start, end)
          }}
          className={inputCls}
        />
      </td>
      <td className="px-3 py-1.5">
        <input
          type="time"
          value={start}
          onChange={(e) => {
            setStart(e.target.value)
            recompute(date, e.target.value, end)
          }}
          className={inputCls}
        />
      </td>
      <td className="px-3 py-1.5">
        <input
          type="time"
          value={end}
          onChange={(e) => {
            setEnd(e.target.value)
            recompute(date, start, e.target.value)
          }}
          className={inputCls}
        />
      </td>
      <td className="whitespace-nowrap px-3 py-1.5 text-[13px] font-semibold tabular-nums">
        {fmtDur(entryDur(entry))}
      </td>
      <td className="w-full px-3 py-1.5">
        <input
          type="text"
          value={note}
          placeholder="What did you work on?"
          onChange={(e) => {
            setNote(e.target.value)
            if (noteTimer.current) clearTimeout(noteTimer.current)
            const v = e.target.value
            noteTimer.current = setTimeout(() => patchEntry(entry.id, { note: v }), 450)
          }}
          className={`${inputCls} w-full`}
        />
      </td>
      <td className="px-2 py-1.5">
        <button
          title="Delete entry"
          onClick={() => setConfirm(true)}
          className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-muted hover:bg-danger/10 hover:text-danger"
        >
          <Trash2 size={14} />
        </button>
        {confirm && (
          <ConfirmModal
            title="Delete entry?"
            message="This time entry will be removed."
            danger
            onDone={(ok) => {
              setConfirm(false)
              if (ok) deleteEntry(entry.id)
            }}
          />
        )}
      </td>
    </tr>
  )
}

export default function TimeLog(): React.JSX.Element {
  const { entries, settings, addManualEntry } = useBoard()
  const total = entries.reduce((s, e) => s + entryDur(e), 0)
  const sorted = [...entries].sort((a, b) => b.start - a.start)

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Time log</h1>
        <button
          onClick={addManualEntry}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-ink hover:opacity-90"
        >
          <Plus size={15} />
          Add entry
        </button>
      </div>

      <div className="mb-5 grid max-w-xl grid-cols-3 gap-3">
        <Stat label="Total hours" value={fmtHours(total)} />
        <Stat label="Today" value={fmtHours(todaySec(entries, settings.timerStart))} />
        <Stat label="Sessions" value={String(entries.length)} />
      </div>

      {entries.length === 0 ? (
        <div className="px-5 py-16 text-center text-muted">
          <Clock size={38} className="mx-auto mb-3 opacity-40" />
          <p>No sessions logged yet.</p>
          <p>Use the timer up top, or add an entry by hand.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-edge bg-surface shadow-sm">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-edge bg-raised text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="px-3 py-2.5 font-semibold">Date</th>
                <th className="px-3 py-2.5 font-semibold">Start</th>
                <th className="px-3 py-2.5 font-semibold">End</th>
                <th className="px-3 py-2.5 font-semibold">Duration</th>
                <th className="px-3 py-2.5 font-semibold">Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((e) => (
                <EntryRow key={e.id} entry={e} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
