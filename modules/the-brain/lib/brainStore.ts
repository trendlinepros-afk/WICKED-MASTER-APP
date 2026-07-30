import fs from 'node:fs'
import path from 'node:path'

/**
 * The Brain — the app's own local Obsidian-style markdown vault.
 *
 * Everything lives under `userData/modules/the-brain/vault/`, which the shell's
 * Backup & Cloud Sync walks recursively — so notes, ported chats and persona
 * "brains" all travel with the GitHub-backed sync automatically.
 *
 * This module is pure Node `fs` so it can be imported and called directly from
 * ANY module's main-process code (ai-advisor, ai-chat, …) as the single source
 * of truth for the vault layout — no IPC round-trip needed.
 *
 *   vault/
 *     Chats/<Source>/<title>.md     ← auto-saved AI conversations (frontmatter carries id)
 *     Personas/<name>/*.md          ← an agent persona's grounding documents
 *     Imported/*.md                 ← files the user imported
 *     Notes/*.md                    ← free-form notes made in The Brain
 */

/** The slice of Electron's `app` we need (so this file has no electron import). */
export interface AppLike {
  getPath(name: 'userData'): string
}

export const VAULT_FOLDERS = ['Chats', 'Personas', 'Imported', 'Notes'] as const
const MD_RE = /\.(md|markdown|txt)$/i

/* ------------------------------ vault paths ------------------------------- */

export function vaultRoot(app: AppLike): string {
  return path.join(app.getPath('userData'), 'modules', 'the-brain', 'vault')
}

/** Create the vault (and its standard folders) if missing; returns the root. */
export function ensureVault(app: AppLike): string {
  const root = vaultRoot(app)
  fs.mkdirSync(root, { recursive: true })
  for (const d of VAULT_FOLDERS) fs.mkdirSync(path.join(root, d), { recursive: true })
  return root
}

/** Make a string safe as a Windows/macOS/Linux file or folder name. */
export function safeName(s: string, fallback = 'untitled'): string {
  const cleaned = (s || '')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80)
    .trim()
  return cleaned || fallback
}

/** Resolve a vault-relative path, refusing anything that escapes the vault. */
function resolveInVault(root: string, rel: string): string {
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Path escapes the vault.')
  return abs
}

const toPosix = (p: string): string => p.split(path.sep).join('/')

/* ---------------------------- frontmatter --------------------------------- */

function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw)
  if (!m) return { fm: {}, body: raw }
  const fm: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i === -1) continue
    const key = line.slice(0, i).trim().toLowerCase()
    const val = line
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    if (key) fm[key] = val
  }
  return { fm, body: m[2] }
}

function frontmatterValue(raw: string, key: string): string | undefined {
  return parseFrontmatter(raw).fm[key.toLowerCase()]
}

/* ------------------------------- tree/read -------------------------------- */

export interface BrainFile {
  type: 'file'
  name: string
  rel: string
  title: string
  size: number
  mtime: number
}
export interface BrainFolder {
  type: 'folder'
  name: string
  rel: string
  children: BrainNode[]
  fileCount: number
}
export type BrainNode = BrainFile | BrainFolder

function countFiles(nodes: BrainNode[]): number {
  let n = 0
  for (const x of nodes) n += x.type === 'file' ? 1 : x.fileCount
  return n
}

export function listTree(app: AppLike): BrainNode[] {
  const root = ensureVault(app)
  const build = (dir: string): BrainNode[] => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const nodes: BrainNode[] = []
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const abs = path.join(dir, e.name)
      const rel = toPosix(path.relative(root, abs))
      if (e.isDirectory()) {
        const children = build(abs)
        nodes.push({ type: 'folder', name: e.name, rel, children, fileCount: countFiles(children) })
      } else if (e.isFile() && MD_RE.test(e.name)) {
        let size = 0
        let mtime = 0
        try {
          const st = fs.statSync(abs)
          size = st.size
          mtime = st.mtimeMs
        } catch {
          /* ignore */
        }
        let title = e.name.replace(MD_RE, '')
        try {
          title = frontmatterValue(fs.readFileSync(abs, 'utf-8'), 'title') || title
        } catch {
          /* ignore */
        }
        nodes.push({ type: 'file', name: e.name, rel, title, size, mtime })
      }
    }
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1))
    return nodes
  }
  return build(root)
}

export function readNote(app: AppLike, rel: string): string {
  const root = ensureVault(app)
  return fs.readFileSync(resolveInVault(root, rel), 'utf-8')
}

export function writeNote(app: AppLike, rel: string, content: string): void {
  const root = ensureVault(app)
  const abs = resolveInVault(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
}

export function deleteNote(app: AppLike, rel: string): void {
  const root = ensureVault(app)
  const abs = resolveInVault(root, rel)
  if (path.resolve(abs) === path.resolve(root)) throw new Error('Refusing to delete the vault root.')
  fs.rmSync(abs, { recursive: true, force: true })
}

/** Absolute path for a vault-relative path (for shell.showItemInFolder). */
export function absPath(app: AppLike, rel: string): string {
  return resolveInVault(ensureVault(app), rel)
}

export function stats(app: AppLike): { files: number; folders: number } {
  const tree = listTree(app)
  let files = 0
  let folders = 0
  const walk = (nodes: BrainNode[]): void => {
    for (const n of nodes) {
      if (n.type === 'file') files++
      else {
        folders++
        walk(n.children)
      }
    }
  }
  walk(tree)
  return { files, folders }
}

/* --------------------------------- chats ---------------------------------- */

export interface SimpleMsg {
  role: string
  text: string
  ts?: number | null
  /** small dim sub-line under the role header (e.g. model + cost, tools used) */
  sub?: string
}

export interface ChatDoc {
  /** category folder under Chats/, e.g. "AI Advisor" or "Wicked AI Chat" */
  source: string
  id: string
  title: string
  messages: SimpleMsg[]
  createdAt?: number | null
  updatedAt?: number | null
}

const isoOrEmpty = (ms: number | null | undefined): string => {
  if (ms == null || !Number.isFinite(ms)) return ''
  try {
    return new Date(ms).toISOString()
  } catch {
    return ''
  }
}

function renderChatMarkdown(doc: ChatDoc): string {
  const fm = [
    '---',
    `title: ${JSON.stringify(doc.title || 'Untitled chat')}`,
    `source: ${JSON.stringify(doc.source)}`,
    `id: ${doc.id}`,
    'type: chat',
    `created: ${isoOrEmpty(doc.createdAt)}`,
    `updated: ${isoOrEmpty(doc.updatedAt)}`,
    '---',
    ''
  ].join('\n')

  const body: string[] = [`# ${doc.title || 'Untitled chat'}`, '']
  for (const m of doc.messages) {
    const who = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Assistant' : m.role
    const when = m.ts != null && Number.isFinite(m.ts) ? ` — ${new Date(m.ts).toLocaleString()}` : ''
    body.push(`### ${who}${when}`)
    if (m.sub) body.push(`*${m.sub}*`, '')
    body.push((m.text || '').trim() || '_(no content)_', '')
  }
  return fm + body.join('\n').trimEnd() + '\n'
}

function chatsDir(root: string, source: string): string {
  return path.join(root, 'Chats', safeName(source, 'Chats'))
}

/** Scan a folder for the .md whose frontmatter id matches; returns abs path or null. */
function findByChatId(dir: string, id: string): string | null {
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  for (const name of names) {
    if (!MD_RE.test(name)) continue
    const abs = path.join(dir, name)
    try {
      if (frontmatterValue(fs.readFileSync(abs, 'utf-8'), 'id') === id) return abs
    } catch {
      /* ignore */
    }
  }
  return null
}

/** A filename `<base>.md`, or `<base> (n).md`, that collides with nothing but `selfAbs`. */
function uniqueChatFile(dir: string, base: string, selfAbs: string | null): string {
  const taken = (name: string): boolean => {
    const abs = path.join(dir, name)
    if (selfAbs && path.resolve(abs) === path.resolve(selfAbs)) return false
    return fs.existsSync(abs)
  }
  let candidate = `${base}.md`
  for (let i = 2; taken(candidate); i++) candidate = `${base} (${i}).md`
  return candidate
}

/**
 * Write (or update) a chat's markdown file. Idempotent per (source,id): the
 * existing file for that id is located by frontmatter and overwritten — and
 * renamed on disk if the chat title changed — so there is never a duplicate.
 * Returns the vault-relative path.
 */
export function saveChat(app: AppLike, doc: ChatDoc): string {
  const root = ensureVault(app)
  const dir = chatsDir(root, doc.source)
  fs.mkdirSync(dir, { recursive: true })
  const existing = findByChatId(dir, doc.id)
  const base = safeName(doc.title, 'Untitled chat')
  const target = path.join(dir, uniqueChatFile(dir, base, existing))
  if (existing && path.resolve(existing) !== path.resolve(target)) {
    try {
      fs.rmSync(existing)
    } catch {
      /* ignore */
    }
  }
  fs.writeFileSync(target, renderChatMarkdown(doc), 'utf-8')
  return toPosix(path.relative(root, target))
}

/** Remove the chat file for (source,id), if present. Returns true if deleted. */
export function deleteChat(app: AppLike, source: string, id: string): boolean {
  const root = ensureVault(app)
  const dir = chatsDir(root, source)
  const existing = findByChatId(dir, id)
  if (!existing) return false
  try {
    fs.rmSync(existing)
    return true
  } catch {
    return false
  }
}

/* -------------------------------- personas -------------------------------- */

export function personasRoot(app: AppLike): string {
  return path.join(ensureVault(app), 'Personas')
}

/** Ensure `Personas/<name>/` exists and return its ABSOLUTE path. */
export function ensurePersonaFolder(app: AppLike, name: string): string {
  const dir = path.join(personasRoot(app), safeName(name, 'persona'))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Is this absolute path already inside the vault's Personas folder? */
export function isInsidePersonas(app: AppLike, absDir: string): boolean {
  if (!absDir) return false
  const root = personasRoot(app)
  const r = path.resolve(absDir)
  return r === path.resolve(root) || r.startsWith(path.resolve(root) + path.sep)
}

function copyMarkdownTree(srcDir: string, destDir: string): number {
  let copied = 0
  const walk = (dir: string): void => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile() && MD_RE.test(e.name)) {
        const rel = path.relative(srcDir, abs)
        const dest = path.join(destDir, rel)
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.copyFileSync(abs, dest)
          copied++
        } catch {
          /* ignore individual file */
        }
      }
    }
  }
  walk(srcDir)
  return copied
}

/**
 * Bring a persona's grounding documents INTO the vault so they sync. Copies the
 * markdown from `sourceDir` (e.g. an external `C:\...\brain` folder) into
 * `Personas/<name>/` and returns that in-vault absolute path. If `sourceDir` is
 * already inside the vault, nothing is copied and the folder is just ensured.
 */
export function importPersonaFolder(app: AppLike, name: string, sourceDir: string): string {
  const dest = ensurePersonaFolder(app, name)
  if (sourceDir && fs.existsSync(sourceDir) && !isInsidePersonas(app, sourceDir)) {
    if (path.resolve(sourceDir) !== path.resolve(dest)) copyMarkdownTree(sourceDir, dest)
  }
  return dest
}

export function deletePersonaFolder(app: AppLike, name: string): void {
  const dir = path.join(personasRoot(app), safeName(name, 'persona'))
  if (fs.existsSync(dir) && isInsidePersonas(app, dir)) fs.rmSync(dir, { recursive: true, force: true })
}

/* --------------------------------- import --------------------------------- */

/** Copy external .md/.txt files into a vault folder (default Imported/). */
export function importFiles(app: AppLike, absPaths: string[], destRel = 'Imported'): { imported: number; skipped: number } {
  const root = ensureVault(app)
  const dir = resolveInVault(root, destRel)
  fs.mkdirSync(dir, { recursive: true })
  let imported = 0
  let skipped = 0
  for (const src of absPaths) {
    if (typeof src !== 'string' || !MD_RE.test(src) || !fs.existsSync(src)) {
      skipped++
      continue
    }
    const base = safeName(path.basename(src).replace(MD_RE, ''), 'imported')
    let dest = path.join(dir, `${base}.md`)
    for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${base} (${i}).md`)
    try {
      fs.copyFileSync(src, dest)
      imported++
    } catch {
      skipped++
    }
  }
  return { imported, skipped }
}

/* --------------------------------- search --------------------------------- */

export interface BrainHit {
  rel: string
  title: string
  excerpt: string
  score: number
}

/** Keyword-rank vault notes for a query (used by the MCP read tools). */
export function search(app: AppLike, query: string, limit = 8): BrainHit[] {
  const root = ensureVault(app)
  const files: { rel: string; title: string; body: string }[] = []
  const walk = (nodes: BrainNode[]): void => {
    for (const n of nodes) {
      if (n.type === 'folder') walk(n.children)
      else {
        try {
          const { fm, body } = parseFrontmatter(fs.readFileSync(path.join(root, n.rel), 'utf-8'))
          files.push({ rel: n.rel, title: fm.title || n.title, body })
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(listTree(app))

  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1)
  const scored = files.map((f) => {
    const hay = `${f.title}\n${f.body}`.toLowerCase()
    let score = 0
    for (const t of terms) {
      if (f.title.toLowerCase().includes(t)) score += 3
      let idx = hay.indexOf(t)
      while (idx !== -1) {
        score += 1
        idx = hay.indexOf(t, idx + t.length)
      }
    }
    return { f, score }
  })
  const ranked = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  const chosen = ranked.length > 0 ? ranked.map((s) => s.f) : files.slice(0, Math.min(limit, files.length))
  return chosen.map((f) => ({
    rel: f.rel,
    title: f.title,
    excerpt: f.body.replace(/\s+/g, ' ').trim().slice(0, 500),
    score: ranked.find((r) => r.f === f)?.score ?? 0
  }))
}
