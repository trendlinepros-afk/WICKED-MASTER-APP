import { clipboard } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { basename, dirname, join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import type {
  ActivityAction,
  AssetType,
  Counts,
  DocRecord,
  DocSettings,
  DomainLookup,
  Expiration,
  FieldDef,
  FieldValue,
  RecordSummary,
  SecretPlaceholder,
  SslLookup,
  VaultStatus
} from './types'
import { BUILTIN_TYPES, isSecretKind, slugify } from './lib/schema'
import {
  decryptValue,
  encryptValue,
  generatePassphrase,
  generatePassword,
  isEncrypted,
  rewrapVault,
  sameSecret,
  setupVault,
  unlockVault,
  validatePassword,
  type GenOptions,
  type VaultFile
} from './ipc/vault'
import * as store from './ipc/db'
import { lookupDomain, lookupSsl, normalizeDomain } from './ipc/lookups'
import { parseTotp, totpCode } from './ipc/totp'

/* ------------------------------------------------------------------------ *
 *  DOCUMENTATION — single-site IT documentation (IT Glue style): core
 *  assets + flexible asset types, password vault, domain/SSL trackers.
 *
 *  Lock: a password set on first open wraps a random master key
 *  (ipc/vault.ts). Secret fields (passwords, TOTP seeds, licence keys) are
 *  AES-256-GCM encrypted with that key in docs.db; everything else is plain
 *  SQLite so it stays searchable. The master key lives only in this process
 *  while unlocked; every data channel refuses with {locked:true} otherwise.
 *  Secrets reach the renderer only through explicit reveal/copy calls, which
 *  are written to the activity log. Nothing here is bound to the PC, so a
 *  WICKED backup restored elsewhere opens with the same password.
 * ------------------------------------------------------------------------ */

const ID = 'documentation'
const DAY = 86_400_000

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const ymdToMs = (ymd: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}
const todayUtc = (): number => {
  const d = new Date()
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
}

export default function register(ctx: ModuleIpcContext): void {
  const dataDir = join(ctx.app.getPath('userData'), 'modules', ID)
  const vaultPath = join(dataDir, 'vault.json')
  const dbPath = join(dataDir, 'docs.db')
  const attachDir = join(dataDir, 'attachments')
  mkdirSync(dataDir, { recursive: true })

  const send = (channel: string, payload: unknown): void => {
    ctx.getMainWindow()?.webContents.send(channel, payload)
  }

  /* -------------------------------- vault -------------------------------- */

  let master: Buffer | null = null
  let db: store.Db | null = null
  let lastActivity = Date.now()
  let unlocking = false

  const readVault = (): VaultFile | null => {
    try {
      return existsSync(vaultPath) ? (JSON.parse(readFileSync(vaultPath, 'utf8')) as VaultFile) : null
    } catch {
      return null
    }
  }
  const writeVault = (v: VaultFile): void => {
    const tmp = `${vaultPath}.tmp`
    writeFileSync(tmp, JSON.stringify(v, null, 2))
    renameSync(tmp, vaultPath)
  }

  const settings = (): DocSettings => ({
    autoLockMinutes: ctx.storeGet<number>(`${ID}.autoLockMinutes`, 15),
    hiddenTypes: ctx.storeGet<string[]>(`${ID}.hiddenTypes`, []),
    clipboardClearSeconds: ctx.storeGet<number>(`${ID}.clipboardClearSeconds`, 45)
  })

  const status = (): VaultStatus => {
    const v = readVault()
    const retryAfter = v && v.lockedUntil > Date.now() ? Math.ceil((v.lockedUntil - Date.now()) / 1000) : 0
    return {
      configured: !!v,
      unlocked: !!master,
      retryAfter,
      failedAttempts: v?.failed ?? 0,
      autoLockMinutes: settings().autoLockMinutes,
      lastUnlockAt: v?.lastUnlockAt ?? null
    }
  }

  const getDb = (): store.Db => {
    if (!db) db = store.openDb(dbPath)
    return db
  }

  ctx.onBackupFlush(() => {
    try {
      db?.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* not open */
    }
  })

  const log = (action: ActivityAction, r?: { id?: string | null; type?: string | null; name?: string } | null, detail = ''): void => {
    try {
      store.logActivity(getDb(), { action, recordId: r?.id ?? null, recordType: r?.type ?? null, recordName: r?.name ?? '', detail })
    } catch {
      /* logging never blocks the action */
    }
  }

  function lock(reason: string): void {
    if (!master) return
    master.fill(0)
    master = null
    log('lock', null, reason)
    send(`${ID}:locked`, { reason })
  }

  // auto-lock after inactivity (data channels + explicit touches count as activity)
  setInterval(() => {
    const mins = settings().autoLockMinutes
    if (master && mins > 0 && Date.now() - lastActivity > mins * 60_000) lock('auto-lock after inactivity')
  }, 15_000)

  /** Wrap a data handler: refuses while locked, converts throws into {ok:false}. */
  const guarded =
    <A extends unknown[], R>(fn: (...args: A) => R | Promise<R>) =>
    async (_e: unknown, ...args: A): Promise<R | { ok: false; error: string; locked?: boolean }> => {
      if (!master) return { ok: false, locked: true, error: 'Documentation is locked.' }
      lastActivity = Date.now()
      try {
        return await fn(...args)
      } catch (err) {
        return { ok: false, error: errMsg(err) }
      }
    }
  const key = (): Buffer => {
    if (!master) throw new Error('Locked')
    return master
  }

  /* ------------------------------ field helpers ----------------------------- */

  const placeholder = (set: boolean): SecretPlaceholder => ({ __secret: true, set })

  /** What the renderer may see: secret values become placeholders. */
  function redact(r: DocRecord, t: AssetType | null): DocRecord {
    const fields: Record<string, FieldValue> = {}
    const secretKeys = new Set((t?.fields ?? []).filter((f) => isSecretKind(f.kind)).map((f) => f.key))
    for (const [k, v] of Object.entries(r.fields)) {
      if (secretKeys.has(k) || isEncrypted(v)) fields[k] = placeholder(typeof v === 'string' && v.length > 0)
      else fields[k] = v
    }
    return { ...r, fields }
  }

  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

  /** Coerce + validate incoming field values by their definition; encrypt secrets. */
  function sanitizeFields(t: AssetType, incoming: Record<string, unknown>, existing: Record<string, FieldValue>): { fields: Record<string, FieldValue>; changed: string[] } {
    const out: Record<string, FieldValue> = {}
    const changed: string[] = []
    for (const f of t.fields) {
      const raw = incoming[f.key]
      const prev = existing[f.key]
      let next: FieldValue
      switch (f.kind) {
        case 'password':
        case 'totp': {
          if (raw && typeof raw === 'object' && (raw as SecretPlaceholder).__secret) {
            next = prev // untouched
          } else {
            const s = str(raw)
            if (f.kind === 'totp' && s.trim()) parseTotp(s) // throws on a bad secret
            next = s ? encryptValue(key(), f.kind === 'totp' ? s.trim() : s) : undefined
            if ((s ? 'set' : 'empty') !== (prev ? 'set' : 'empty') || s) changed.push(f.label)
          }
          break
        }
        case 'checkbox':
          next = raw === true || raw === 'true' || raw === 1
          break
        case 'number': {
          const n = raw === '' || raw == null ? null : Number(raw)
          next = n != null && Number.isFinite(n) ? n : undefined
          break
        }
        case 'date': {
          const s = str(raw).trim()
          if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${f.label}: use a date (YYYY-MM-DD).`)
          next = s || undefined
          break
        }
        case 'relation':
          next = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 200) : typeof raw === 'string' && raw ? [raw] : []
          if (!next.length) next = undefined
          break
        case 'select': {
          const s = str(raw).trim()
          next = s || undefined
          break
        }
        default: {
          const s = f.kind === 'markdown' || f.kind === 'textarea' ? str(raw).replace(/\r\n/g, '\n') : str(raw).trim()
          next = s ? s.slice(0, f.kind === 'markdown' ? 500_000 : 4000) : undefined
        }
      }
      if (f.required && (next === undefined || next === '' || next === false)) throw new Error(`${f.label} is required.`)
      if (next !== undefined) out[f.key] = next
      if (!isSecretKind(f.kind) && JSON.stringify(next ?? null) !== JSON.stringify(prev ?? null)) changed.push(f.label)
    }
    // hidden data keys (lookup snapshots) survive edits untouched
    for (const [k, v] of Object.entries(existing)) if (k.startsWith('_')) out[k] = v
    return { fields: out, changed }
  }

  function typeMap(): Map<string, AssetType> {
    return new Map(store.listTypes(getDb()).map((t) => [t.id, t]))
  }

  function summaries(records: DocRecord[], types: Map<string, AssetType>): RecordSummary[] {
    // resolve relation ids → names in one query
    const relIds: string[] = []
    for (const r of records) {
      const t = types.get(r.type)
      for (const f of t?.fields ?? []) if (f.kind === 'relation' && f.showInList && Array.isArray(r.fields[f.key])) relIds.push(...(r.fields[f.key] as string[]))
    }
    const names = store.namesOf(getDb(), relIds)
    return records.map((r) => {
      const t = types.get(r.type)
      const preview: Record<string, string> = {}
      for (const f of t?.fields ?? []) {
        if (!f.showInList) continue
        const v = r.fields[f.key]
        if (isSecretKind(f.kind)) preview[f.key] = v ? '••••••••' : ''
        else if (f.kind === 'checkbox') preview[f.key] = v ? 'Yes' : ''
        else if (f.kind === 'relation') preview[f.key] = (Array.isArray(v) ? v : []).map((id) => names.get(id)?.name ?? '?').join(', ')
        else preview[f.key] = v == null ? '' : String(v)
      }
      return { id: r.id, type: r.type, name: r.name, folder: r.folder, tags: r.tags, favorite: r.favorite, archived: r.archived, updatedAt: r.updatedAt, preview }
    })
  }

  function expirations(days: number): Expiration[] {
    const types = typeMap()
    const out: Expiration[] = []
    const today = todayUtc()
    for (const r of store.listRecords(getDb(), { archived: false })) {
      const t = types.get(r.type)
      for (const f of t?.fields ?? []) {
        if (f.kind !== 'date' || !f.expires) continue
        const v = r.fields[f.key]
        const ms = typeof v === 'string' ? ymdToMs(v) : null
        if (ms == null) continue
        const daysLeft = Math.round((ms - today) / DAY)
        if (daysLeft <= days) out.push({ recordId: r.id, type: r.type, name: r.name, fieldKey: f.key, fieldLabel: f.label, date: v as string, daysLeft })
      }
    }
    return out.sort((a, b) => a.daysLeft - b.daysLeft)
  }

  const findType = (id: string): AssetType => {
    const t = store.getType(getDb(), id)
    if (!t) throw new Error('Unknown asset type.')
    return t
  }
  const findRecord = (id: string): DocRecord => {
    const r = store.getRecord(getDb(), id)
    if (!r) throw new Error('That record no longer exists.')
    return r
  }

  /* --------------------------------- lock IPC -------------------------------- */

  const h = ctx.ipcMain

  h.handle(`${ID}:status`, (): VaultStatus => status())

  h.handle(`${ID}:setup`, async (_e, a: { password: string }) => {
    try {
      if (readVault()) throw new Error('A password is already set.')
      const err = validatePassword(String(a?.password ?? ''))
      if (err) throw new Error(err)
      const { file, master: m } = await setupVault(String(a.password))
      writeVault(file)
      master = m
      lastActivity = Date.now()
      getDb()
      log('setup', null, 'Documentation password set')
      return { ok: true, status: status() }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:unlock`, async (_e, a: { password: string }) => {
    if (unlocking) return { ok: false, error: 'Checking…' }
    unlocking = true
    try {
      const v = readVault()
      if (!v) return { ok: false, error: 'No password has been set yet.' }
      if (master) return { ok: true, status: status() }
      const r = await unlockVault(v, String(a?.password ?? ''))
      writeVault(r.file)
      if (!r.ok) return { ok: false, error: r.error, retryAfter: r.retryAfter, status: status() }
      master = r.master
      lastActivity = Date.now()
      getDb()
      log('unlock')
      return { ok: true, status: status() }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    } finally {
      unlocking = false
    }
  })

  h.handle(`${ID}:lock`, () => {
    lock('locked by user')
    return { ok: true, status: status() }
  })

  h.handle(`${ID}:touch`, () => {
    if (master) lastActivity = Date.now()
    return { ok: true }
  })

  h.handle(
    `${ID}:change-password`,
    guarded(async (a: { current: string; next: string }) => {
      const v = readVault()
      if (!v) throw new Error('No password has been set.')
      const check = await unlockVault(v, String(a?.current ?? ''))
      if (!check.ok) {
        writeVault(check.file)
        throw new Error(check.error.replace('Wrong password', 'Current password is wrong'))
      }
      const file = await rewrapVault(check.file, key(), String(a?.next ?? ''))
      writeVault(file)
      log('password-changed')
      return { ok: true }
    })
  )

  h.handle(`${ID}:settings`, (): DocSettings => settings())
  h.handle(`${ID}:settings-set`, (_e, patch: Partial<DocSettings>) => {
    if (typeof patch?.autoLockMinutes === 'number') ctx.storeSet(`${ID}.autoLockMinutes`, Math.max(0, Math.min(1440, Math.round(patch.autoLockMinutes))))
    if (Array.isArray(patch?.hiddenTypes)) ctx.storeSet(`${ID}.hiddenTypes`, patch.hiddenTypes.filter((x): x is string => typeof x === 'string'))
    if (typeof patch?.clipboardClearSeconds === 'number') ctx.storeSet(`${ID}.clipboardClearSeconds`, Math.max(0, Math.min(600, Math.round(patch.clipboardClearSeconds))))
    return settings()
  })

  /* ------------------------------- asset types ------------------------------ */

  h.handle(
    `${ID}:types`,
    guarded(() => ({ ok: true, types: store.listTypes(getDb()), counts: store.countsByType(getDb()) }))
  )

  h.handle(
    `${ID}:type-save`,
    guarded((raw: Partial<AssetType>) => {
      const d = getDb()
      const name = String(raw?.name ?? '').trim().slice(0, 60)
      if (!name) throw new Error('Give the asset type a name.')
      const existing = raw.id ? store.getType(d, raw.id) : null
      const id = existing?.id ?? slugify(name)
      if (!id) throw new Error('Name needs at least one letter or number.')
      if (!existing && store.getType(d, id)) throw new Error(`An asset type with the id "${id}" already exists.`)
      const seen = new Set<string>()
      const fields: FieldDef[] = (Array.isArray(raw.fields) ? raw.fields : []).map((f) => {
        const label = String(f?.label ?? '').trim().slice(0, 60)
        if (!label) throw new Error('Every field needs a label.')
        const k = String(f?.key ?? '').trim() || slugify(label).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
        if (!k || k.startsWith('_') || seen.has(k)) throw new Error(`Field key "${k || label}" is invalid or duplicated.`)
        seen.add(k)
        const kind = (f?.kind ?? 'text') as FieldDef['kind']
        return {
          key: k,
          label,
          kind,
          required: !!f?.required,
          options: kind === 'select' ? (Array.isArray(f?.options) ? f.options.map(String).map((s) => s.trim()).filter(Boolean) : []) : undefined,
          relationType: kind === 'relation' ? String(f?.relationType ?? '') || undefined : undefined,
          hint: String(f?.hint ?? '').trim() || undefined,
          showInList: !!f?.showInList,
          expires: kind === 'date' ? !!f?.expires : undefined,
          builtin: existing?.fields.find((x) => x.key === k)?.builtin ?? false,
          defaultValue: f?.defaultValue
        }
      })
      if (existing?.builtin) {
        // builtin fields must survive (their key + kind), in whatever order the user put them
        const shipped = BUILTIN_TYPES.find((b) => b.id === existing.id)?.fields ?? []
        for (const bf of shipped) {
          const mine = fields.find((x) => x.key === bf.key)
          if (!mine) throw new Error(`"${bf.label}" is a built-in field of ${existing.name} and can't be removed.`)
          if (mine.kind !== bf.kind) throw new Error(`"${bf.label}" must stay a ${bf.kind} field.`)
          mine.builtin = true
          mine.relationType = bf.relationType ?? mine.relationType
        }
      }
      const t: AssetType = {
        id,
        name,
        namePlural: String(raw.namePlural ?? '').trim().slice(0, 60) || name,
        icon: String(raw.icon ?? existing?.icon ?? 'FileText'),
        section: raw.section === 'core' || raw.section === 'admin' ? raw.section : 'apps',
        fields,
        builtin: existing?.builtin ?? false,
        sortOrder: typeof raw.sortOrder === 'number' ? raw.sortOrder : (existing?.sortOrder ?? 100),
        description: String(raw.description ?? '').trim().slice(0, 300),
        nameLabel: String(raw.nameLabel ?? '').trim().slice(0, 40) || 'Name',
        archived: !!raw.archived
      }
      if (existing?.builtin) t.section = existing.section === 'core' ? 'core' : t.section
      store.saveType(d, t)
      return { ok: true, type: t }
    })
  )

  h.handle(
    `${ID}:type-delete`,
    guarded((a: { id: string }) => {
      const t = findType(a.id)
      if (t.builtin) throw new Error('Built-in asset types can’t be deleted (hide them from the sidebar instead).')
      const atts = store.listRecords(getDb(), { type: t.id }).flatMap((r) => store.listAttachments(getDb(), r.id))
      const removed = store.deleteType(getDb(), t.id)
      for (const at of atts) rmSync(at.file, { force: true })
      log('delete', { type: t.id, name: t.name }, `Deleted asset type with ${removed} record${removed === 1 ? '' : 's'}`)
      return { ok: true, removed }
    })
  )

  /* --------------------------------- records -------------------------------- */

  h.handle(
    `${ID}:records`,
    guarded((a: { type?: string; archived?: boolean; favorite?: boolean; folder?: string; q?: string }) => {
      const types = typeMap()
      const list = store.listRecords(getDb(), {
        type: a?.type,
        archived: a?.archived ?? false,
        favorite: a?.favorite,
        folder: a?.folder,
        q: a?.q
      })
      return { ok: true, records: summaries(list, types) }
    })
  )

  h.handle(
    `${ID}:record`,
    guarded((a: { id: string }) => {
      const d = getDb()
      const r = findRecord(a.id)
      const t = store.getType(d, r.type)
      // names for relation fields
      const relIds: string[] = []
      for (const f of t?.fields ?? []) if (f.kind === 'relation' && Array.isArray(r.fields[f.key])) relIds.push(...(r.fields[f.key] as string[]))
      const names = Object.fromEntries([...store.namesOf(d, relIds).entries()].map(([id, v]) => [id, v]))
      return {
        ok: true,
        record: redact(r, t),
        names,
        related: store.relatedItems(d, r.id),
        referencedBy: store.referencedBy(d, r.id),
        attachments: store.listAttachments(d, r.id).map(({ file: _f, ...rest }) => rest),
        activity: store.listActivity(d, 30, r.id)
      }
    })
  )

  h.handle(
    `${ID}:record-save`,
    guarded((raw: { id?: string; type: string; name: string; fields?: Record<string, unknown>; tags?: unknown; folder?: unknown }) => {
      const d = getDb()
      const existing = raw?.id ? findRecord(raw.id) : null
      const t = findType(existing?.type ?? String(raw?.type ?? ''))
      const name = String(raw?.name ?? '').trim().slice(0, 200)
      if (!name) throw new Error(`${t.nameLabel} is required.`)
      const { fields, changed } = sanitizeFields(t, raw?.fields ?? {}, existing?.fields ?? {})
      const tags = [...new Set((Array.isArray(raw?.tags) ? raw.tags : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, 30)
      const folder = String(raw?.folder ?? '')
        .split(/[\\/]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join('/')
        .slice(0, 200)
      let rec: DocRecord
      if (existing) {
        const nameChanged = existing.name !== name
        rec = store.updateRecord(d, existing.id, { name, fields, tags, folder })!
        const bits = [...(nameChanged ? [t.nameLabel] : []), ...changed]
        log('update', rec, bits.length ? `Changed: ${bits.join(', ')}` : 'Saved')
      } else {
        rec = store.insertRecord(d, { type: t.id, name, fields, tags, folder, favorite: false, archived: false })
        log('create', rec)
      }
      return { ok: true, record: redact(rec, t) }
    })
  )

  h.handle(
    `${ID}:record-flag`,
    guarded((a: { id: string; flag: 'favorite' | 'archived'; value: boolean }) => {
      const r = findRecord(a.id)
      if (a.flag !== 'favorite' && a.flag !== 'archived') throw new Error('Bad flag')
      store.setFlag(getDb(), r.id, a.flag, !!a.value)
      if (a.flag === 'archived') log(a.value ? 'archive' : 'restore', r)
      return { ok: true }
    })
  )

  h.handle(
    `${ID}:record-delete`,
    guarded((a: { id: string }) => {
      const r = findRecord(a.id)
      const atts = store.deleteRecord(getDb(), r.id)
      for (const at of atts) rmSync(at.file, { force: true })
      rmSync(join(attachDir, r.id), { recursive: true, force: true })
      log('delete', { id: null, type: r.type, name: r.name })
      return { ok: true }
    })
  )

  /* --------------------------------- secrets -------------------------------- */

  const secretOf = (id: string, fieldKey: string): { record: DocRecord; field: FieldDef; value: string } => {
    const r = findRecord(id)
    const t = findType(r.type)
    const f = t.fields.find((x) => x.key === fieldKey)
    if (!f || !isSecretKind(f.kind)) throw new Error('Not a secret field.')
    const v = r.fields[fieldKey]
    if (!isEncrypted(v)) return { record: r, field: f, value: '' }
    return { record: r, field: f, value: decryptValue(key(), v) }
  }

  h.handle(
    `${ID}:reveal`,
    guarded((a: { id: string; key: string }) => {
      const { record, field, value } = secretOf(a.id, a.key)
      log('reveal', record, field.label)
      return { ok: true, value }
    })
  )

  let clipTimer: NodeJS.Timeout | null = null
  h.handle(
    `${ID}:copy`,
    guarded((a: { id: string; key: string; totp?: boolean }) => {
      const { record, field, value } = secretOf(a.id, a.key)
      const text = a.totp ? totpCode(parseTotp(value)).code : value
      clipboard.writeText(text)
      log('copy', record, a.totp ? `${field.label} (one-time code)` : field.label)
      const secs = settings().clipboardClearSeconds
      if (clipTimer) clearTimeout(clipTimer)
      if (secs > 0)
        clipTimer = setTimeout(() => {
          try {
            if (sameSecret(clipboard.readText(), text)) clipboard.clear()
          } catch {
            /* clipboard unavailable */
          }
        }, secs * 1000)
      return { ok: true, clearsIn: secs }
    })
  )

  h.handle(
    `${ID}:totp`,
    guarded((a: { id: string; key: string }) => {
      const { value } = secretOf(a.id, a.key)
      if (!value) throw new Error('No one-time code secret stored.')
      const p = parseTotp(value)
      return { ok: true, ...totpCode(p), issuer: p.issuer, account: p.account }
    })
  )

  h.handle(`${ID}:generate-password`, (_e, o: Partial<GenOptions> & { passphrase?: boolean; words?: number }) => {
    if (o?.passphrase) return { ok: true, value: generatePassphrase(o.words ?? 4) }
    return {
      ok: true,
      value: generatePassword({
        length: Number(o?.length ?? 20) || 20,
        upper: o?.upper !== false,
        lower: o?.lower !== false,
        digits: o?.digits !== false,
        symbols: o?.symbols !== false,
        avoidAmbiguous: o?.avoidAmbiguous !== false
      })
    }
  })

  /* ------------------------------ search / meta ----------------------------- */

  h.handle(
    `${ID}:search`,
    guarded((a: { q: string; limit?: number }) => {
      const q = String(a?.q ?? '').trim()
      if (!q) return { ok: true, records: [] }
      const types = typeMap()
      return { ok: true, records: summaries(store.listRecords(getDb(), { q, archived: false, limit: a?.limit ?? 80 }), types) }
    })
  )

  h.handle(
    `${ID}:counts`,
    guarded((): { ok: true; counts: Counts } => {
      const d = getDb()
      return {
        ok: true,
        counts: {
          byType: store.countsByType(d),
          favorites: store.countWhere(d, 'favorite = 1 AND archived = 0'),
          archived: store.countWhere(d, 'archived = 1'),
          expiringSoon: expirations(30).length
        }
      }
    })
  )

  h.handle(
    `${ID}:expirations`,
    guarded((a?: { days?: number }) => ({ ok: true, items: expirations(Math.max(1, Math.min(3650, Number(a?.days ?? 90) || 90))) }))
  )

  h.handle(`${ID}:activity`, guarded((a?: { limit?: number }) => ({ ok: true, items: store.listActivity(getDb(), Math.min(1000, a?.limit ?? 100)) })))

  h.handle(`${ID}:folders`, guarded((a: { type: string }) => ({ ok: true, folders: store.listFolders(getDb(), String(a?.type ?? 'document')) })))

  h.handle(`${ID}:tags`, guarded(() => ({ ok: true, tags: store.allTags(getDb()) })))

  /* -------------------------------- relations ------------------------------- */

  h.handle(
    `${ID}:relation-add`,
    guarded((a: { a: string; b: string }) => {
      const x = findRecord(a.a)
      const y = findRecord(a.b)
      store.addRelation(getDb(), x.id, y.id)
      log('update', x, `Related to ${y.name}`)
      return { ok: true, related: store.relatedItems(getDb(), x.id) }
    })
  )

  h.handle(
    `${ID}:relation-remove`,
    guarded((a: { a: string; b: string }) => {
      store.removeRelation(getDb(), a.a, a.b)
      return { ok: true, related: store.relatedItems(getDb(), a.a) }
    })
  )

  h.handle(
    `${ID}:relation-search`,
    guarded((a: { q: string; type?: string; exclude?: string }) => {
      const types = typeMap()
      const list = store.listRecords(getDb(), { q: a?.q, type: a?.type || undefined, archived: false, limit: 25 }).filter((r) => r.id !== a?.exclude)
      return { ok: true, records: summaries(list, types) }
    })
  )

  /* ------------------------------- attachments ------------------------------ */

  h.handle(
    `${ID}:attach`,
    guarded(async (a: { recordId: string }) => {
      const r = findRecord(a.recordId)
      const win = ctx.getMainWindow()
      const opts = { title: `Attach files to ${r.name}`, properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[] }
      const picked = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
      if (picked.canceled || !picked.filePaths.length) return { ok: true, added: 0, attachments: store.listAttachments(getDb(), r.id).map(({ file: _f, ...x }) => x) }
      const dir = join(attachDir, r.id)
      mkdirSync(dir, { recursive: true })
      let added = 0
      for (const src of picked.filePaths) {
        const st = statSync(src)
        if (!st.isFile()) continue
        const dest = join(dir, `${randomUUID().slice(0, 8)}-${basename(src)}`)
        copyFileSync(src, dest)
        store.addAttachment(getDb(), { recordId: r.id, name: basename(src), size: st.size, file: dest })
        added++
      }
      log('attach', r, `${added} file${added === 1 ? '' : 's'}`)
      return { ok: true, added, attachments: store.listAttachments(getDb(), r.id).map(({ file: _f, ...x }) => x) }
    })
  )

  h.handle(
    `${ID}:attachment-open`,
    guarded(async (a: { id: string; reveal?: boolean }) => {
      const at = store.getAttachment(getDb(), a.id)
      if (!at) throw new Error('Attachment not found.')
      if (a.reveal) ctx.shell.showItemInFolder(at.file)
      else {
        const err = await ctx.shell.openPath(at.file)
        if (err) throw new Error(err)
      }
      return { ok: true }
    })
  )

  h.handle(
    `${ID}:attachment-remove`,
    guarded((a: { id: string }) => {
      const at = store.getAttachment(getDb(), a.id)
      if (!at) return { ok: true }
      rmSync(at.file, { force: true })
      store.removeAttachment(getDb(), at.id)
      return { ok: true, attachments: store.listAttachments(getDb(), at.recordId).map(({ file: _f, ...x }) => x) }
    })
  )

  /* --------------------------------- lookups -------------------------------- */

  h.handle(
    `${ID}:lookup-domain`,
    guarded(async (a: { id: string }) => {
      const d = getDb()
      const r = findRecord(a.id)
      const t = findType(r.type)
      const res: DomainLookup = await lookupDomain(r.name)
      const fields: Record<string, FieldValue> = { ...r.fields, _domainLookup: JSON.stringify(res) }
      const bits: string[] = []
      if (res.registrar && t.fields.some((f) => f.key === 'registrar')) {
        fields.registrar = res.registrar
        bits.push('registrar')
      }
      if (res.expires && t.fields.some((f) => f.key === 'expires')) {
        fields.expires = res.expires
        bits.push('expiry')
      }
      if (res.dns?.hints.length && t.fields.some((f) => f.key === 'dnsProvider') && !r.fields.dnsProvider) {
        const dnsHint = res.dns.hints.find((x) => x.startsWith('DNS: '))
        if (dnsHint) fields.dnsProvider = dnsHint.slice(5)
      }
      const rec = store.updateRecord(d, r.id, { fields })!
      log('lookup', rec, res.error ? `Domain lookup: ${res.error}` : `Domain lookup updated ${bits.length ? bits.join(' + ') : 'DNS'}`)
      return { ok: true, lookup: res, record: redact(rec, t) }
    })
  )

  h.handle(
    `${ID}:lookup-ssl`,
    guarded(async (a: { id: string }) => {
      const d = getDb()
      const r = findRecord(a.id)
      const t = findType(r.type)
      const host = normalizeDomain(String(r.fields.host || r.name))
      const port = Number(r.fields.port) || 443
      const res: SslLookup = await lookupSsl(host, port)
      const fields: Record<string, FieldValue> = { ...r.fields, _sslLookup: JSON.stringify(res) }
      if (res.validTo) {
        if (t.fields.some((f) => f.key === 'validTo')) fields.validTo = res.validTo
        if (t.fields.some((f) => f.key === 'issuer') && res.issuer) fields.issuer = res.issuer
      }
      const rec = store.updateRecord(d, r.id, { fields })!
      log('lookup', rec, res.error ? `SSL check: ${res.error}` : `SSL check: expires ${res.validTo}`)
      return { ok: true, lookup: res, record: redact(rec, t) }
    })
  )

  /* ---------------------------------- export --------------------------------- */

  h.handle(
    `${ID}:export`,
    guarded(async (a: { includeSecrets?: boolean }) => {
      const d = getDb()
      const types = store.listTypes(d)
      const secretKeys = new Map(types.map((t) => [t.id, new Set(t.fields.filter((f) => isSecretKind(f.kind)).map((f) => f.key))]))
      const records = store.listRecords(d, {}).map((r) => {
        const fields: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(r.fields)) {
          if (k.startsWith('_')) continue
          if (secretKeys.get(r.type)?.has(k) || isEncrypted(v)) fields[k] = a?.includeSecrets && isEncrypted(v) ? decryptValue(key(), v) : v ? '(secret not exported)' : ''
          else fields[k] = v
        }
        return { ...r, fields }
      })
      const relations = d.prepare('SELECT a, b FROM relations').all()
      const payload = { app: 'WICKED Documentation', version: 1, exportedAt: new Date().toISOString(), includesSecrets: !!a?.includeSecrets, types, records, relations }
      const stamp = new Date()
      const name = `Documentation export ${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')}.json`
      const win = ctx.getMainWindow()
      const opts = { title: 'Export documentation', defaultPath: join(ctx.app.getPath('documents'), name), filters: [{ name: 'JSON', extensions: ['json'] }] }
      const picked = win ? await ctx.dialog.showSaveDialog(win, opts) : await ctx.dialog.showSaveDialog(opts)
      if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true }
      mkdirSync(dirname(picked.filePath), { recursive: true })
      writeFileSync(picked.filePath, JSON.stringify(payload, null, 2))
      log('export', null, a?.includeSecrets ? 'Exported everything INCLUDING secrets (plain JSON)' : 'Exported (secrets omitted)')
      ctx.shell.showItemInFolder(picked.filePath)
      return { ok: true, file: picked.filePath, records: records.length }
    })
  )

  // links inside Markdown fields open in the system browser (renderer never navigates)
  h.handle(`${ID}:open-url`, (_e, url: unknown) => {
    const u = String(url ?? '')
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'Only http(s) links can be opened.' }
    void ctx.shell.openExternal(u)
    return { ok: true }
  })

  h.handle(`${ID}:data-paths`, (): ModuleDataPath[] => [
    { label: 'Documentation database', path: existsSync(dbPath) ? dbPath : null, note: 'SQLite — secret fields are encrypted with your Documentation password' },
    { label: 'Lock file', path: existsSync(vaultPath) ? vaultPath : null, note: 'Password-wrapped master key (portable; restores on another PC with the same password)' },
    { label: 'Attachments', path: existsSync(attachDir) ? attachDir : null }
  ])
}
