/**
 * MHTML → a plain folder you can open in any browser (pure; no Electron).
 *
 * The shell's capturePage hands back Chromium's MHTML snapshot: one
 * multipart/related file holding the page's HTML as rendered (after its
 * scripts ran) plus every stylesheet, image, font and frame it used, each part
 * labelled with its original URL (Content-Location) or a cid: id (frames).
 *
 * unpackMhtml() writes:
 *   index.html        the page, links rewritten to the local copies
 *   assets/…          every other part (CSS, images, fonts, frames)
 * Scripts are stripped (the snapshot already holds what they built, and
 * re-running them offline breaks pages); ordinary links (<a href>) point at
 * the live site; anything that wasn't in the snapshot keeps its web address.
 */
import { posix } from 'path'

export interface MhtmlPart {
  type: string
  charset: string
  location: string
  cid: string
  body: Buffer
}

export interface ParsedMhtml {
  snapshotUrl: string
  subject: string
  parts: MhtmlPart[]
}

/* -------------------------------- parsing --------------------------------- */

function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  // unfold continuation lines (start with space / tab)
  const lines = block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)
  for (const l of lines) {
    const i = l.indexOf(':')
    if (i > 0) out[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim()
  }
  return out
}

const param = (header: string, name: string): string => {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, 'i').exec(header)
  return m ? (m[1] ?? m[2] ?? '') : ''
}

/** RFC 2045 quoted-printable → bytes */
export function decodeQuotedPrintable(s: string): Buffer {
  const text = s.replace(/=\r?\n/g, '')
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 61 /* = */ && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16))
      i += 2
    } else if (c < 128) out.push(c)
    else for (const b of Buffer.from(text[i], 'utf8')) out.push(b)
  }
  return Buffer.from(out)
}

/** Split a Chromium MHTML file into its parts. Throws on something that isn't MHTML. */
export function parseMhtml(raw: Buffer | string): ParsedMhtml {
  // latin1 keeps every byte as one char, so binary parts survive the split
  const text = typeof raw === 'string' ? raw : raw.toString('latin1')
  const headEnd = text.search(/\r?\n\r?\n/)
  if (headEnd < 0) throw new Error('Not an MHTML file (no headers).')
  const top = parseHeaders(text.slice(0, headEnd))
  const boundary = param(top['content-type'] ?? '', 'boundary')
  if (!boundary) throw new Error('Not an MHTML file (no multipart boundary).')
  const pieces = text.slice(headEnd).split(`--${boundary}`)
  const parts: MhtmlPart[] = []
  for (const piece of pieces) {
    if (piece.startsWith('--')) break // closing boundary
    const p = piece.replace(/^\r?\n/, '')
    const sep = p.search(/\r?\n\r?\n/)
    if (sep < 0) continue
    const h = parseHeaders(p.slice(0, sep))
    if (!h['content-type'] && !h['content-location']) continue
    let body = p.slice(sep).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '')
    const enc = (h['content-transfer-encoding'] ?? '').toLowerCase()
    let bytes: Buffer
    if (enc === 'base64') bytes = Buffer.from(body.replace(/\s+/g, ''), 'base64')
    else if (enc === 'quoted-printable') bytes = decodeQuotedPrintable(body)
    else {
      body = body.replace(/\r\n/g, '\n')
      bytes = Buffer.from(body, 'latin1')
    }
    const ct = h['content-type'] ?? 'application/octet-stream'
    parts.push({
      type: ct.split(';')[0].trim().toLowerCase(),
      charset: param(ct, 'charset').toLowerCase(),
      location: h['content-location'] ?? '',
      cid: (h['content-id'] ?? '').replace(/^<|>$/g, ''),
      body: bytes
    })
  }
  if (!parts.length) throw new Error('The MHTML file holds no parts.')
  const subject = (top['subject'] ?? '').replace(/=\?utf-8\?Q\?(.*?)\?=/gi, (_m, q: string) => decodeQuotedPrintable(q.replace(/_/g, ' ')).toString('utf8'))
  return { snapshotUrl: top['snapshot-content-location'] ?? parts[0].location, subject, parts }
}

/* ------------------------------- unpacking -------------------------------- */

const EXT: Record<string, string> = {
  'text/html': '.html',
  'text/css': '.css',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/bmp': '.bmp',
  'font/woff2': '.woff2',
  'font/woff': '.woff',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'application/font-woff2': '.woff2',
  'application/font-woff': '.woff',
  'application/x-font-ttf': '.ttf',
  'application/vnd.ms-fontobject': '.eot',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'application/json': '.json',
  'text/plain': '.txt'
}

const isText = (type: string): boolean => type === 'text/html' || type === 'text/css' || type === 'image/svg+xml' || type.startsWith('text/')

/** strip #fragment so "a.svg#icon" and "a.svg" share one file */
const key = (u: string): string => u.split('#')[0]

function safeBase(u: string, type: string, i: number): string {
  // Chromium keeps <style> blocks and frames as cid: parts — give them plain names
  if (/^cid:/i.test(u)) return `${type === 'text/css' ? 'styles' : type === 'text/html' ? 'frame' : 'part'}-${i}${EXT[type] ?? ''}`
  let name = ''
  try {
    const url = new URL(u)
    name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '')
  } catch {
    name = ''
  }
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 80)
  const want = EXT[type] ?? ''
  if (!name) name = `file-${i}`
  const dot = name.lastIndexOf('.')
  const hasExt = dot > 0 && name.length - dot <= 6
  if (!hasExt && want) name += want
  else if (hasExt && want && type === 'text/css' && !name.endsWith('.css')) name += '.css'
  return name
}

export interface UnpackedFile {
  path: string // relative to the page folder, forward slashes
  data: Buffer
}

export interface UnpackResult {
  title: string
  url: string
  files: UnpackedFile[]
  /** references that weren't in the snapshot and still point at the web */
  external: number
  /** web addresses of files the page uses (fonts, images, styles, icons) that weren't in the snapshot — worth fetching */
  missing: string[]
}

/** a file fetched afterwards to fill a gap in the snapshot */
export interface ExtraFile {
  url: string
  type: string
  body: Buffer
}

const escAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
const unescAttr = (s: string): string =>
  s
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCharCode(parseInt(n, 16)))

export function unpackMhtml(raw: Buffer | string, opts: { sourceUrl?: string; savedAt?: Date; extra?: ExtraFile[] } = {}): UnpackResult {
  const m = parseMhtml(raw)
  for (const x of opts.extra ?? []) if (!m.parts.some((p) => key(p.location) === key(x.url))) m.parts.push({ type: x.type.split(';')[0].trim().toLowerCase(), charset: '', location: x.url, cid: '', body: x.body })
  const main = m.parts.find((p) => p.type === 'text/html') ?? m.parts[0]
  const pageUrl = main.location || m.snapshotUrl || opts.sourceUrl || ''

  // where each part goes
  const used = new Set<string>(['index.html'])
  const byUrl = new Map<string, string>()
  const byCid = new Map<string, string>()
  const pathOf = new Map<MhtmlPart, string>()
  m.parts.forEach((p, i) => {
    let path: string
    if (p === main) path = 'index.html'
    else {
      const base = safeBase(p.location, p.type, i)
      const dot = base.lastIndexOf('.')
      const stem = dot > 0 ? base.slice(0, dot) : base
      const ext = dot > 0 ? base.slice(dot) : ''
      path = `assets/${base}`
      for (let n = 2; used.has(path.toLowerCase()); n++) path = `assets/${stem}-${n}${ext}`
    }
    used.add(path.toLowerCase())
    pathOf.set(p, path)
    if (p.location && !byUrl.has(key(p.location))) byUrl.set(key(p.location), path)
    if (p.cid) byCid.set(p.cid, path)
  })

  let external = 0
  const missing = new Set<string>()
  /** a reference in `fromPath` (base URL `base`) → local relative path, or an absolute web address */
  const resolve = (ref: string, base: string, fromPath: string, localOnly = false, fetchable = false): string | null => {
    const r = ref.trim()
    if (!r || /^(data|blob|javascript|mailto|tel|about):/i.test(r) || r.startsWith('#')) return null
    let target: string | undefined
    if (/^cid:/i.test(r)) target = byCid.get(r.slice(4))
    let abs = r
    if (!target) {
      try {
        abs = new URL(r, base || undefined).toString()
      } catch {
        return null
      }
      target = byUrl.get(key(abs))
    }
    if (target) {
      const hash = r.includes('#') ? r.slice(r.indexOf('#')) : ''
      const rel = posix.relative(posix.dirname(fromPath), target) || posix.basename(target)
      return rel + hash
    }
    if (localOnly) return null
    if (/^https?:/i.test(abs)) {
      external++
      if (fetchable) missing.add(key(abs))
    }
    return abs
  }

  const rewriteCss = (css: string, base: string, fromPath: string): string =>
    css
      .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (all, q: string, u: string) => {
        const to = resolve(u, base, fromPath, false, true)
        return to === null ? all : `url(${q || '"'}${to}${q || '"'})`
      })
      .replace(/@import\s+(['"])([^'"]+)\1/gi, (all, q: string, u: string) => {
        const to = resolve(u, base, fromPath, false, true)
        return to === null ? all : `@import ${q}${to}${q}`
      })

  const rewriteHtml = (html: string, base: string, fromPath: string, isMain: boolean): string => {
    let out = html
      // a snapshot, not a program: no scripts, no "please enable JavaScript", no CSP / base that would break local files
      .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<script\b[^>]*\/>/gi, '')
      .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, '')
      .replace(/<meta[^>]+http-equiv\s*=\s*["']?(content-security-policy|refresh)["']?[^>]*>/gi, '')
      .replace(/<base\b[^>]*>/gi, '')
      .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    // inline <style> blocks
    out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_a, o: string, css: string, c: string) => o + rewriteCss(css, base, fromPath) + c)
    // attributes
    out = out.replace(/<([a-zA-Z][\w:-]*)(\s[^<>]*?)?(\/?)>/g, (tag, name: string, attrs: string | undefined, slash: string) => {
      if (!attrs) return tag
      const tagName = name.toLowerCase()
      const rel = (/\srel\s*=\s*["']?([^"'>]+)/i.exec(attrs)?.[1] ?? '').toLowerCase()
      // files the page needs to look right (not <link rel=canonical/preload/…>)
      const needed = tagName !== 'link' || /stylesheet|icon/.test(rel)
      const a = attrs.replace(/(\s)([\w:-]+)(\s*=\s*)("([^"]*)"|'([^']*)')/g, (all, sp: string, an: string, eq: string, _v: string, dq?: string, sq?: string) => {
        const attr = an.toLowerCase()
        const val = unescAttr(dq ?? sq ?? '')
        const put = (v: string): string => `${sp}${an}${eq}"${escAttr(v)}"`
        if (attr === 'style') return put(rewriteCss(val, base, fromPath))
        if (attr === 'srcset' || attr === 'imagesrcset') {
          // keep only candidates we have; if none, the first one's web address
          const cands = val.split(/,(?=\s*\S)/).map((c) => c.trim()).filter(Boolean)
          const local = cands.map((c) => {
            const [u, ...d] = c.split(/\s+/)
            const to = resolve(u, base, fromPath, true)
            return to ? [to, ...d].join(' ') : null
          }).filter(Boolean) as string[]
          if (local.length) return put(local.join(', '))
          const first = cands[0]?.split(/\s+/)[0]
          const abs = first ? resolve(first, base, fromPath) : null
          return abs ? put(cands.map((c) => { const [u, ...d] = c.split(/\s+/); return [resolve(u, base, fromPath) ?? u, ...d].join(' ') }).join(', ')) : all
        }
        const isRef = attr === 'src' || attr === 'poster' || attr === 'background' || attr === 'data' || attr === 'xlink:href' || attr === 'href'
        if (!isRef) return all
        if (attr === 'href' && (tagName === 'a' || tagName === 'area')) {
          // links go to the live site (or the saved page when they point at it)
          const to = resolve(val, base, fromPath, true)
          if (to) return put(to)
          try {
            return /^(#|javascript:|mailto:|tel:)/i.test(val.trim()) ? (val.trim().toLowerCase().startsWith('javascript:') ? put('#') : all) : put(new URL(val, base).toString())
          } catch {
            return all
          }
        }
        const to = resolve(val, base, fromPath, false, needed && attr !== 'href' ? true : needed && tagName === 'link')
        return to === null ? all : put(to)
      })
      return `<${name}${a}${slash}>`
    })
    if (isMain) {
      const stamp = `<!-- Saved by WICKED Webpage Downloader from ${pageUrl.replace(/--/g, '%2D%2D')} on ${(opts.savedAt ?? new Date()).toISOString()} -->\n`
      if (!/<meta[^>]+charset/i.test(out)) out = out.replace(/<head([^>]*)>/i, '<head$1><meta charset="utf-8">')
      out = stamp + out.replace(/^﻿/, '')
    }
    return out
  }

  const files: UnpackedFile[] = []
  for (const p of m.parts) {
    const path = pathOf.get(p)!
    if (!isText(p.type)) {
      files.push({ path, data: p.body })
      continue
    }
    let text = p.body.toString(/^(iso-8859-1|latin1|windows-1252)$/.test(p.charset) ? 'latin1' : 'utf8')
    // <style> blocks / frames stored as cid: parts resolve against the page itself
    const base = p.location && !/^cid:/i.test(p.location) ? p.location : pageUrl
    if (p.type === 'text/html') {
      text = rewriteHtml(text, base, path, p === main)
      // we write utf-8; say so
      text = text.replace(/<meta[^>]+charset\s*=\s*["']?[\w-]+["']?[^>]*>/i, '<meta charset="utf-8">')
    } else if (p.type === 'text/css') text = rewriteCss(text, base, path)
    else if (p.type === 'image/svg+xml') text = rewriteCss(text, base, path)
    files.push({ path, data: Buffer.from(text, 'utf8') })
  }

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(main.body.toString('utf8'))
  const title = (titleMatch ? unescAttr(titleMatch[1]).replace(/\s+/g, ' ').trim() : '') || m.subject || ''
  return { title, url: pageUrl, files, external, missing: [...missing] }
}

/** A folder name for a saved page: "<title> (<host>) <date> <time>" — Windows-safe. */
export function folderNameFor(title: string, url: string, at: Date): string {
  let host = ''
  try {
    host = new URL(url).hostname.replace(/^www\./, '')
  } catch {
    host = ''
  }
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}${p(at.getMinutes())}`
  const clean = (s: string): string =>
    s
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
  const t = clean(title).slice(0, 70)
  return [t || host || 'Web page', host && t && !t.toLowerCase().includes(host.toLowerCase()) ? `(${host})` : '', stamp].filter(Boolean).join(' ')
}
