import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for the Performance Analyzer. Every tool calls the same channel the
 * UI does (ipc.ts). Capturing is on demand only — start-capture runs a hidden
 * sampler until stop-capture (or the auto-stop timer). Reading saved sessions
 * is read-only; deleting them is destructive and confirm-gated.
 */
const ID = 'perf-analyzer'

type Q = {
  ok: boolean
  from: number
  to: number
  resolution: string
  totals: { avg: Record<string, number | null>; max: Record<string, number | null>; tempMax: number | null; samples: number }
  apps: { key: string; n: number; avg: Record<string, number>; max: Record<string, number> }[]
  spikes: { metric: string; t: number; value: number; app: string | null; appValue: number; ms: number }[]
  meta: Record<string, { name?: string; company?: string; signed?: string; path?: string }>
  sessions: { id: string; start: number; end: number }[]
  totalMem: number
}

const iso = (t: number): string => new Date(t).toISOString()
const parseTime = (v: unknown, fallback: number): number => {
  if (v === undefined || v === null || v === '') return fallback
  const t = typeof v === 'number' ? v : Date.parse(String(v))
  return Number.isFinite(t) ? t : fallback
}

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__status`,
      description: 'Whether a performance capture is running (since when, sample interval, latest CPU/memory/GPU/disk %), capture settings, and how many saved sessions exist. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:status`)
    },
    {
      name: `${ID}__start-capture`,
      description:
        'Start recording system performance (CPU, memory, GPU, disk, temperature and per-app usage) on this Windows PC. Runs a lightweight hidden sampler until __stop-capture or the auto-stop time in settings. Data is saved locally as a session. No-op if already capturing.',
      inputSchema: { intervalMs: z.union([z.literal(1000), z.literal(2000), z.literal(5000), z.literal(10000)]).optional().describe('Sample interval; defaults to the setting (2 s).') },
      handler: (args) => ctx.invoke(`${ID}:start`, { intervalMs: args.intervalMs })
    },
    {
      name: `${ID}__stop-capture`,
      description: 'Stop the running performance capture and save the session.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:stop`)
    },
    {
      name: `${ID}__sessions`,
      description: 'List saved capture sessions (start, end, interval, sample count, peak CPU/memory/GPU). Read-only.',
      inputSchema: {},
      handler: async () => {
        const r = (await ctx.invoke(`${ID}:sessions`)) as { items: { start: number; end: number }[] }
        return { ...r, items: r.items.map((s) => ({ ...s, startIso: iso(s.start), endIso: iso(s.end) })) }
      }
    },
    {
      name: `${ID}__summary`,
      description:
        'Summarise recorded performance for a time window: average/peak CPU, memory, GPU and disk; the apps using the most of each (name, publisher, signature, instances, average and peak); and every spike (time, how long, value, the app most to blame). Times are ISO-8601 or epoch ms; defaults to the last hour. Read-only.',
      inputSchema: {
        from: z.string().optional().describe('Start (ISO-8601). Default: one hour before `to`.'),
        to: z.string().optional().describe('End (ISO-8601). Default: now.'),
        topApps: z.number().int().min(1).max(30).optional()
      },
      handler: async (args) => {
        const to = parseTime(args.to, Date.now())
        const from = parseTime(args.from, to - 3600_000)
        if (!(to > from)) return { ok: false, error: '`from` must be before `to`.' }
        const q = (await ctx.invoke(`${ID}:query`, { from, to, buckets: 360 })) as Q
        const k = (args.topApps as number | undefined) ?? 8
        const name = (key: string): string => q.meta[key]?.name || `${key}.exe`
        const top = (m: string) =>
          [...q.apps]
            .sort((a, b) => b.avg[m] - a.avg[m])
            .slice(0, k)
            .filter((a) => a.avg[m] > 0 || a.max[m] > 0)
            .map((a) => ({ app: name(a.key), exe: a.key, publisher: q.meta[a.key]?.company || '', signature: q.meta[a.key]?.signed || 'unknown', instances: a.n, average: a.avg[m], peak: a.max[m] }))
        return {
          ok: true,
          from: iso(q.from),
          to: iso(q.to),
          samples: q.totals.samples,
          note: q.totals.samples ? undefined : 'Nothing was recorded in this window (no capture was running).',
          units: { cpu: '% of all cores', mem: '% of RAM', gpu: '% (busiest engine)', disk: 'active time % (apps: I/O bytes/s)' },
          totalMemBytes: q.totalMem,
          average: q.totals.avg,
          peak: q.totals.max,
          maxTempC: q.totals.tempMax,
          topApps: { cpu: top('cpu'), mem: top('mem'), gpu: top('gpu'), disk: top('disk') },
          spikes: q.spikes.map((s) => ({ metric: s.metric, at: iso(s.t), lastedSec: Math.round(s.ms / 1000), value: s.value, app: s.app ? name(s.app) : null, appValue: s.appValue })),
          sessions: q.sessions.map((s) => ({ id: s.id, start: iso(s.start), end: iso(s.end) }))
        }
      }
    },
    {
      name: `${ID}__moment`,
      description: 'Every app recorded in a short time slice (e.g. around a spike from __summary), with CPU %, memory bytes, GPU %, I/O bytes/s and instance count. Read-only.',
      inputSchema: { from: z.string().describe('ISO-8601'), to: z.string().describe('ISO-8601') },
      handler: (args) => ctx.invoke(`${ID}:moment`, { from: parseTime(args.from, NaN), to: parseTime(args.to, NaN) })
    },
    {
      name: `${ID}__export-summary`,
      description:
        'Write a PDF report of a capture session — a plain-English account of what was seen (load, memory, GPU, disk, temperature), KPI tiles, a chart of the session, every spike and the program behind it, the heaviest programs per resource, unsigned programs and programs started. Saved to Documents/WICKED Performance; returns the file path. Default: the latest session (a running capture is reported up to now). Session ids come from __sessions.',
      inputSchema: { id: z.string().optional() },
      handler: (args) => ctx.invoke(`${ID}:export-summary`, { id: args.id, mode: 'auto' })
    },
    {
      name: `${ID}__delete-sessions`,
      description: 'Permanently delete saved capture sessions (their recorded data). Session ids come from __sessions; `all: true` deletes every finished session. A running capture is never deleted. Destructive. Requires confirmation.',
      destructive: true,
      inputSchema: { ids: z.array(z.string()).optional(), all: z.boolean().optional(), confirm: z.boolean().optional() },
      handler: (args) => {
        const ids = (args.ids as string[] | undefined) ?? []
        if (!args.all && !ids.length) return { ok: false, error: 'Give session ids or all: true.' }
        const gate = ctx.confirm(args.confirm as boolean | undefined, args.all ? 'Permanently delete every saved performance session.' : `Permanently delete ${ids.length} saved performance session(s).`)
        if (gate) return gate
        return ctx.invoke(`${ID}:delete-sessions`, args.all ? { all: true } : { ids })
      }
    }
  ]
}
