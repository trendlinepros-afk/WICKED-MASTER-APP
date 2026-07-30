/** Shared types for AI Advisor — used by both main (ipc) and renderer. */

/** A record of one tool the advisor called during an assistant turn (display only). */
export interface ToolTrace {
  /** MCP tool name, e.g. "stock-planner__ticker-data" */
  name: string
  /** friendly label, e.g. "Stock Planner · ticker data" */
  label: string
  status: 'ok' | 'error' | 'declined'
  /** short note about the result/error */
  summary?: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  /** tools used to produce an assistant message */
  tools?: ToolTrace[]
  /** token usage for an assistant turn, summed across all tool rounds */
  usage?: { input: number; output: number }
  /** estimated USD cost for the turn */
  costUsd?: number
  /** model id that produced the message */
  model?: string
  ts: number
}

export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  /** archived chats are tucked into a dropdown in the sidebar */
  archived?: boolean
}

/** Lightweight conversation summary for the sidebar list. */
export interface ChatMeta {
  id: string
  title: string
  updatedAt: number
  count: number
  archived: boolean
}

/** Streaming events pushed main → renderer during a send (channel = AI_ADVISOR_EVENT). */
export type AdvisorEvent =
  | { requestId: string; type: 'text'; text: string }
  | { requestId: string; type: 'tool'; name: string; label: string; phase: 'start' | 'ok' | 'error' | 'declined' }
  | { requestId: string; type: 'x-confirm'; gateId: string; name: string; label: string }
  | { requestId: string; type: 'done' }
  | { requestId: string; type: 'error'; error: string }

export const AI_ADVISOR_EVENT = 'ai-advisor:event'

/** "stock-planner__ticker-data" → "Stock Planner · ticker data". */
export function toolLabel(name: string): string {
  const [mod, action = ''] = name.split('__')
  const title = (s: string): string => s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return action ? `${title(mod)} · ${action.replace(/-/g, ' ')}` : title(mod)
}
