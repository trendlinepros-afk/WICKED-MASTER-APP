// IndexedDB layer — identical schema to the standalone GameDevHelper.html app
// (db "gamedevhelper" v1) so exported backups from the old app import unchanged.

const DB_NAME = 'gamedevhelper'
const DB_VER = 1
const STORES = ['folders', 'cards', 'images', 'timeEntries', 'settings'] as const
export type StoreName = (typeof STORES)[number]

let db: IDBDatabase | null = null

export function openDB(): Promise<void> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER)
    r.onupgradeneeded = () => {
      const d = r.result
      for (const s of STORES) {
        if (!d.objectStoreNames.contains(s)) {
          d.createObjectStore(s, { keyPath: s === 'settings' ? 'key' : 'id' })
        }
      }
    }
    r.onsuccess = () => {
      db = r.result
      res()
    }
    r.onerror = () => rej(r.error)
  })
}

function store(name: StoreName, mode: IDBTransactionMode): IDBObjectStore {
  if (!db) throw new Error('gamedev-board: database not open')
  return db.transaction(name, mode).objectStore(name)
}

export function getAll<T>(name: StoreName): Promise<T[]> {
  return new Promise((res, rej) => {
    const r = store(name, 'readonly').getAll()
    r.onsuccess = () => res(r.result as T[])
    r.onerror = () => rej(r.error)
  })
}

export function get<T>(name: StoreName, key: string): Promise<T | undefined> {
  return new Promise((res, rej) => {
    const r = store(name, 'readonly').get(key)
    r.onsuccess = () => res(r.result as T | undefined)
    r.onerror = () => rej(r.error)
  })
}

export function put(name: StoreName, val: unknown): Promise<void> {
  return new Promise((res, rej) => {
    const r = store(name, 'readwrite').put(val)
    r.onsuccess = () => res()
    r.onerror = () => rej(r.error)
  })
}

export function del(name: StoreName, key: string): Promise<void> {
  return new Promise((res, rej) => {
    const r = store(name, 'readwrite').delete(key)
    r.onsuccess = () => res()
    r.onerror = () => rej(r.error)
  })
}

export function clearStore(name: StoreName): Promise<void> {
  return new Promise((res, rej) => {
    const r = store(name, 'readwrite').clear()
    r.onsuccess = () => res()
    r.onerror = () => rej(r.error)
  })
}
