/**
 * Documentation — shared types (main + renderer). Type-only.
 *
 * Single-site IT documentation in the shape of IT Glue: core assets
 * (configurations, contacts, locations, documents, passwords, domains, SSL)
 * plus "flexible" asset types (LAN, Wireless, Backup, Licensing …) that are
 * just schemas — records of every type share one storage model.
 */

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'markdown'
  | 'number'
  | 'date'
  | 'select'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone'
  | 'ip'
  | 'password'
  | 'totp'
  | 'relation'

export interface FieldDef {
  /** stable key inside record.fields */
  key: string
  label: string
  kind: FieldKind
  required?: boolean
  /** select: choices */
  options?: string[]
  /** relation: asset type id the field links to (multi-select of that type's records) */
  relationType?: string
  hint?: string
  /** show as a column in the list view */
  showInList?: boolean
  /** date fields that count as expirations (dashboard + Expirations view) */
  expires?: boolean
  /** shipped with the app (can't be removed, label/hint editable) */
  builtin?: boolean
  /** number/text default */
  defaultValue?: string | number | boolean
}

export type Section = 'core' | 'apps' | 'admin'

export interface AssetType {
  id: string
  name: string
  namePlural: string
  /** lucide icon name (PascalCase) */
  icon: string
  section: Section
  fields: FieldDef[]
  builtin: boolean
  sortOrder: number
  description: string
  /** label for the record's name field ("Domain name", "Common name"…) */
  nameLabel: string
  archived: boolean
}

/** What the renderer sees for a secret field: never the value. */
export interface SecretPlaceholder {
  __secret: true
  /** a value is stored */
  set: boolean
}

export type FieldValue = string | number | boolean | string[] | SecretPlaceholder | null | undefined

export interface DocRecord {
  id: string
  type: string
  name: string
  fields: Record<string, FieldValue>
  tags: string[]
  /** documents: folder path like "Onboarding/Laptops" ('' = root) */
  folder: string
  favorite: boolean
  archived: boolean
  createdAt: number
  updatedAt: number
}

/** Row in a list / search result. */
export interface RecordSummary {
  id: string
  type: string
  name: string
  folder: string
  tags: string[]
  favorite: boolean
  archived: boolean
  updatedAt: number
  /** list-column values (already stringified) keyed by field key */
  preview: Record<string, string>
}

export interface RelatedItem {
  id: string
  type: string
  name: string
}

export type ActivityAction =
  | 'setup'
  | 'unlock'
  | 'lock'
  | 'password-changed'
  | 'create'
  | 'update'
  | 'delete'
  | 'archive'
  | 'restore'
  | 'reveal'
  | 'copy'
  | 'lookup'
  | 'attach'
  | 'export'

export interface Activity {
  id: number
  at: number
  action: ActivityAction
  recordId: string | null
  recordType: string | null
  recordName: string
  detail: string
}

export interface Attachment {
  id: string
  recordId: string
  name: string
  size: number
  addedAt: number
}

export interface Expiration {
  recordId: string
  type: string
  name: string
  fieldKey: string
  fieldLabel: string
  /** YYYY-MM-DD */
  date: string
  daysLeft: number
}

export interface VaultStatus {
  /** a password has been set (first-run setup done) */
  configured: boolean
  unlocked: boolean
  /** seconds until another unlock attempt is accepted (0 = now) */
  retryAfter: number
  failedAttempts: number
  autoLockMinutes: number
  /** the lock file lives outside this PC's user profile → restore-friendly note */
  lastUnlockAt: number | null
}

export interface DocSettings {
  autoLockMinutes: number
  /** asset type ids hidden from the sidebar */
  hiddenTypes: string[]
  /** clear the clipboard this many seconds after copying a secret (0 = never) */
  clipboardClearSeconds: number
}

export interface Counts {
  byType: Record<string, number>
  favorites: number
  archived: number
  expiringSoon: number
}

/* ------------------------------ lookups ------------------------------ */

export interface DnsRecords {
  a: string[]
  aaaa: string[]
  mx: { exchange: string; priority: number }[]
  ns: string[]
  txt: string[]
  cname: string[]
  /** common service hints derived from the records (e.g. "Google Workspace (MX)") */
  hints: string[]
}

export interface DomainLookup {
  checkedAt: number
  registrar: string
  /** YYYY-MM-DD */
  expires: string
  /** YYYY-MM-DD */
  registered: string
  /** YYYY-MM-DD */
  updated: string
  status: string[]
  nameservers: string[]
  dns: DnsRecords | null
  error: string
}

export interface SslLookup {
  checkedAt: number
  subject: string
  issuer: string
  /** YYYY-MM-DD */
  validFrom: string
  /** YYYY-MM-DD */
  validTo: string
  daysLeft: number
  altNames: string[]
  serial: string
  /** hostname matched the certificate and the chain verified */
  valid: boolean
  error: string
}
