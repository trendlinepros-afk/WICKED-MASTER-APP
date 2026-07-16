import { create } from 'zustand'
import { SHELL_IPC, type UpdateEvent } from '@shared/types'

/**
 * Update flow shared by the sidebar "Check for Updates" button, the status
 * toast, and the install dialog. One subscription to the main-process updater
 * events drives all three.
 */
type Phase = 'idle' | 'checking' | 'available' | 'downloaded' | 'none' | 'error'

interface UpdatesState {
  phase: Phase
  /** version string for an available/downloaded update */
  version: string | null
  /** transient status message (checking / up-to-date / error) */
  message: string
  /** whether the transient status chip is visible */
  showStatus: boolean

  init: () => () => void
  check: () => Promise<void>
  install: () => void
  later: () => void
  dismissStatus: () => void
}

function friendlyError(raw: string): string {
  const m = raw || ''
  if (/404|latest\.yml|Cannot find|No published|ENOTFOUND|getaddrinfo|net::|ERR_/i.test(m)) {
    return 'No updates found yet (the release feed isn’t reachable). This will work once the GitHub repo has a published release.'
  }
  // keep it short and non-scary
  return `Couldn’t check for updates: ${m.split('\n')[0].slice(0, 120)}`
}

export const useUpdates = create<UpdatesState>((set) => ({
  phase: 'idle',
  version: null,
  message: '',
  showStatus: false,

  init: () => {
    return window.wicked.on(SHELL_IPC.updateEvent, (raw) => {
      const ev = raw as UpdateEvent
      switch (ev.kind) {
        case 'checking':
          set({ phase: 'checking', message: 'Checking for updates…', showStatus: true })
          break
        case 'available':
          set({
            phase: 'available',
            version: ev.version,
            message: `Update ${ev.version} found — downloading…`,
            showStatus: true
          })
          break
        case 'none':
          set({ phase: 'none', message: 'You’re on the latest version.', showStatus: true })
          break
        case 'downloaded':
          // the install dialog takes over from here
          set({ phase: 'downloaded', version: ev.version, showStatus: false })
          break
        case 'error':
          set({ phase: 'error', message: friendlyError(ev.message), showStatus: true })
          break
      }
    })
  },

  check: async () => {
    set({ phase: 'checking', message: 'Checking for updates…', showStatus: true })
    await window.wicked.invoke(SHELL_IPC.updateCheck)
  },

  install: () => {
    window.wicked.invoke(SHELL_IPC.updateInstall)
  },

  later: () => {
    window.wicked.invoke(SHELL_IPC.updatePostpone)
    // hide the dialog; the downloaded update installs automatically on next quit
    set({ phase: 'idle', version: null })
  },

  dismissStatus: () => set({ showStatus: false })
}))
