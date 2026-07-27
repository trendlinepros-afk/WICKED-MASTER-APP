import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { ReportSpec } from './report'

/**
 * Analysis-doc persistence: one JSON per ticker under
 * userData/modules/stock-planner/docs/. Starting an analysis for a ticker
 * reuses its existing doc (report + chat + screenshots survive), matching the
 * ported behavior. Chart screenshots stay data: URLs inside the doc so the
 * renderer can show them under the shell CSP.
 */

export interface ChatMsg {
  role: 'user' | 'assistant'
  text: string
  at: number
  /** count of images attached to a user turn (annotation only) */
  images?: number
}

export interface StockDoc {
  ticker: string
  company: string
  report: ReportSpec | null
  chat: ChatMsg[]
  /** up to 4 chart screenshots as data: URLs (8MB each cap enforced on add) */
  images: string[]
  updatedAt: number
}

const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export class DocStore {
  constructor(private dir: string) {}

  private file(ticker: string): string {
    return join(this.dir, `${ticker.toUpperCase().replace(/[^A-Z0-9.-]/g, '')}.json`)
  }

  get(ticker: string): StockDoc {
    try {
      const raw = JSON.parse(readFileSync(this.file(ticker), 'utf8')) as Partial<StockDoc>
      return {
        ticker: ticker.toUpperCase(),
        company: typeof raw.company === 'string' ? raw.company : '',
        report: (raw.report as ReportSpec) ?? null,
        chat: Array.isArray(raw.chat) ? (raw.chat as ChatMsg[]) : [],
        images: Array.isArray(raw.images) ? (raw.images as string[]).slice(0, MAX_IMAGES) : [],
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
      }
    } catch {
      return { ticker: ticker.toUpperCase(), company: '', report: null, chat: [], images: [], updatedAt: 0 }
    }
  }

  save(doc: StockDoc): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.file(doc.ticker), JSON.stringify({ ...doc, updatedAt: Date.now() }), 'utf8')
  }

  /** Add screenshots (data: URLs); enforces the 4-image / 8MB-each caps. */
  addImages(ticker: string, images: string[]): StockDoc {
    const doc = this.get(ticker)
    for (const img of images) {
      if (typeof img !== 'string' || !img.startsWith('data:image/')) continue
      if (img.length > MAX_IMAGE_BYTES * 1.4) continue // base64 overhead ≈ 4/3
      if (doc.images.length >= MAX_IMAGES) break
      doc.images.push(img)
    }
    this.save(doc)
    return doc
  }

  removeImage(ticker: string, index: number): StockDoc {
    const doc = this.get(ticker)
    doc.images = doc.images.filter((_, i) => i !== index)
    this.save(doc)
    return doc
  }

  list(): { ticker: string; updatedAt: number }[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const t = f.replace(/\.json$/, '')
        return { ticker: t, updatedAt: this.get(t).updatedAt }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }
}
