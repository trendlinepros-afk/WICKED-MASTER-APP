import { create } from 'zustand'
import {
  AI_ADVISOR_EVENT,
  type AdvisorEvent,
  type ChatMeta,
  type Conversation,
  type ToolTrace
} from './types'

const ID = 'ai-advisor'
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args) as Promise<T>

interface StatusRes {
  ok: boolean
  hasKey: boolean
  toolCount: number
  model: string
}
interface ListRes {
  ok: boolean
  conversations?: ChatMeta[]
}
interface OneRes {
  ok: boolean
  conversation?: Conversation | null
  error?: string
}

/** A live tool chip while the advisor is working. */
interface LiveTool {
  name: string
  label: string
  status: 'start' | 'ok' | 'error' | 'declined'
}
interface XGate {
  gateId: string
  name: string
  label: string
}

interface State {
  metas: ChatMeta[]
  currentId: string | null
  convo: Conversation | null
  hasKey: boolean
  toolCount: number
  model: string
  input: string
  streaming: boolean
  liveText: string
  liveTools: LiveTool[]
  xGate: XGate | null
  error: string
  reqId: string | null

  init: () => Promise<void>
  refreshMetas: () => Promise<void>
  select: (id: string) => Promise<void>
  newChat: () => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  remove: (id: string) => Promise<void>
  setInput: (v: string) => void
  send: () => Promise<void>
  stop: () => void
  respondX: (approved: boolean) => Promise<void>
  handleEvent: (e: AdvisorEvent) => void
}

export const useAdvisor = create<State>((set, get) => ({
  metas: [],
  currentId: null,
  convo: null,
  hasKey: true,
  toolCount: 0,
  model: '',
  input: '',
  streaming: false,
  liveText: '',
  liveTools: [],
  xGate: null,
  error: '',
  reqId: null,

  init: async () => {
    const st = await invoke<StatusRes>('status')
    set({ hasKey: !!st.hasKey, toolCount: st.toolCount ?? 0, model: st.model ?? '' })
    const list = await invoke<ListRes>('list')
    const metas = list.conversations ?? []
    set({ metas })
    if (metas.length > 0) await get().select(metas[0].id)
    else await get().newChat()
  },

  refreshMetas: async () => {
    const list = await invoke<ListRes>('list')
    set({ metas: list.conversations ?? [] })
  },

  select: async (id) => {
    if (get().streaming) return
    const res = await invoke<OneRes>('get', id)
    if (res.ok && res.conversation) set({ currentId: id, convo: res.conversation, error: '', liveText: '', liveTools: [] })
  },

  newChat: async () => {
    if (get().streaming) return
    const res = await invoke<OneRes>('new')
    if (res.ok && res.conversation) {
      set({ currentId: res.conversation.id, convo: res.conversation, error: '', liveText: '', liveTools: [] })
      await get().refreshMetas()
    }
  },

  rename: async (id, title) => {
    await invoke<OneRes>('rename', id, title)
    await get().refreshMetas()
    if (get().currentId === id) {
      const c = get().convo
      if (c) set({ convo: { ...c, title } })
    }
  },

  remove: async (id) => {
    await invoke('delete', id)
    await get().refreshMetas()
    if (get().currentId === id) {
      const next = get().metas[0]
      if (next) await get().select(next.id)
      else await get().newChat()
    }
  },

  setInput: (v) => set({ input: v }),

  send: async () => {
    const text = get().input.trim()
    const convo = get().convo
    if (!text || !convo || get().streaming) return
    if (!get().hasKey) {
      set({ error: 'No Anthropic API key set. Add one in Settings → API Keys.' })
      return
    }
    const reqId = crypto.randomUUID()
    // optimistic user message
    const optimistic: Conversation = {
      ...convo,
      title: convo.title === 'New chat' ? text.slice(0, 48) : convo.title,
      messages: [...convo.messages, { role: 'user', text, ts: Date.now() }]
    }
    set({ convo: optimistic, input: '', streaming: true, liveText: '', liveTools: [], xGate: null, error: '', reqId })
    const res = await invoke<OneRes>('send', reqId, convo.id, text)
    if (res.ok && res.conversation) {
      set({ convo: res.conversation, streaming: false, liveText: '', liveTools: [], xGate: null, reqId: null })
      await get().refreshMetas()
    } else {
      set({ streaming: false, xGate: null, reqId: null, error: res.error ?? 'Something went wrong.' })
    }
  },

  stop: () => {
    const reqId = get().reqId
    if (reqId) void invoke('stop', reqId)
  },

  respondX: async (approved) => {
    const gate = get().xGate
    if (!gate) return
    set({ xGate: null })
    await invoke('x-decision', gate.gateId, approved)
  },

  handleEvent: (e) => {
    if (e.requestId !== get().reqId) return
    if (e.type === 'text') set({ liveText: e.text })
    else if (e.type === 'tool') {
      const tools = [...get().liveTools]
      if (e.phase === 'start') tools.push({ name: e.name, label: e.label, status: 'start' })
      else {
        // resolve the most recent still-running chip for this tool
        const last = [...tools].reverse().find((t) => t.name === e.name && t.status === 'start')
        if (last) last.status = e.phase
        else tools.push({ name: e.name, label: e.label, status: e.phase })
      }
      set({ liveTools: tools })
    } else if (e.type === 'x-confirm') set({ xGate: { gateId: e.gateId, name: e.name, label: e.label } })
    else if (e.type === 'error') set({ error: e.error, streaming: false, xGate: null })
    // 'done' is handled by the awaited send() result
  }
}))

export type { LiveTool, XGate, ToolTrace }
