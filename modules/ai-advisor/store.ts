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

export interface ModelOption {
  id: string
  label: string
  provider: string
  hint: string
  hasKey: boolean
}
interface StatusRes {
  ok: boolean
  hasKey: boolean
  toolCount: number
  model: string
  modelLabel?: string
  provider?: string
  models?: ModelOption[]
}
interface ListRes {
  ok: boolean
  conversations?: ChatMeta[]
}
interface OneRes {
  ok: boolean
  conversation?: Conversation | null
  error?: string
  /** on a failed send, the user's text to put back in the composer */
  restore?: string
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
  modelLabel: string
  provider: string
  models: ModelOption[]
  input: string
  /** pasted screenshots (data URLs) waiting to be sent, max 3 */
  pendingImages: string[]
  streaming: boolean
  liveText: string
  liveTools: LiveTool[]
  xGate: XGate | null
  error: string
  reqId: string | null

  init: () => Promise<void>
  refreshMetas: () => Promise<void>
  setModel: (id: string) => Promise<void>
  select: (id: string) => Promise<void>
  newChat: () => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  archive: (id: string, archived: boolean) => Promise<void>
  remove: (id: string) => Promise<void>
  setInput: (v: string) => void
  addImages: (urls: string[]) => void
  removeImage: (index: number) => void
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
  modelLabel: '',
  provider: 'anthropic',
  models: [],
  input: '',
  pendingImages: [],
  streaming: false,
  liveText: '',
  liveTools: [],
  xGate: null,
  error: '',
  reqId: null,

  init: async () => {
    const st = await invoke<StatusRes>('status')
    set({
      hasKey: !!st.hasKey,
      toolCount: st.toolCount ?? 0,
      model: st.model ?? '',
      modelLabel: st.modelLabel ?? st.model ?? '',
      provider: st.provider ?? 'anthropic',
      models: st.models ?? []
    })
    const list = await invoke<ListRes>('list')
    const metas = list.conversations ?? []
    set({ metas })
    const active = metas.filter((m) => !m.archived)
    if (active.length > 0) await get().select(active[0].id)
    else await get().newChat()
  },

  refreshMetas: async () => {
    const list = await invoke<ListRes>('list')
    set({ metas: list.conversations ?? [] })
  },

  setModel: async (id) => {
    await invoke('set-model', id)
    const st = await invoke<StatusRes>('status')
    set({
      model: st.model ?? id,
      modelLabel: st.modelLabel ?? st.model ?? '',
      provider: st.provider ?? get().provider,
      hasKey: !!st.hasKey,
      models: st.models ?? get().models
    })
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

  archive: async (id, archived) => {
    await invoke('archive', id, archived)
    await get().refreshMetas()
    if (archived && get().currentId === id) {
      const next = get().metas.find((m) => !m.archived)
      if (next) await get().select(next.id)
      else await get().newChat()
    }
  },

  remove: async (id) => {
    await invoke('delete', id)
    await get().refreshMetas()
    if (get().currentId === id) {
      const next = get().metas.find((m) => !m.archived)
      if (next) await get().select(next.id)
      else await get().newChat()
    }
  },

  setInput: (v) => set({ input: v }),

  addImages: (urls) => set({ pendingImages: [...get().pendingImages, ...urls].slice(0, 3) }),
  removeImage: (index) => set({ pendingImages: get().pendingImages.filter((_, i) => i !== index) }),

  send: async () => {
    const text = get().input.trim()
    const images = get().pendingImages
    const convo = get().convo
    if ((!text && images.length === 0) || !convo || get().streaming) return
    if (!get().hasKey) {
      set({ error: 'No Anthropic API key set. Add one in Settings → API Keys.' })
      return
    }
    const reqId = crypto.randomUUID()
    // optimistic user message
    const optimistic: Conversation = {
      ...convo,
      title: convo.title === 'New chat' ? (text || 'Screenshot').slice(0, 48) : convo.title,
      messages: [...convo.messages, { role: 'user', text, ts: Date.now(), ...(images.length ? { images } : {}) }]
    }
    set({
      convo: optimistic,
      input: '',
      pendingImages: [],
      streaming: true,
      liveText: '',
      liveTools: [],
      xGate: null,
      error: '',
      reqId
    })
    const res = await invoke<OneRes>('send', reqId, convo.id, text, images)
    if (res.ok && res.conversation) {
      set({ convo: res.conversation, streaming: false, liveText: '', liveTools: [], xGate: null, reqId: null })
      await get().refreshMetas()
    } else {
      // failed turn: drop the optimistic user bubble (server rolled it back too)
      // and put the text back in the composer so it's easy to resend.
      set({
        streaming: false,
        liveText: '',
        liveTools: [],
        xGate: null,
        reqId: null,
        error: res.error ?? 'Something went wrong.',
        ...(res.conversation ? { convo: res.conversation } : {}),
        input: get().input.trim() ? get().input : (res.restore ?? ''),
        // a failed turn must not eat the pasted screenshots either
        pendingImages: get().pendingImages.length > 0 ? get().pendingImages : images
      })
      await get().refreshMetas()
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
