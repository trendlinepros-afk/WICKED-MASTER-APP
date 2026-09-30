import { nativeImage } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { basename, extname, join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import type { Format, GenerateRequest, Generated, ImageRef, Job, KeyCheckResult, KeyStatus, LibraryItem, LibraryKind, Model, ModuleSettings, Score, TitleResult, YtLookup } from './types'
import { DEFAULT_SETTINGS, MODELS, modelInfo, modelRestriction, slug } from './lib/models'
import { PikzelsClient, PikzelsError, type CreditInfo, type ThumbnailOut } from './ipc/pikzels'
import { lookupYouTube } from './ipc/youtube'
import { fetchRemotePreview, type Shrunk } from './ipc/remote-image'

/* ------------------------------------------------------------------------ *
 *  THUMBNAIL GENERATOR — Pikzels v2 in a desktop UI.
 *
 *  Every generated image is downloaded the moment Pikzels returns it (output
 *  URLs die after ~24 h) into <Downloads>/Thumbnail Generator (or a folder the
 *  user picks). Personas and themes ("styles" in the API) are trained here and
 *  remembered in library.json + small preview copies under library/<id>/ —
 *  that folder rides along with WICKED Backup / Cloud Sync, so the same
 *  personas and themes appear on every PC that signs in to the same sync.
 *  The API key comes from the shell vault (Settings → API Keys → Pikzels) and
 *  never reaches the renderer.
 * ------------------------------------------------------------------------ */

const ID = 'thumbnail-generator'
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const HISTORY_MAX = 300
const POLL_MS = 5000
const POLL_MAX_MS = 20 * 60_000

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const PREVIEW_MAX_W = 640
const PREVIEW_CACHE_MAX = 400
const PREVIEW_PARALLEL = 6

/** Scale a web image down for on-screen previews (JPEG, or PNG to keep transparency). */
function shrinkForPreview(buf: Buffer, mime: string): Shrunk | null {
  try {
    let img = nativeImage.createFromBuffer(buf)
    if (img.isEmpty()) return null
    if (img.getSize().width > PREVIEW_MAX_W) img = img.resize({ width: PREVIEW_MAX_W, quality: 'good' })
    return mime === 'image/png' ? { data: img.toPNG(), mime: 'image/png' } : { data: img.toJPEG(82), mime: 'image/jpeg' }
  } catch {
    return null
  }
}

export default function register(ctx: ModuleIpcContext): void {
  const dataDir = join(ctx.app.getPath('userData'), 'modules', ID)
  const libDir = join(dataDir, 'library')
  const libraryPath = join(dataDir, 'library.json')
  const historyPath = join(dataDir, 'history.json')
  mkdirSync(libDir, { recursive: true })

  const send = (channel: string, payload: unknown): void => {
    ctx.getMainWindow()?.webContents.send(`${ID}:${channel}`, payload)
  }
  const readJson = <T>(path: string, fallback: T): T => {
    try {
      return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback
    } catch {
      return fallback
    }
  }
  const writeJson = (path: string, v: unknown): void => {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(v, null, 2))
    renameSync(tmp, path)
  }

  /* ------------------------------- settings ------------------------------- */

  const settings = (): ModuleSettings => {
    const saved = ctx.storeGet<Partial<ModuleSettings>>(`${ID}.settings`, {})
    return { ...DEFAULT_SETTINGS, ...saved, creditsPerModel: { ...DEFAULT_SETTINGS.creditsPerModel, ...(saved.creditsPerModel ?? {}) } }
  }
  const saveSettings = (patch: Partial<ModuleSettings>): ModuleSettings => {
    const next = { ...settings(), ...patch }
    ctx.storeSet(`${ID}.settings`, next)
    return next
  }
  const downloadDir = (): string => settings().downloadDir || join(ctx.app.getPath('downloads'), 'Thumbnail Generator')

  const client = (): PikzelsClient => {
    const key = ctx.getApiKey('pikzels')
    if (!key) throw new PikzelsError(401, 'No Pikzels API key — add it in Settings → API Keys → Pikzels.')
    return new PikzelsClient(key)
  }

  /** Remember what the API tells us about credits (costs per model, balance). */
  const noteCredits = (c: CreditInfo, model?: Model): void => {
    const patch: Partial<ModuleSettings> = {}
    if (c.remaining != null) patch.creditsRemaining = c.remaining
    if (c.used != null && model && MODELS.some((m) => m.id === model)) patch.creditsPerModel = { ...settings().creditsPerModel, [model]: c.used }
    if (Object.keys(patch).length) {
      saveSettings(patch)
      send('settings', settings())
    }
  }

  /* -------------------------------- images -------------------------------- */

  const mimeOf = (p: string): string => {
    const e = extname(p).toLowerCase()
    return e === '.png' ? 'image/png' : e === '.webp' ? 'image/webp' : e === '.gif' ? 'image/gif' : 'image/jpeg'
  }
  const fileB64 = (p: string): string => {
    const st = statSync(p)
    if (st.size > MAX_IMAGE_BYTES) throw new Error(`${basename(p)} is ${(st.size / 1048576).toFixed(1)} MB — keep images under 12 MB.`)
    return readFileSync(p).toString('base64')
  }
  const dataUrl = (p: string): string => `data:${mimeOf(p)};base64,${fileB64(p)}`

  /** {image_url} or {image_base64} for a request field pair */
  const imageFields = (ref: ImageRef | undefined, urlKey: string, b64Key: string): Record<string, string> => {
    if (!ref) return {}
    if (ref.url) return { [urlKey]: ref.url }
    if (ref.path) return { [b64Key]: fileB64(ref.path) }
    return {}
  }

  async function downloadOutput(url: string, dir: string, baseName: string): Promise<{ file: string; fileName: string }> {
    const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!resp.ok) throw new Error(`Could not download the result (HTTP ${resp.status})`)
    const ct = resp.headers.get('content-type') ?? ''
    const ext = /png/.test(ct) ? '.png' : /webp/.test(ct) ? '.webp' : /jpe?g/.test(ct) ? '.jpg' : extname(new URL(url).pathname) || '.png'
    mkdirSync(dir, { recursive: true })
    let fileName = `${baseName}${ext}`
    for (let i = 2; existsSync(join(dir, fileName)); i++) fileName = `${baseName} (${i})${ext}`
    const file = join(dir, fileName)
    writeFileSync(file, Buffer.from(await resp.arrayBuffer()))
    return { file, fileName }
  }

  const stamp = (): string => {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`
  }

  /* -------------------------------- history -------------------------------- */

  let history: Generated[] = readJson<Generated[]>(historyPath, []).map((g) => ({ ...g, status: g.status === 'done' || g.status === 'failed' ? g.status : 'failed' }))
  const saveHistory = (): void => writeJson(historyPath, history.slice(0, HISTORY_MAX))
  const recordHistory = (g: Generated): void => {
    history = [g, ...history.filter((x) => x.id !== g.id)].slice(0, HISTORY_MAX)
    saveHistory()
  }

  /* --------------------------------- jobs --------------------------------- */

  const jobs = new Map<string, Job & { ac: AbortController }>()
  let jobTimer: NodeJS.Timeout | null = null
  const pushJob = (job: Job): void => {
    if (jobTimer) return
    jobTimer = setTimeout(() => {
      jobTimer = null
      send('job', { id: job.id, at: job.at, items: job.items, done: job.done, cancelled: job.cancelled })
    }, 120)
  }

  function validate(req: GenerateRequest): void {
    if (!MODELS.some((m) => m.id === req.model)) throw new Error('Pick a model.')
    if (!['16:9', '9:16', '1:1'].includes(req.format)) throw new Error('Pick a format.')
    if (req.mode === 'text' && !req.prompt.trim()) throw new Error('Write a prompt first.')
    if (req.mode === 'image' && !req.image?.url && !req.image?.path) throw new Error('Add a YouTube link or an image to recreate.')
    const why = modelRestriction(req.model, { persona: !!req.personaId, style: !!req.styleId, recreateWithPrompt: req.mode === 'image' && !!req.prompt.trim(), imageWeight: !!req.imageWeight })
    if (why) throw new Error(why)
    if (req.count < 1 || req.count > 10) throw new Error('Generate between 1 and 10 thumbnails at a time.')
  }

  async function runOne(api: PikzelsClient, req: GenerateRequest, g: Generated, signal: AbortSignal): Promise<void> {
    g.status = 'running'
    const support = imageFields(req.support, 'support_image_url', 'support_image_base64')
    let out: ThumbnailOut
    if (req.mode === 'text') {
      out = await api.thumbnailText({ prompt: req.prompt.trim(), model: req.model, format: req.format, ...support, persona: req.personaId, style: req.styleId }, signal)
    } else {
      out = await api.thumbnailImage(
        {
          ...imageFields(req.image, 'image_url', 'image_base64'),
          model: req.model,
          format: req.format,
          prompt: req.prompt.trim() || undefined,
          image_weight: req.imageWeight,
          ...support,
          persona: req.personaId,
          style: req.styleId
        },
        signal
      )
    }
    if (signal.aborted) throw new PikzelsError(0, 'Cancelled')
    g.outputUrl = out.output
    g.promptCompacted = out.prompt_compacted
    g.requestId = out.request_id
    g.model = out.model || req.model
    g.creditsUsed = out.credits.used
    noteCredits(out.credits, req.model)
    const base = `${stamp()} ${slug(req.prompt || (req.image?.label ?? 'recreate'))}${req.count > 1 ? ` v${g.index + 1}` : ''}`
    const dl = await downloadOutput(out.output, downloadDir(), base)
    g.file = dl.file
    g.fileName = dl.fileName
    g.status = 'done'
  }

  function startJob(req: GenerateRequest): Job {
    validate(req)
    const api = client()
    const ac = new AbortController()
    const job: Job & { ac: AbortController } = { id: randomUUID(), at: Date.now(), items: [], done: false, cancelled: false, ac }
    for (let i = 0; i < req.count; i++)
      job.items.push({
        id: randomUUID(),
        jobId: job.id,
        index: i,
        at: job.at,
        kind: req.mode,
        prompt: req.prompt.trim(),
        promptCompacted: '',
        model: req.model,
        format: req.format,
        personaId: req.personaId ?? '',
        styleId: req.styleId ?? '',
        status: 'queued',
        file: '',
        fileName: '',
        outputUrl: '',
        requestId: '',
        creditsUsed: null,
        error: '',
        score: null
      })
    jobs.set(job.id, job)
    const conc = Math.max(1, Math.min(5, settings().concurrency))
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < job.items.length && !ac.signal.aborted) {
        const g = job.items[next++]
        pushJob(job)
        try {
          await runOne(api, req, g, ac.signal)
        } catch (err) {
          g.status = 'failed'
          g.error = errMsg(err)
        }
        recordHistory(g)
        pushJob(job)
      }
    }
    void Promise.all(Array.from({ length: Math.min(conc, job.items.length) }, worker)).then(() => {
      for (const g of job.items)
        if (g.status === 'queued' || g.status === 'running') {
          g.status = 'failed'
          g.error = 'Cancelled'
          recordHistory(g)
        }
      job.done = true
      pushJob(job)
      setTimeout(() => jobs.delete(job.id), 10 * 60_000)
    })
    return job
  }

  /* -------------------------------- library -------------------------------- */

  let library: LibraryItem[] = readJson<LibraryItem[]>(libraryPath, [])
  const saveLibrary = (): void => {
    writeJson(libraryPath, library)
    send('library', library)
  }
  const polling = new Set<string>()

  async function pollItem(id: string): Promise<void> {
    if (polling.has(id)) return
    polling.add(id)
    const started = Date.now()
    try {
      for (;;) {
        const item = library.find((x) => x.id === id)
        if (!item) return
        let st
        try {
          st = await client().getPikzonality(id)
        } catch (err) {
          if (err instanceof PikzelsError && err.status === 404) {
            item.status = 'failed'
            item.error = 'Pikzels no longer knows this id (deleted?).'
            item.updatedAt = Date.now()
            saveLibrary()
            return
          }
          // transient — keep waiting
          await new Promise((r) => setTimeout(r, POLL_MS))
          if (Date.now() - started > POLL_MAX_MS) {
            item.error = `Still couldn’t reach Pikzels after 20 min: ${errMsg(err)}`
            saveLibrary()
            return
          }
          continue
        }
        item.status = st.status
        item.progress = st.status === 'completed' ? 100 : st.progress
        item.error = st.status === 'failed' ? st.error || 'Training failed on Pikzels’ side.' : ''
        item.updatedAt = Date.now()
        saveLibrary()
        if (st.status !== 'processing') return
        if (Date.now() - started > POLL_MAX_MS) {
          item.error = 'Still training after 20 min — press Refresh later.'
          saveLibrary()
          return
        }
        await new Promise((r) => setTimeout(r, POLL_MS))
      }
    } finally {
      polling.delete(id)
    }
  }
  // resume polling for anything left training when the app closed
  for (const it of library) if (it.status === 'processing') void pollItem(it.id)

  /* ---------------------------------- IPC ---------------------------------- */

  const h = ctx.ipcMain

  h.handle(`${ID}:key-status`, (): KeyStatus => ({ hasKey: !!ctx.getApiKey('pikzels') }))
  h.handle(`${ID}:key-check`, async (): Promise<KeyCheckResult> => {
    const key = ctx.getApiKey('pikzels')
    if (!key) return { hasKey: false, state: 'missing', message: 'No Pikzels key in the WICKED vault yet — add it under Settings → API Keys → Pikzels.', at: Date.now() }
    const r = await new PikzelsClient(key).checkKey()
    return { hasKey: true, state: r.state, message: r.message, at: Date.now() }
  })
  h.handle(`${ID}:settings`, (): ModuleSettings => settings())
  h.handle(`${ID}:settings-set`, (_e, patch: Partial<ModuleSettings>) => {
    const clean: Partial<ModuleSettings> = {}
    if (typeof patch?.downloadDir === 'string') clean.downloadDir = patch.downloadDir
    if (patch?.creditsPerModel) {
      const cur = settings().creditsPerModel
      for (const m of MODELS) {
        const v = Number(patch.creditsPerModel[m.id])
        if (Number.isFinite(v) && v >= 0) cur[m.id] = v
      }
      clean.creditsPerModel = cur
    }
    for (const k of ['creditsPersona', 'creditsStyle', 'creditsTitle', 'creditsScore', 'creditsEdit', 'planPrice', 'planCredits'] as const) {
      const v = Number(patch?.[k])
      if (patch?.[k] !== undefined && Number.isFinite(v) && v >= 0) clean[k] = v
    }
    if (patch?.concurrency !== undefined) clean.concurrency = Math.max(1, Math.min(5, Math.round(Number(patch.concurrency)) || 2))
    return saveSettings(clean)
  })

  h.handle(`${ID}:choose-download-dir`, async () => {
    const win = ctx.getMainWindow()
    const opts = { title: 'Where should thumbnails be saved?', defaultPath: downloadDir(), properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const r = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return settings()
    return saveSettings({ downloadDir: r.filePaths[0] })
  })

  h.handle(`${ID}:download-dir`, () => downloadDir())

  h.handle(`${ID}:pick-images`, async (_e, a?: { multi?: boolean; title?: string }) => {
    const win = ctx.getMainWindow()
    const opts = {
      title: a?.title ?? 'Choose images',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      properties: (a?.multi === false ? ['openFile'] : ['openFile', 'multiSelections']) as ('openFile' | 'multiSelections')[]
    }
    const r = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
    if (r.canceled) return { ok: true, images: [] as ImageRef[] }
    const images: ImageRef[] = []
    const errors: string[] = []
    for (const p of r.filePaths) {
      try {
        images.push({ path: p, label: basename(p), preview: dataUrl(p) })
      } catch (err) {
        errors.push(errMsg(err))
      }
    }
    return { ok: true, images, error: errors.join(' ') }
  })

  h.handle(`${ID}:preview`, (_e, a: { path: string }) => {
    try {
      return { ok: true, dataUrl: dataUrl(String(a?.path ?? '')) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:generate`, (_e, req: GenerateRequest) => {
    try {
      const job = startJob({ ...req, count: Math.round(Number(req?.count) || 1) })
      return { ok: true, job: { id: job.id, at: job.at, items: job.items, done: job.done, cancelled: job.cancelled } }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:cancel`, (_e, a: { jobId: string }) => {
    const job = jobs.get(a?.jobId)
    if (!job) return { ok: false }
    job.cancelled = true
    job.ac.abort()
    return { ok: true }
  })

  h.handle(`${ID}:edit`, async (_e, a: { prompt: string; image: ImageRef; mask?: ImageRef; support?: ImageRef; format?: Format }) => {
    try {
      if (!a?.prompt?.trim()) throw new Error('Describe the edit first.')
      if (!a.image?.path && !a.image?.url) throw new Error('Choose the image to edit.')
      const api = client()
      const out = await api.thumbnailEdit({
        prompt: a.prompt.trim(),
        ...imageFields(a.image, 'image_url', 'image_base64'),
        format: a.format,
        ...imageFields(a.mask, 'mask_url', 'mask_base64'),
        ...imageFields(a.support, 'support_image_url', 'support_image_base64')
      })
      noteCredits(out.credits)
      const dl = await downloadOutput(out.output, downloadDir(), `${stamp()} edit ${slug(a.prompt)}`)
      const g: Generated = {
        id: randomUUID(),
        jobId: '',
        index: 0,
        at: Date.now(),
        kind: 'edit',
        prompt: a.prompt.trim(),
        promptCompacted: out.prompt_compacted,
        model: out.model || 'edit',
        format: a.format ?? '16:9',
        personaId: '',
        styleId: '',
        status: 'done',
        file: dl.file,
        fileName: dl.fileName,
        outputUrl: out.output,
        requestId: out.request_id,
        creditsUsed: out.credits.used,
        error: '',
        score: null
      }
      recordHistory(g)
      return { ok: true, item: g }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:score`, async (_e, a: { image?: ImageRef; generatedId?: string; title?: string }) => {
    try {
      const api = client()
      let ref = a?.image
      const g = a?.generatedId ? history.find((x) => x.id === a.generatedId) : undefined
      if (g?.file && existsSync(g.file)) ref = { path: g.file }
      if (!ref?.path && !ref?.url) throw new Error('Choose an image to score.')
      const r = await api.thumbnailScore({ ...imageFields(ref, 'image_url', 'image_base64'), title: a?.title?.trim() || undefined })
      noteCredits(r.credits)
      const score: Score = { main: r.main_score, subscores: r.subscores, suggestion: r.suggestion }
      if (g) {
        g.score = score
        recordHistory(g)
      }
      return { ok: true, score }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:titles`, async (_e, a: { prompt?: string; image?: ImageRef }) => {
    try {
      if (!a?.prompt?.trim() && !a?.image?.path && !a?.image?.url) throw new Error('Give a topic or an image.')
      const r = await client().titleText({ prompt: a.prompt?.trim() || undefined, ...imageFields(a.image, 'support_image_url', 'support_image_base64') })
      noteCredits(r.credits)
      const out: TitleResult = { outputs: r.outputs, reasoning: r.reasoning, promptCompacted: r.prompt_compacted }
      return { ok: true, result: out }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /* ------------------------------ library IPC ------------------------------ */

  const libView = (): LibraryItem[] => [...library].sort((a, b) => b.createdAt - a.createdAt)

  h.handle(`${ID}:library`, () => ({ ok: true, items: libView() }))

  h.handle(`${ID}:train`, async (_e, a: { kind: LibraryKind; name: string; images: ImageRef[]; specialInstructions?: string; sourceUrl?: string }) => {
    try {
      const kind: LibraryKind = a?.kind === 'style' ? 'style' : 'persona'
      const name = String(a?.name ?? '').trim().slice(0, 80)
      if (!name) throw new Error(`Give the ${kind === 'style' ? 'theme' : 'persona'} a name.`)
      const imgs = (a?.images ?? []).filter((i) => i && (i.path || i.url))
      if (imgs.length !== 3) throw new Error(`Pikzels trains a ${kind === 'style' ? 'theme' : 'persona'} from exactly 3 images — you picked ${imgs.length}.`)
      const api = client()
      const allUrls = imgs.every((i) => !!i.url)
      const created = await api.createPikzonality(kind, name, allUrls ? { urls: imgs.map((i) => i.url!) } : { base64s: imgs.map((i) => (i.path ? fileB64(i.path) : '')) })
      noteCredits(created.credits)
      // keep previews so the library looks the same on every PC
      const dir = join(libDir, created.id)
      mkdirSync(dir, { recursive: true })
      const previews: string[] = []
      for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i]
        try {
          if (img.path) {
            const ext = extname(img.path).toLowerCase() || '.jpg'
            copyFileSync(img.path, join(dir, `${i + 1}${ext}`))
            previews.push(`${i + 1}${ext}`)
          } else if (img.url) {
            const resp = await fetch(img.url, { signal: AbortSignal.timeout(20_000) })
            if (resp.ok) {
              writeFileSync(join(dir, `${i + 1}.jpg`), Buffer.from(await resp.arrayBuffer()))
              previews.push(`${i + 1}.jpg`)
            }
          }
        } catch {
          /* previews are cosmetic */
        }
      }
      const item: LibraryItem = {
        id: created.id,
        kind,
        name,
        ...(created.name !== name ? { pikzelsName: created.name } : {}),
        status: 'processing',
        progress: 0,
        specialInstructions: '',
        instructionHistory: [],
        previews,
        source: a?.sourceUrl ? 'youtube' : 'files',
        sourceUrl: a?.sourceUrl ?? '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        error: ''
      }
      library = [item, ...library.filter((x) => x.id !== item.id)]
      saveLibrary()
      const instr = String(a?.specialInstructions ?? '').trim()
      void pollItem(item.id).then(async () => {
        const cur = library.find((x) => x.id === item.id)
        if (instr && cur && cur.status === 'completed') {
          try {
            await api.patchPikzonality(item.id, instr)
            cur.specialInstructions = instr
            cur.instructionHistory = [{ at: Date.now(), text: instr }]
            saveLibrary()
          } catch (err) {
            cur.error = `Trained, but the special instructions were not saved: ${errMsg(err)}`
            saveLibrary()
          }
        }
      })
      return { ok: true, item, ...(created.name !== name ? { pikzelsName: created.name } : {}) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:refresh-item`, async (_e, a: { id: string }) => {
    const item = library.find((x) => x.id === a?.id)
    if (!item) return { ok: false, error: 'Not in the library.' }
    try {
      const st = await client().getPikzonality(item.id)
      item.status = st.status
      item.progress = st.status === 'completed' ? 100 : st.progress
      item.error = st.status === 'failed' ? st.error || 'Training failed.' : ''
      item.updatedAt = Date.now()
      saveLibrary()
      if (st.status === 'processing') void pollItem(item.id)
      return { ok: true, item }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:set-instructions`, async (_e, a: { id: string; text: string }) => {
    const item = library.find((x) => x.id === a?.id)
    if (!item) return { ok: false, error: 'Not in the library.' }
    try {
      const text = String(a.text ?? '').trim().slice(0, 4000)
      await client().patchPikzonality(item.id, text)
      if (item.specialInstructions && item.specialInstructions !== text) item.instructionHistory = [{ at: item.updatedAt, text: item.specialInstructions }, ...item.instructionHistory].slice(0, 20)
      item.specialInstructions = text
      item.updatedAt = Date.now()
      saveLibrary()
      return { ok: true, item }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:rename-item`, (_e, a: { id: string; name: string }) => {
    const item = library.find((x) => x.id === a?.id)
    if (!item) return { ok: false, error: 'Not in the library.' }
    item.name = String(a.name ?? '').trim().slice(0, 80) || item.name
    saveLibrary()
    return { ok: true, item }
  })

  h.handle(`${ID}:delete-item`, async (_e, a: { id: string; keepOnPikzels?: boolean }) => {
    const item = library.find((x) => x.id === a?.id)
    if (!item) return { ok: true }
    try {
      if (!a.keepOnPikzels) await client().deletePikzonality(item.id)
      library = library.filter((x) => x.id !== item.id)
      rmSync(join(libDir, item.id), { recursive: true, force: true })
      saveLibrary()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /** Bring in a persona/theme trained elsewhere (another PC before sync, or the Pikzels web app). */
  h.handle(`${ID}:import-item`, async (_e, a: { id: string; kind: LibraryKind; name: string }) => {
    try {
      const id = String(a?.id ?? '').trim()
      if (!id) throw new Error('Paste the persona/theme id.')
      const st = await client().getPikzonality(id)
      const item: LibraryItem = {
        id,
        kind: a?.kind === 'style' ? 'style' : 'persona',
        name: String(a?.name ?? '').trim().slice(0, 80) || st.name || id,
        status: st.status,
        progress: st.status === 'completed' ? 100 : st.progress,
        specialInstructions: '',
        instructionHistory: [],
        previews: [],
        source: 'existing',
        sourceUrl: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        error: st.status === 'failed' ? st.error || 'Training failed.' : ''
      }
      library = [item, ...library.filter((x) => x.id !== id)]
      saveLibrary()
      if (st.status === 'processing') void pollItem(id)
      return { ok: true, item }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  // web images (YouTube thumbnails, pasted links) → small data URL; the window can't load them directly
  const remoteCache = new Map<string, Promise<string>>()
  let remoteActive = 0
  const remoteWaiting: (() => void)[] = []
  const remoteSlot = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (remoteActive >= PREVIEW_PARALLEL) await new Promise<void>((r) => remoteWaiting.push(r))
    remoteActive++
    try {
      return await fn()
    } finally {
      remoteActive--
      remoteWaiting.shift()?.()
    }
  }
  h.handle(`${ID}:remote-preview`, async (_e, a: { url: string }) => {
    const url = String(a?.url ?? '').trim()
    let p = remoteCache.get(url)
    if (!p) {
      p = remoteSlot(() => fetchRemotePreview(url, { shrink: shrinkForPreview }))
      remoteCache.set(url, p)
      p.catch(() => remoteCache.delete(url))
      if (remoteCache.size > PREVIEW_CACHE_MAX) remoteCache.delete(remoteCache.keys().next().value as string)
    }
    try {
      return { ok: true, dataUrl: await p }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:library-preview`, (_e, a: { id: string; file: string }) => {
    try {
      const p = join(libDir, String(a?.id ?? ''), basename(String(a?.file ?? '')))
      return { ok: true, dataUrl: dataUrl(p) }
    } catch {
      return { ok: false }
    }
  })

  /* ------------------------------- youtube ------------------------------- */

  h.handle(`${ID}:youtube`, async (_e, a: { url: string }) => {
    try {
      const r: YtLookup = await lookupYouTube(String(a?.url ?? ''))
      return { ok: true, ...r }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /* -------------------------------- history -------------------------------- */

  h.handle(`${ID}:history`, () => ({ ok: true, items: history.map((g) => ({ ...g, exists: !!g.file && existsSync(g.file) })) }))
  h.handle(`${ID}:history-clear`, () => {
    history = []
    saveHistory()
    return { ok: true }
  })
  h.handle(`${ID}:history-remove`, (_e, a: { id: string; deleteFile?: boolean }) => {
    const g = history.find((x) => x.id === a?.id)
    if (g && a.deleteFile && g.file) rmSync(g.file, { force: true })
    history = history.filter((x) => x.id !== a?.id)
    saveHistory()
    return { ok: true }
  })

  h.handle(`${ID}:open`, async (_e, a: { path?: string; reveal?: boolean; folder?: boolean }) => {
    try {
      const target = a?.folder ? downloadDir() : String(a?.path ?? '')
      if (!target) return { ok: false }
      if (a?.folder) mkdirSync(target, { recursive: true })
      if (a?.reveal) ctx.shell.showItemInFolder(target)
      else {
        const err = await ctx.shell.openPath(target)
        if (err) throw new Error(err)
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:open-url`, (_e, url: unknown) => {
    const u = String(url ?? '')
    if (!/^https?:\/\//i.test(u)) return { ok: false }
    void ctx.shell.openExternal(u)
    return { ok: true }
  })

  h.handle(`${ID}:data-paths`, (): ModuleDataPath[] => [
    { label: 'Downloads', path: downloadDir(), note: 'Every generated thumbnail is saved here automatically' },
    { label: 'Personas & themes', path: existsSync(libraryPath) ? libraryPath : null, note: 'Synced with WICKED Backup / Cloud Sync so they show on every PC' },
    { label: 'History', path: existsSync(historyPath) ? historyPath : null }
  ])
}
