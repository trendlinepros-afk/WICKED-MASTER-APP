import { useEffect, useRef, useState } from 'react'
import {
  Clock,
  Download,
  Folder,
  LayoutGrid,
  Loader2,
  Play,
  Plus,
  Settings2,
  Square,
  Upload
} from 'lucide-react'
import {
  fmtClock,
  fmtHours,
  liveSec,
  todaySec,
  totalSec,
  useBoard,
  type BackupDump,
  type Folder as FolderT
} from './store'
import Board from './Board'
import TimeLog from './TimeLog'
import { ConfirmModal, FolderMenu, SessionNotePrompt, TextPrompt } from './Modals'

function TimerBox(): React.JSX.Element {
  const { settings, entries, startTimer, stopTimer, logEntry } = useBoard()
  const running = !!settings.timerStart
  const [, forceTick] = useState(0)
  const [pendingSpan, setPendingSpan] = useState<{ start: number; end: number } | null>(null)

  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="flex items-center gap-3.5">
      <div
        className={`flex items-center gap-2 rounded-lg border py-1 pl-2.5 pr-1.5 ${
          running ? 'border-accent bg-raised' : 'border-edge bg-raised'
        }`}
      >
        <span
          className={`h-2 w-2 rounded-full ${running ? 'animate-pulse bg-ok' : 'bg-muted/60'}`}
        />
        <span className="min-w-[74px] text-[15px] font-semibold tabular-nums tracking-wide">
          {fmtClock(liveSec(settings.timerStart))}
        </span>
        <button
          title={running ? 'Stop timer' : 'Start timer'}
          onClick={async () => {
            if (running) {
              const span = await stopTimer()
              if (span) setPendingSpan(span)
            } else {
              startTimer()
            }
          }}
          className={`flex h-[30px] w-[30px] items-center justify-center rounded-md text-white ${
            running ? 'bg-danger' : 'bg-accent'
          }`}
        >
          {running ? <Square size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
        </button>
      </div>
      <div className="text-right text-xs leading-snug text-muted">
        <div>
          Today <b className="font-semibold text-ink">{fmtHours(todaySec(entries, settings.timerStart))}</b>
        </div>
        <div>
          Total <b className="font-semibold text-ink">{fmtHours(totalSec(entries, settings.timerStart))}</b>
        </div>
      </div>

      {pendingSpan && (
        <SessionNotePrompt
          onDone={(note) => {
            const span = pendingSpan
            setPendingSpan(null)
            logEntry(span.start, span.end, note)
          }}
        />
      )}
    </div>
  )
}

type Modal =
  | { kind: 'newFolder' }
  | { kind: 'renameFolder'; folder: FolderT }
  | { kind: 'folderMenu'; folder: FolderT }
  | { kind: 'deleteFolder'; folder: FolderT }
  | { kind: 'importConfirm'; dump: BackupDump }
  | { kind: 'importNotBackup'; dump: BackupDump }
  | { kind: 'importFailed' }
  | null

export default function GameDevBoard(): React.JSX.Element {
  const {
    ready,
    init,
    folders,
    cards,
    settings,
    saveSettings,
    addFolder,
    renameFolder,
    deleteFolder,
    setActiveCard,
    addImageToCard,
    exportData,
    importData,
    dataEpoch
  } = useBoard()
  const [modal, setModal] = useState<Modal>(null)
  const importRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    init()
  }, [init])

  // global paste -> active card (or a fresh card in the current folder)
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent): Promise<void> => {
      const state = useBoard.getState()
      if (state.settings.view !== 'board') return
      for (const it of Array.from(e.clipboardData?.items ?? [])) {
        if (it.type.startsWith('image/')) {
          const blob = it.getAsFile()
          if (!blob) continue
          e.preventDefault()
          let cardId = state.activeCardId
          if (!state.cards.some((c) => c.id === cardId)) {
            const fid = state.settings.activeFolder ?? state.folders[0]?.id
            if (!fid) return
            const c = await state.addCard(fid)
            cardId = c.id
          }
          await addImageToCard(cardId!, blob)
          return
        }
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [addImageToCard])

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Loader2 size={28} className="animate-spin" />
      </div>
    )
  }

  const navItem = (active: boolean): string =>
    `flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px] ${
      active ? 'bg-accent/15 font-semibold text-accent' : 'hover:bg-raised'
    }`

  return (
    <div className="flex h-full flex-col" key={dataEpoch}>
      {/* module top bar */}
      <div className="flex h-[54px] shrink-0 select-none items-center justify-between border-b border-edge bg-surface px-3.5">
        <div className="flex items-center gap-2.5 text-[15px] font-semibold">
          <span className="flex h-[26px] w-[26px] items-center justify-center rounded-md bg-accent text-[13px] font-bold text-accent-ink">
            GD
          </span>
          GameDev Project Board
        </div>
        <div className="flex items-center gap-3.5">
          <TimerBox />
          <button
            title="Export backup"
            onClick={exportData}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-edge text-muted hover:bg-raised hover:text-ink"
          >
            <Download size={16} />
          </button>
          <button
            title="Import backup"
            onClick={() => importRef.current?.click()}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-edge text-muted hover:bg-raised hover:text-ink"
          >
            <Upload size={16} />
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              try {
                const dump = JSON.parse(await file.text()) as BackupDump
                setModal(
                  dump.app === 'GameDevHelper'
                    ? { kind: 'importConfirm', dump }
                    : { kind: 'importNotBackup', dump }
                )
              } catch {
                setModal({ kind: 'importFailed' })
              }
            }}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* module sidebar */}
        <div className="flex w-[188px] shrink-0 flex-col overflow-y-auto border-r border-edge bg-surface px-2 py-3">
          <div className="px-2 pb-1 pt-1.5 text-[11px] uppercase tracking-wider text-muted/70">
            Views
          </div>
          <button
            className={navItem(settings.view === 'board')}
            onClick={() => saveSettings({ view: 'board' })}
          >
            <LayoutGrid size={16} className="opacity-85" />
            <span className="flex-1 truncate">Board</span>
          </button>
          <button
            className={navItem(settings.view === 'log')}
            onClick={() => saveSettings({ view: 'log' })}
          >
            <Clock size={16} className="opacity-85" />
            <span className="flex-1 truncate">Time log</span>
          </button>

          <div className="mt-2 px-2 pb-1 pt-1.5 text-[11px] uppercase tracking-wider text-muted/70">
            Folders
          </div>
          {folders.map((f) => {
            const count = cards.filter((c) => c.folderId === f.id).length
            const active = settings.view === 'board' && settings.activeFolder === f.id
            return (
              <div key={f.id} className="group flex items-center">
                <button
                  className={navItem(active)}
                  onClick={() => saveSettings({ view: 'board', activeFolder: f.id })}
                >
                  <Folder size={16} className="opacity-85" />
                  <span className="flex-1 truncate">{f.name}</span>
                  <span className="text-[11px] text-muted/70">{count}</span>
                </button>
                <button
                  title="Rename / delete"
                  onClick={() => setModal({ kind: 'folderMenu', folder: f })}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted/70 opacity-0 hover:bg-raised hover:text-ink group-hover:opacity-100"
                >
                  <Settings2 size={14} />
                </button>
              </div>
            )
          })}
          <button className={`${navItem(false)} text-muted`} onClick={() => setModal({ kind: 'newFolder' })}>
            <Plus size={16} />
            <span className="flex-1 truncate">New folder</span>
          </button>
        </div>

        {/* content */}
        <div className="min-w-0 flex-1 overflow-y-auto px-5 pb-16 pt-4">
          {settings.view === 'log' ? (
            <TimeLog />
          ) : (
            <Board onNewFolder={() => setModal({ kind: 'newFolder' })} />
          )}
        </div>
      </div>

      {/* modals */}
      {modal?.kind === 'newFolder' && (
        <TextPrompt
          title="New folder"
          placeholder="Folder name"
          onDone={(name) => {
            setModal(null)
            if (name) addFolder(name)
          }}
        />
      )}
      {modal?.kind === 'renameFolder' && (
        <TextPrompt
          title="Rename folder"
          placeholder="Folder name"
          initial={modal.folder.name}
          onDone={(name) => {
            setModal(null)
            if (name) renameFolder(modal.folder.id, name)
          }}
        />
      )}
      {modal?.kind === 'folderMenu' && (
        <FolderMenu
          name={modal.folder.name}
          onDone={(choice) => {
            if (choice === 'rename') setModal({ kind: 'renameFolder', folder: modal.folder })
            else if (choice === 'delete') setModal({ kind: 'deleteFolder', folder: modal.folder })
            else setModal(null)
          }}
        />
      )}
      {modal?.kind === 'deleteFolder' && (
        <ConfirmModal
          title="Delete folder?"
          message={`"${modal.folder.name}" and its ${
            cards.filter((c) => c.folderId === modal.folder.id).length
          } card(s) will be removed. This cannot be undone.`}
          danger
          onDone={(ok) => {
            setModal(null)
            if (ok) deleteFolder(modal.folder.id)
          }}
        />
      )}
      {modal?.kind === 'importNotBackup' && (
        <ConfirmModal
          title="Import anyway?"
          message="This does not look like a GameDev Helper backup. Import it anyway? Your current data will be replaced."
          danger
          onDone={(ok) => {
            setModal(ok ? { kind: 'importConfirm', dump: modal.dump } : null)
          }}
        />
      )}
      {modal?.kind === 'importConfirm' && (
        <ConfirmModal
          title="Replace everything?"
          message="Importing will replace all current folders, cards and time entries with the backup. Continue?"
          danger
          onDone={async (ok) => {
            const dump = modal.dump
            setModal(null)
            if (ok) {
              await importData(dump)
              setActiveCard(null)
            }
          }}
        />
      )}
      {modal?.kind === 'importFailed' && (
        <ConfirmModal
          title="Import failed"
          message="That file is not a valid backup."
          onDone={() => setModal(null)}
        />
      )}
    </div>
  )
}
