import { create } from 'zustand'

export const ID = '365-email-cleanup'

/* ------------------------------------------------------------------------ *
 *  Pure logic ported from InboxCleanup.Core (RulesEngine, RouteStore,
 *  RouteEngine). Headers come from Outlook (via PowerShell in ipc.ts); these
 *  functions turn them into a side-effect-free routing plan — they move nothing.
 * ------------------------------------------------------------------------ */

/** RulesEngine.JunkLocalParts */
const JUNK_LOCAL_PARTS = [
  'no-reply', 'noreply', 'no_reply', 'do-not-reply', 'donotreply', 'do_not_reply',
  'donotrespond', 'notifications', 'notification', 'notify', 'mailer', 'mailer-daemon',
  'bounce', 'bounces', 'newsletter', 'marketing', 'postmaster', 'mailbot',
  'automated', 'alerts', 'updates'
]

/** RulesEngine.JunkDomainPrefixes */
const JUNK_DOMAIN_PREFIXES = [
  'mg.', 'email.', 'em.', 'mailer.', 'bounce.', 'news.', 'marketing.', 'send.', 'sendgrid.'
]

/** RouteStore.Inbox — reserved target meaning "leave it in the inbox". */
export const INBOX = ''
export const REVIEW_FOLDER = '_Review'
/** RouteStore.MinSubjectPatternLength */
export const MIN_SUBJECT_PATTERN_LENGTH = 3

export interface RuleVerdict {
  isLikelyJunk: boolean
  reason: string
}

/** Port of RulesEngine.Evaluate. */
export function rulesEvaluate(senderEmail: string, anyListUnsubscribe: boolean): RuleVerdict {
  const email = (senderEmail || '').trim().toLowerCase()
  const at = email.indexOf('@')
  const local = at > 0 ? email.slice(0, at) : email
  const domain = at >= 0 && at < email.length - 1 ? email.slice(at + 1) : ''

  if (anyListUnsubscribe) return { isLikelyJunk: true, reason: 'has an unsubscribe / bulk-mail header' }
  if (local.includes('=')) return { isLikelyJunk: true, reason: 'bulk bounce-style (VERP) address' }
  for (const p of JUNK_LOCAL_PARTS)
    if (local.includes(p)) return { isLikelyJunk: true, reason: `automated address pattern ("${p}")` }
  for (const p of JUNK_DOMAIN_PREFIXES)
    if (domain.startsWith(p)) return { isLikelyJunk: true, reason: `bulk-mail sending domain ("${p}")` }
  return { isLikelyJunk: false, reason: 'no junk signals — looks like a person' }
}

export interface Routes {
  emails: Record<string, string>
  domains: Record<string, string>
  subjects: Record<string, string>
}

export const emptyRoutes = (): Routes => ({ emails: {}, domains: {}, subjects: {} })

function domainOf(email: string): string {
  const at = email.lastIndexOf('@')
  return at >= 0 && at < email.length - 1 ? email.slice(at + 1) : ''
}

/** Port of RouteStore.Classify — folder name, "" (keep), or null (unknown). */
export function classify(routes: Routes, senderEmail: string): string | null {
  const email = (senderEmail || '').trim().toLowerCase()
  if (email.length === 0) return null
  if (email in routes.emails) return routes.emails[email]
  const domain = domainOf(email)
  if (domain.length > 0 && domain in routes.domains) return routes.domains[domain]
  return null
}

/** Port of RouteStore.MatchSubjectRule — longest matching pattern wins, ties alpha. */
export function matchSubjectRule(
  routes: Routes,
  subject: string
): { pattern: string; target: string } | null {
  if (!subject) return null
  const patterns = Object.keys(routes.subjects)
    .filter((k) => k.trim().length > 0)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
  const lower = subject.toLowerCase()
  for (const p of patterns) if (lower.includes(p.toLowerCase())) return { pattern: p, target: routes.subjects[p] }
  return null
}

export interface EmailHeader {
  entryId: string
  subject: string
  senderName: string
  senderEmail: string
  receivedTime: string | null
  hasListUnsubscribe: boolean
}

function senderKey(h: EmailHeader): string {
  const email = h.senderEmail.trim().toLowerCase()
  return email.length > 0 ? email : h.senderName.trim().toLowerCase()
}

export interface SenderRoute {
  key: string
  senderName: string
  senderEmail: string
  count: number
  entryIds: string[]
  /** null = unknown (new sender), "" = keep in inbox, else a folder name. */
  currentTarget: string | null
  suggestedTarget: string
  reason: string
  isKnown: boolean
}

/** Port of RouteEngine.BuildPlan — subject rules first, then sender routing. */
export function buildPlan(inbox: EmailHeader[], routes: Routes): SenderRoute[] {
  const senders: SenderRoute[] = []

  // 1) Subject rules (override sender rules), grouped by matched pattern.
  const subjectGroups = new Map<string, { target: string; items: EmailHeader[] }>()
  const remaining: EmailHeader[] = []
  for (const e of inbox) {
    const m = matchSubjectRule(routes, e.subject)
    if (m) {
      const g = subjectGroups.get(m.pattern) ?? { target: m.target, items: [] }
      g.items.push(e)
      subjectGroups.set(m.pattern, g)
    } else {
      remaining.push(e)
    }
  }
  for (const [pattern, g] of subjectGroups) {
    const ids = [...new Set(g.items.map((x) => x.entryId).filter((id) => id.length > 0))]
    senders.push({
      key: 'subject:' + pattern,
      senderName: 'Subject: ' + pattern,
      senderEmail: '',
      count: ids.length,
      entryIds: ids,
      currentTarget: g.target,
      suggestedTarget: INBOX,
      reason: 'subject rule',
      isKnown: true
    })
  }

  // 2) Remaining routed by sender (address-less items grouped per message).
  const groups = new Map<string, EmailHeader[]>()
  for (const e of remaining) {
    const k = e.senderEmail.trim().length === 0 ? 'noaddr:' + e.entryId : senderKey(e)
    const arr = groups.get(k) ?? []
    arr.push(e)
    groups.set(k, arr)
  }
  for (const [k, arr] of groups) {
    const email = arr.map((x) => x.senderEmail).find((a) => a.trim().length > 0) ?? ''
    const name = arr.map((x) => x.senderName).find((n) => n.trim().length > 0) ?? '(unknown)'
    const anyUnsub = arr.some((x) => x.hasListUnsubscribe)
    const ids = [...new Set(arr.map((x) => x.entryId).filter((id) => id.length > 0))]

    const current = classify(routes, email)
    let suggested = INBOX
    let reason = 'already filed'
    if (current === null) {
      const v = rulesEvaluate(email, anyUnsub)
      suggested = v.isLikelyJunk ? REVIEW_FOLDER : INBOX
      reason = v.reason
    }
    senders.push({
      key: k,
      senderName: name,
      senderEmail: email,
      count: ids.length,
      entryIds: ids,
      currentTarget: current,
      suggestedTarget: suggested,
      reason,
      isKnown: current !== null
    })
  }

  return senders.sort((a, b) => b.count - a.count)
}

/* ------------------------------ formatting ------------------------------- */

export function fmtCount(n: number): string {
  return n.toLocaleString('en-US')
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/* --------------------------------- types --------------------------------- */

export type Tab = 'cleanup' | 'drafts' | 'rules' | 'history'
export type ConnState = 'idle' | 'connecting' | 'connected' | 'error'

export interface DraftRow {
  entryId: string
  subject: string
  senderName: string
  senderEmail: string
  receivedTime: string | null
}

export interface HistoryItem {
  senderLabel: string
  subject: string
  targetFolderName: string
}
export interface HistoryBatch {
  createdUtc: string
  count: number
  items: HistoryItem[]
}

interface Ok {
  ok: true
  [k: string]: unknown
}
interface Err {
  ok: false
  error?: string
  cancelled?: boolean
}
type IpcResult = Ok | Err

const invoke = <T = IpcResult>(channel: string, ...args: unknown[]): Promise<T> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args) as Promise<T>

/* --------------------------------- store --------------------------------- */

interface State {
  tab: Tab

  conn: ConnState
  account: string
  folders: string[]
  inboxCount: number

  busy: boolean
  status: string
  error: string

  headers: EmailHeader[]
  routes: Routes
  plan: SenderRoute[]
  /** unknown-sender key -> chosen target ("" keep, or folder). Presence = assigned. */
  assignments: Record<string, string>
  scannedAt: string

  hasUndo: boolean
  history: HistoryBatch[]

  // drafts tab
  draftSelection: Record<string, boolean>
  tone: string
  hasAiKey: boolean

  // rules tab editor
  ruleEntry: string
  ruleTarget: string
  subjectPattern: string
  subjectTarget: string
  newFolderName: string

  setTab: (t: Tab) => void
  dismissError: () => void

  connect: () => Promise<void>
  scan: () => Promise<void>
  createFolder: () => Promise<void>
  setNewFolderName: (v: string) => void

  assign: (key: string, target: string) => void
  unassign: (key: string) => void
  fileSuggestedJunk: () => void
  apply: () => Promise<void>
  undo: () => Promise<void>
  refreshUndo: () => Promise<void>
  loadHistory: () => Promise<void>

  // drafts
  toggleDraft: (entryId: string) => void
  selectDraftRange: (fromDaysAgo: number | 'all' | 'today') => void
  clearDraftSelection: () => void
  setTone: (t: string) => void
  draftSelected: () => Promise<void>

  // rules
  setRuleEntry: (v: string) => void
  setRuleTarget: (v: string) => void
  setSubjectPattern: (v: string) => void
  setSubjectTarget: (v: string) => void
  addRoute: () => Promise<void>
  removeRoute: (entry: string, kind: 'email' | 'domain') => Promise<void>
  addSubjectRule: () => Promise<void>
  removeSubjectRule: (pattern: string) => Promise<void>

  cancel: () => Promise<void>
  setHasAiKey: (v: boolean) => void
}

const TONES = ['warm and professional', 'friendly and casual', 'brief and formal', 'apologetic']
export { TONES }

export const useCleanup = create<State>((set, get) => {
  const rebuildPlan = (): void => {
    const { headers, routes } = get()
    set({ plan: buildPlan(headers, routes) })
  }

  return {
    tab: 'cleanup',

    conn: 'idle',
    account: '',
    folders: [],
    inboxCount: 0,

    busy: false,
    status: 'Not connected. Press Connect to attach to classic Outlook.',
    error: '',

    headers: [],
    routes: emptyRoutes(),
    plan: [],
    assignments: {},
    scannedAt: '',

    hasUndo: false,
    history: [],

    draftSelection: {},
    tone: TONES[0],
    hasAiKey: false,

    ruleEntry: '',
    ruleTarget: REVIEW_FOLDER,
    subjectPattern: '',
    subjectTarget: REVIEW_FOLDER,
    newFolderName: '',

    setTab: (t) => set({ tab: t }),
    dismissError: () => set({ error: '' }),

    connect: async () => {
      if (get().busy) return
      set({ busy: true, conn: 'connecting', status: 'Connecting to Outlook…', error: '' })
      try {
        const routes = await invoke<Routes>('routes-load')
        const res = await invoke('connect')
        if (res.ok !== true) {
          set({ conn: 'error', status: 'Not connected.', error: res.error ?? 'Could not connect to Outlook.' })
          return
        }
        set({
          conn: 'connected',
          account: String(res.account ?? ''),
          folders: Array.isArray(res.folders) ? (res.folders as string[]) : [],
          inboxCount: typeof res.inboxCount === 'number' ? res.inboxCount : 0,
          routes: routes ?? emptyRoutes(),
          status: `Connected${res.account ? ` as ${String(res.account)}` : ''}. Press Scan Inbox to build a plan.`
        })
        await get().refreshUndo()
      } finally {
        set({ busy: false })
      }
    },

    scan: async () => {
      if (get().busy || get().conn !== 'connected') return
      set({ busy: true, status: 'Scanning your inbox…', error: '' })
      try {
        const res = await invoke('scan', 500)
        if (res.ok !== true) {
          if (!res.cancelled) set({ error: res.error ?? 'Scan failed.' })
          set({ status: res.cancelled ? 'Cancelled.' : 'Scan failed.' })
          return
        }
        const headers = (Array.isArray(res.headers) ? res.headers : []) as EmailHeader[]
        set({
          headers,
          assignments: {},
          scannedAt: new Date().toISOString(),
          inboxCount: typeof res.inboxCount === 'number' ? res.inboxCount : get().inboxCount,
          draftSelection: {},
          status: `Scanned ${fmtCount(headers.length)} message(s).`
        })
        rebuildPlan()
        const plan = get().plan
        const unknown = plan.filter((s) => !s.isKnown).length
        set({ status: `Scanned ${fmtCount(headers.length)} message(s). ${fmtCount(unknown)} new sender(s) to sort.` })
      } finally {
        set({ busy: false })
      }
    },

    setNewFolderName: (v) => set({ newFolderName: v }),

    createFolder: async () => {
      const name = get().newFolderName.trim()
      if (!name || get().busy) return
      set({ busy: true, status: `Creating folder "${name}"…`, error: '' })
      try {
        const res = await invoke('create-folder', name)
        if (res.ok !== true) {
          set({ error: res.error ?? 'Could not create the folder.', status: 'Create failed.' })
          return
        }
        set({
          folders: Array.isArray(res.folders) ? (res.folders as string[]) : get().folders,
          newFolderName: '',
          status: `Created "${name}".`
        })
      } finally {
        set({ busy: false })
      }
    },

    assign: (key, target) => set((s) => ({ assignments: { ...s.assignments, [key]: target } })),
    unassign: (key) =>
      set((s) => {
        const next = { ...s.assignments }
        delete next[key]
        return { assignments: next }
      }),

    fileSuggestedJunk: () => {
      const { plan, assignments } = get()
      const next = { ...assignments }
      let n = 0
      for (const s of plan)
        if (!s.isKnown && s.suggestedTarget === REVIEW_FOLDER && !(s.key in next)) {
          next[s.key] = REVIEW_FOLDER
          n++
        }
      set({
        assignments: next,
        status: n > 0 ? `Filed ${n} suggested-junk sender(s) to ${REVIEW_FOLDER}.` : 'No suggested-junk senders to file.'
      })
    },

    apply: async () => {
      const { plan, assignments, busy } = get()
      if (busy) return

      // moves: assigned new rows with a real folder + known rows auto-filing to a folder.
      const byFolder = new Map<string, string[]>()
      const addMove = (folder: string, ids: string[]): void => {
        if (!folder) return
        const cur = byFolder.get(folder) ?? []
        cur.push(...ids)
        byFolder.set(folder, cur)
      }
      const learn: { entry: string; target: string }[] = []
      for (const s of plan) {
        if (s.isKnown) {
          if (s.currentTarget) addMove(s.currentTarget, s.entryIds)
        } else if (s.key in assignments) {
          const target = assignments[s.key]
          addMove(target, s.entryIds)
          if (s.senderEmail.trim().length > 0) learn.push({ entry: s.senderEmail, target })
        }
      }
      const moves = [...byFolder.entries()].map(([folder, entryIds]) => ({
        folder,
        entryIds: [...new Set(entryIds)]
      }))
      const total = moves.reduce((n, m) => n + m.entryIds.length, 0)

      if (moves.length === 0 && learn.length === 0) {
        set({ status: 'Nothing to apply — file some senders first.' })
        return
      }
      const ok = window.confirm(
        `Apply will move ${total} email(s) into their folders and remember ${learn.length} sender rule(s).\n\n` +
          'The moves can be undone with one click. Nothing is deleted.'
      )
      if (!ok) {
        set({ status: 'Apply cancelled.' })
        return
      }

      set({ busy: true, status: `Filing ${total} email(s)…`, error: '' })
      try {
        const res = await invoke('cleanup', { moves, learn })
        if (res.ok !== true) {
          set({ error: res.error ?? 'Apply failed.', status: 'Apply failed.' })
          return
        }
        set({ status: `Done — filed ${fmtCount(Number(res.moved) || 0)} email(s). Undo available, or Scan again.` })
        // Reload routes (learned) + rescan so the plan reflects the new state.
        const routes = await invoke<Routes>('routes-load')
        set({ routes: routes ?? get().routes })
        await get().refreshUndo()
        await get().scan()
      } finally {
        set({ busy: false })
      }
    },

    undo: async () => {
      if (get().busy || !get().hasUndo) return
      set({ busy: true, status: 'Undoing the last cleanup…', error: '' })
      try {
        const res = await invoke('undo')
        if (res.ok !== true) {
          set({ error: res.error ?? 'Undo failed.', status: 'Undo failed.' })
          return
        }
        const restored = Number(res.restored) || 0
        const retry = Number(res.retry) || 0
        set({
          hasUndo: res.hasUndo === true,
          status:
            retry > 0
              ? restored > 0
                ? `Moved ${restored} back; ${retry} couldn't be reached — click Undo again to retry.`
                : `Couldn't reach Outlook for ${retry} email(s) — click Undo again to retry.`
              : restored > 0
                ? `Undone — moved ${restored} email(s) back to the inbox.`
                : 'Nothing to undo — those items are no longer in their folder.'
        })
        await get().loadHistory()
        if (get().conn === 'connected') await get().scan()
      } finally {
        set({ busy: false })
      }
    },

    refreshUndo: async () => {
      const res = await invoke('has-undo')
      if (res.ok === true) set({ hasUndo: res.hasUndo === true })
    },

    loadHistory: async () => {
      const res = await invoke('history')
      if (res.ok === true) set({ history: Array.isArray(res.batches) ? (res.batches as HistoryBatch[]) : [] })
    },

    /* -------------------------------- drafts ------------------------------- */

    toggleDraft: (entryId) =>
      set((s) => ({ draftSelection: { ...s.draftSelection, [entryId]: !s.draftSelection[entryId] } })),

    clearDraftSelection: () => set({ draftSelection: {} }),

    selectDraftRange: (range) => {
      const rows = get().headers.filter((h) => !rulesEvaluate(h.senderEmail, h.hasListUnsubscribe).isLikelyJunk)
      const startOfToday = new Date()
      startOfToday.setHours(0, 0, 0, 0)
      const next: Record<string, boolean> = {}
      for (const r of rows) {
        if (!r.receivedTime) continue
        const d = new Date(r.receivedTime)
        if (Number.isNaN(d.getTime())) continue
        let inRange = false
        if (range === 'all') inRange = true
        else if (range === 'today') inRange = d >= startOfToday
        else inRange = d.getTime() >= Date.now() - range * 86_400_000
        if (inRange) next[r.entryId] = true
      }
      set({ draftSelection: next })
    },

    setTone: (t) => set({ tone: t }),

    draftSelected: async () => {
      const { headers, draftSelection, tone, busy, hasAiKey } = get()
      if (busy) return
      const rows = headers.filter((h) => draftSelection[h.entryId])
      if (rows.length === 0) {
        set({ status: 'Select one or more emails to draft replies for first.' })
        return
      }
      if (!hasAiKey) {
        set({ error: 'No AI key set. Add a Gemini or DeepSeek key in Settings → API Keys.' })
        return
      }
      const ok = window.confirm(
        `Draft replies for ${rows.length} email(s) using AI?\n\n` +
          'Each message body is sent to Gemini (or DeepSeek). Drafts are saved to your Drafts folder for review — ' +
          'nothing is sent automatically.'
      )
      if (!ok) return

      set({ busy: true, error: '', status: `Drafting ${rows.length} repl${rows.length === 1 ? 'y' : 'ies'}…` })
      let done = 0
      let failed = 0
      let firstErr = ''
      try {
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i]
          set({ status: `Drafting ${i + 1} of ${rows.length}…` })
          const res = await invoke('draft-reply', {
            entryId: r.entryId,
            subject: r.subject,
            fromName: r.senderName,
            fromEmail: r.senderEmail,
            tone
          })
          if (res.ok === true) done++
          else {
            if (res.cancelled) break
            failed++
            if (!firstErr) firstErr = res.error ?? 'unknown error'
          }
        }
        let msg = `Drafted ${done} repl${done === 1 ? 'y' : 'ies'} into your Drafts folder.`
        if (failed > 0) msg += ` ${failed} failed${firstErr ? ` — ${firstErr}` : ''}.`
        set({ status: msg, error: done === 0 && failed > 0 ? firstErr : '' })
      } finally {
        set({ busy: false })
      }
    },

    /* -------------------------------- rules -------------------------------- */

    setRuleEntry: (v) => set({ ruleEntry: v }),
    setRuleTarget: (v) => set({ ruleTarget: v }),
    setSubjectPattern: (v) => set({ subjectPattern: v }),
    setSubjectTarget: (v) => set({ subjectTarget: v }),

    addRoute: async () => {
      const entry = get().ruleEntry.trim().toLowerCase()
      const target = get().ruleTarget
      if (!entry) return
      const routes: Routes = {
        emails: { ...get().routes.emails },
        domains: { ...get().routes.domains },
        subjects: { ...get().routes.subjects }
      }
      let value = entry
      let domainOnly = false
      if (entry.startsWith('*@')) {
        value = entry.slice(2)
        domainOnly = true
      } else if (entry.startsWith('@')) {
        value = entry.slice(1)
        domainOnly = true
      } else if (entry.includes('@')) {
        domainOnly = false
      } else {
        domainOnly = true
      }
      if (!value) return
      if (domainOnly) routes.domains[value] = target
      else routes.emails[value] = target
      const res = await invoke<Ok & { routes: Routes }>('routes-save', routes)
      set({ routes: res.routes ?? routes, ruleEntry: '' })
      rebuildPlan()
    },

    removeRoute: async (entry, kind) => {
      const routes: Routes = {
        emails: { ...get().routes.emails },
        domains: { ...get().routes.domains },
        subjects: { ...get().routes.subjects }
      }
      if (kind === 'email') delete routes.emails[entry]
      else delete routes.domains[entry]
      const res = await invoke<Ok & { routes: Routes }>('routes-save', routes)
      set({ routes: res.routes ?? routes })
      rebuildPlan()
    },

    addSubjectRule: async () => {
      const pattern = get().subjectPattern.trim()
      if (pattern.length < MIN_SUBJECT_PATTERN_LENGTH) {
        set({ error: `Subject patterns must be at least ${MIN_SUBJECT_PATTERN_LENGTH} characters.` })
        return
      }
      const routes: Routes = {
        emails: { ...get().routes.emails },
        domains: { ...get().routes.domains },
        subjects: { ...get().routes.subjects, [pattern]: get().subjectTarget }
      }
      const res = await invoke<Ok & { routes: Routes }>('routes-save', routes)
      set({ routes: res.routes ?? routes, subjectPattern: '' })
      rebuildPlan()
    },

    removeSubjectRule: async (pattern) => {
      const routes: Routes = {
        emails: { ...get().routes.emails },
        domains: { ...get().routes.domains },
        subjects: { ...get().routes.subjects }
      }
      delete routes.subjects[pattern]
      const res = await invoke<Ok & { routes: Routes }>('routes-save', routes)
      set({ routes: res.routes ?? routes })
      rebuildPlan()
    },

    cancel: async () => {
      await invoke('cancel')
    },

    setHasAiKey: (v) => set({ hasAiKey: v })
  }
})
