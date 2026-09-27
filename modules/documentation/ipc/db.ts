/**
 * SQLite storage for Documentation (main). Records of every asset type share
 * one table with their fields as JSON; this layer knows nothing about
 * encryption — ipc.ts encrypts secret field values before they get here.
 */
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { Activity, ActivityAction, AssetType, Attachment, DocRecord, FieldDef, FieldValue, RelatedItem } from '../types'
import { BUILTIN_TYPES } from '../lib/schema'

export type Db = Database.Database

export function openDb(path: string): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS asset_types (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      namePlural TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT 'FileText',
      section TEXT NOT NULL DEFAULT 'apps',
      fields TEXT NOT NULL DEFAULT '[]',
      builtin INTEGER NOT NULL DEFAULT 0,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      nameLabel TEXT NOT NULL DEFAULT 'Name',
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      fields TEXT NOT NULL DEFAULT '{}',
      tags TEXT NOT NULL DEFAULT '[]',
      folder TEXT NOT NULL DEFAULT '',
      favorite INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_type ON records(type, archived, name);
    CREATE TABLE IF NOT EXISTS relations (
      a TEXT NOT NULL,
      b TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (a, b)
    );
    CREATE INDEX IF NOT EXISTS relations_b ON relations(b);
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      action TEXT NOT NULL,
      recordId TEXT,
      recordType TEXT,
      recordName TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      recordId TEXT NOT NULL,
      name TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      file TEXT NOT NULL,
      addedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attachments_record ON attachments(recordId);
  `)
  seedTypes(db)
  return db
}

/* --------------------------------- meta --------------------------------- */

export function getMeta<T>(db: Db, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

export function setMeta(db: Db, key: string, value: unknown): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
}

/* ------------------------------- asset types ------------------------------ */

interface TypeRow {
  id: string
  name: string
  namePlural: string
  icon: string
  section: string
  fields: string
  builtin: number
  sortOrder: number
  description: string
  nameLabel: string
  archived: number
}

const rowToType = (r: TypeRow): AssetType => {
  let fields: FieldDef[] = []
  try {
    fields = JSON.parse(r.fields) as FieldDef[]
  } catch {
    /* damaged → empty */
  }
  return {
    id: r.id,
    name: r.name,
    namePlural: r.namePlural || r.name,
    icon: r.icon,
    section: (['core', 'apps', 'admin'].includes(r.section) ? r.section : 'apps') as AssetType['section'],
    fields,
    builtin: !!r.builtin,
    sortOrder: r.sortOrder,
    description: r.description,
    nameLabel: r.nameLabel || 'Name',
    archived: !!r.archived
  }
}

/** Insert builtin types that are missing; add builtin fields newer app versions introduced. Never touches user edits. */
export function seedTypes(db: Db): void {
  const get = db.prepare('SELECT * FROM asset_types WHERE id = ?')
  const ins = db.prepare(
    'INSERT INTO asset_types (id, name, namePlural, icon, section, fields, builtin, sortOrder, description, nameLabel, archived) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0)'
  )
  const upd = db.prepare('UPDATE asset_types SET fields = ? WHERE id = ?')
  const tx = db.transaction(() => {
    for (const t of BUILTIN_TYPES) {
      const row = get.get(t.id) as TypeRow | undefined
      if (!row) {
        ins.run(t.id, t.name, t.namePlural, t.icon, t.section, JSON.stringify(t.fields), t.sortOrder, t.description, t.nameLabel)
        continue
      }
      const cur = rowToType(row)
      const have = new Set(cur.fields.map((f) => f.key))
      const missing = t.fields.filter((f) => !have.has(f.key))
      if (missing.length) {
        // put new builtin fields before the trailing notes field, after the rest
        const notesIdx = cur.fields.findIndex((f) => f.key === 'notes')
        const merged = notesIdx >= 0 ? [...cur.fields.slice(0, notesIdx), ...missing.filter((f) => f.key !== 'notes'), ...cur.fields.slice(notesIdx)] : [...cur.fields, ...missing]
        upd.run(JSON.stringify(merged), t.id)
      }
    }
  })
  tx()
}

const SECTION_ORDER: Record<string, number> = { core: 0, apps: 1, admin: 2 }

export function listTypes(db: Db): AssetType[] {
  return (db.prepare('SELECT * FROM asset_types').all() as TypeRow[])
    .map(rowToType)
    .sort((a, b) => SECTION_ORDER[a.section] - SECTION_ORDER[b.section] || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

export function getType(db: Db, id: string): AssetType | null {
  const row = db.prepare('SELECT * FROM asset_types WHERE id = ?').get(id) as TypeRow | undefined
  return row ? rowToType(row) : null
}

export function saveType(db: Db, t: AssetType): void {
  db.prepare(
    `INSERT INTO asset_types (id, name, namePlural, icon, section, fields, builtin, sortOrder, description, nameLabel, archived)
     VALUES (@id, @name, @namePlural, @icon, @section, @fields, @builtin, @sortOrder, @description, @nameLabel, @archived)
     ON CONFLICT(id) DO UPDATE SET name = @name, namePlural = @namePlural, icon = @icon, section = @section, fields = @fields,
       sortOrder = @sortOrder, description = @description, nameLabel = @nameLabel, archived = @archived`
  ).run({
    id: t.id,
    name: t.name,
    namePlural: t.namePlural,
    icon: t.icon,
    section: t.section,
    fields: JSON.stringify(t.fields),
    builtin: t.builtin ? 1 : 0,
    sortOrder: t.sortOrder,
    description: t.description,
    nameLabel: t.nameLabel,
    archived: t.archived ? 1 : 0
  })
}

/** Delete a custom type and everything filed under it. Returns records removed. */
export function deleteType(db: Db, id: string): number {
  const ids = (db.prepare('SELECT id FROM records WHERE type = ?').all(id) as { id: string }[]).map((r) => r.id)
  const tx = db.transaction(() => {
    for (const rid of ids) deleteRecord(db, rid)
    db.prepare('DELETE FROM asset_types WHERE id = ? AND builtin = 0').run(id)
  })
  tx()
  return ids.length
}

/* --------------------------------- records -------------------------------- */

interface RecordRow {
  id: string
  type: string
  name: string
  fields: string
  tags: string
  folder: string
  favorite: number
  archived: number
  createdAt: number
  updatedAt: number
}

const parseJson = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

export const rowToRecord = (r: RecordRow): DocRecord => ({
  id: r.id,
  type: r.type,
  name: r.name,
  fields: parseJson<Record<string, FieldValue>>(r.fields, {}),
  tags: parseJson<string[]>(r.tags, []),
  folder: r.folder,
  favorite: !!r.favorite,
  archived: !!r.archived,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt
})

export function getRecord(db: Db, id: string): DocRecord | null {
  const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow | undefined
  return row ? rowToRecord(row) : null
}

export function insertRecord(db: Db, r: Omit<DocRecord, 'id' | 'createdAt' | 'updatedAt'>, now = Date.now()): DocRecord {
  const id = randomUUID()
  db.prepare(
    'INSERT INTO records (id, type, name, fields, tags, folder, favorite, archived, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, r.type, r.name, JSON.stringify(r.fields), JSON.stringify(r.tags), r.folder, r.favorite ? 1 : 0, r.archived ? 1 : 0, now, now)
  return { ...r, id, createdAt: now, updatedAt: now }
}

export function updateRecord(db: Db, id: string, patch: Partial<Pick<DocRecord, 'name' | 'fields' | 'tags' | 'folder' | 'favorite' | 'archived'>>, now = Date.now()): DocRecord | null {
  const cur = getRecord(db, id)
  if (!cur) return null
  const next: DocRecord = { ...cur, ...patch, updatedAt: now }
  db.prepare('UPDATE records SET name = ?, fields = ?, tags = ?, folder = ?, favorite = ?, archived = ?, updatedAt = ? WHERE id = ?').run(
    next.name,
    JSON.stringify(next.fields),
    JSON.stringify(next.tags),
    next.folder,
    next.favorite ? 1 : 0,
    next.archived ? 1 : 0,
    now,
    id
  )
  return next
}

/** Flip favorite/archived without bumping updatedAt (they're not edits). */
export function setFlag(db: Db, id: string, flag: 'favorite' | 'archived', value: boolean): void {
  db.prepare(`UPDATE records SET ${flag} = ? WHERE id = ?`).run(value ? 1 : 0, id)
}

export function deleteRecord(db: Db, id: string): (Attachment & { file: string })[] {
  const atts = listAttachments(db, id)
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM records WHERE id = ?').run(id)
    db.prepare('DELETE FROM relations WHERE a = ? OR b = ?').run(id, id)
    db.prepare('DELETE FROM attachments WHERE recordId = ?').run(id)
  })
  tx()
  return atts
}

export interface ListOpts {
  type?: string
  archived?: boolean
  favorite?: boolean
  /** documents: exact folder */
  folder?: string
  /** case-insensitive substring over name / tags / field values */
  q?: string
  limit?: number
}

export function listRecords(db: Db, o: ListOpts): DocRecord[] {
  const where: string[] = []
  const args: unknown[] = []
  if (o.type) {
    where.push('type = ?')
    args.push(o.type)
  }
  if (o.archived !== undefined) {
    where.push('archived = ?')
    args.push(o.archived ? 1 : 0)
  }
  if (o.favorite) where.push('favorite = 1')
  if (o.folder !== undefined) {
    where.push('folder = ?')
    args.push(o.folder)
  }
  if (o.q?.trim()) {
    const like = `%${o.q.trim().toLowerCase()}%`
    where.push('(lower(name) LIKE ? OR lower(tags) LIKE ? OR lower(fields) LIKE ? OR lower(folder) LIKE ?)')
    args.push(like, like, like, like)
  }
  const sql = `SELECT * FROM records${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY favorite DESC, lower(name) ASC LIMIT ?`
  args.push(o.limit ?? 5000)
  return (db.prepare(sql).all(...args) as RecordRow[]).map(rowToRecord)
}

/** id → name for a set of record ids (relation chips, previews). */
export function namesOf(db: Db, ids: string[]): Map<string, { name: string; type: string }> {
  const out = new Map<string, { name: string; type: string }>()
  const uniq = [...new Set(ids)].filter(Boolean)
  for (let i = 0; i < uniq.length; i += 500) {
    const chunk = uniq.slice(i, i + 500)
    const rows = db.prepare(`SELECT id, name, type FROM records WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as { id: string; name: string; type: string }[]
    for (const r of rows) out.set(r.id, { name: r.name, type: r.type })
  }
  return out
}

export function countsByType(db: Db): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of db.prepare('SELECT type, COUNT(*) AS n FROM records WHERE archived = 0 GROUP BY type').all() as { type: string; n: number }[]) out[r.type] = r.n
  return out
}

export function countWhere(db: Db, sql: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${sql}`).get() as { n: number }).n
}

export function listFolders(db: Db, type: string): string[] {
  return (db.prepare('SELECT DISTINCT folder FROM records WHERE type = ? AND archived = 0 AND folder != ? ORDER BY folder').all(type, '') as { folder: string }[]).map((r) => r.folder)
}

export function allTags(db: Db): string[] {
  const seen = new Map<string, number>()
  for (const r of db.prepare('SELECT tags FROM records WHERE archived = 0').all() as { tags: string }[]) {
    for (const t of parseJson<string[]>(r.tags, [])) seen.set(t, (seen.get(t) ?? 0) + 1)
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t)
}

/* -------------------------------- relations ------------------------------- */

const pair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x])

export function addRelation(db: Db, x: string, y: string, now = Date.now()): void {
  if (x === y) return
  const [a, b] = pair(x, y)
  db.prepare('INSERT OR IGNORE INTO relations (a, b, createdAt) VALUES (?, ?, ?)').run(a, b, now)
}

export function removeRelation(db: Db, x: string, y: string): void {
  const [a, b] = pair(x, y)
  db.prepare('DELETE FROM relations WHERE a = ? AND b = ?').run(a, b)
}

export function relatedItems(db: Db, id: string): RelatedItem[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.type, r.name FROM relations x JOIN records r ON r.id = CASE WHEN x.a = ? THEN x.b ELSE x.a END
       WHERE x.a = ? OR x.b = ? ORDER BY r.type, lower(r.name)`
    )
    .all(id, id, id) as RelatedItem[]
  return rows
}

/** Records whose relation FIELDS point at `id` (e.g. every configuration at a location). */
export function referencedBy(db: Db, id: string): RelatedItem[] {
  const like = `%"${id}"%`
  return (db.prepare('SELECT id, type, name FROM records WHERE fields LIKE ? AND id != ? AND archived = 0 ORDER BY type, lower(name)').all(like, id) as RelatedItem[])
}

/* -------------------------------- activity -------------------------------- */

export function logActivity(db: Db, a: { action: ActivityAction; recordId?: string | null; recordType?: string | null; recordName?: string; detail?: string }, now = Date.now()): void {
  db.prepare('INSERT INTO activity (at, action, recordId, recordType, recordName, detail) VALUES (?, ?, ?, ?, ?, ?)').run(
    now,
    a.action,
    a.recordId ?? null,
    a.recordType ?? null,
    a.recordName ?? '',
    a.detail ?? ''
  )
  // keep the log bounded
  db.prepare('DELETE FROM activity WHERE id IN (SELECT id FROM activity ORDER BY id DESC LIMIT -1 OFFSET 5000)').run()
}

export function listActivity(db: Db, limit = 100, recordId?: string): Activity[] {
  return recordId
    ? (db.prepare('SELECT * FROM activity WHERE recordId = ? ORDER BY id DESC LIMIT ?').all(recordId, limit) as Activity[])
    : (db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit) as Activity[])
}

/* ------------------------------- attachments ------------------------------ */

export function addAttachment(db: Db, a: { recordId: string; name: string; size: number; file: string }, now = Date.now()): Attachment {
  const id = randomUUID()
  db.prepare('INSERT INTO attachments (id, recordId, name, size, file, addedAt) VALUES (?, ?, ?, ?, ?, ?)').run(id, a.recordId, a.name, a.size, a.file, now)
  return { id, recordId: a.recordId, name: a.name, size: a.size, addedAt: now }
}

export function listAttachments(db: Db, recordId: string): (Attachment & { file: string })[] {
  return db.prepare('SELECT * FROM attachments WHERE recordId = ? ORDER BY addedAt').all(recordId) as (Attachment & { file: string })[]
}

export function getAttachment(db: Db, id: string): (Attachment & { file: string }) | null {
  return (db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as (Attachment & { file: string }) | undefined) ?? null
}

export function removeAttachment(db: Db, id: string): void {
  db.prepare('DELETE FROM attachments WHERE id = ?').run(id)
}
