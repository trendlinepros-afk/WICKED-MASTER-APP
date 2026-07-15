import fs from 'node:fs';
import path from 'node:path';
import * as db from './db';
import * as projectBoard from './projectBoard';
import type { DataLocations } from '../types';

// One folder to rule them all: the user can point the app at a single root
// (e.g. a network share) and consolidate every file-based store under it:
//
//   <root>/Obsidian Vault/     — the memory vault (vaultPath)
//   <root>/Project Boards/     — project board data (projectBoardPath)
//   <root>/Backups/            — rolling copies of the chat database
//
// The live SQLite database intentionally STAYS on the local disk: SQLite in
// WAL mode over SMB/network filesystems is a well-known corruption risk. It
// is backed up into <root>/Backups on launch and every few hours instead.

const BACKUP_KEEP = 14;
const BACKUP_EVERY_MS = 6 * 3600_000;

function backupsDir(root: string): string {
  return path.join(root, 'Backups');
}

export function getLocations(): DataLocations {
  const s = db.getSettings();
  let lastBackup: number | null = null;
  if (s.dataRootPath) {
    try {
      for (const name of fs.readdirSync(backupsDir(s.dataRootPath))) {
        const st = fs.statSync(path.join(backupsDir(s.dataRootPath), name));
        if (st.isFile()) lastBackup = Math.max(lastBackup ?? 0, st.mtimeMs);
      }
    } catch {
      // No backups yet or share offline.
    }
  }
  return {
    dataRootPath: s.dataRootPath,
    dbPath: db.dbFilePath(),
    vaultPath: s.vaultPath,
    projectBoardPath: projectBoard.getDataFolder(),
    lastBackupAt: lastBackup,
  };
}

// Move every file-based store under `root` and remember it as the data root.
// Copies are non-destructive: originals stay in place until the user deletes
// them. Returns a human-readable list of what happened.
export async function consolidate(root: string): Promise<string[]> {
  const actions: string[] = [];
  fs.mkdirSync(root, { recursive: true }); // throws if the share is unreachable
  const s = db.getSettings();

  const moveFolderSetting = (
    current: string,
    targetName: string,
    save: (p: string) => void,
    label: string
  ) => {
    if (!current) return;
    const target = path.join(root, targetName);
    if (path.resolve(current) === path.resolve(target)) {
      actions.push(`${label} is already in place.`);
      return;
    }
    if (fs.existsSync(target)) {
      actions.push(`${label}: pointed at the existing "${targetName}" folder on the share.`);
    } else {
      fs.cpSync(current, target, { recursive: true });
      actions.push(
        `${label}: copied to "${targetName}". The original at ${current} was left untouched — delete it once you've verified the copy.`
      );
    }
    save(target);
  };

  moveFolderSetting(
    s.vaultPath,
    'Obsidian Vault',
    (p) => db.saveSettings({ vaultPath: p }),
    'Obsidian memory vault'
  );

  // Project Board has its own migration (copies boards + image assets).
  const pbTarget = path.join(root, 'Project Boards');
  if (path.resolve(projectBoard.getDataFolder()) !== path.resolve(pbTarget)) {
    projectBoard.migrateData(pbTarget);
    db.saveSettings({ projectBoardPath: pbTarget });
    actions.push('Project Boards: copied to "Project Boards" and re-pointed.');
  } else {
    actions.push('Project Boards are already in place.');
  }

  db.saveSettings({ dataRootPath: root });

  // First database backup right away, so the share has everything from day one.
  const backed = await backupNow();
  actions.push(
    backed
      ? 'Chat database: backup written to "Backups" (the live database stays on this PC — SQLite is unsafe on network drives — and is re-backed up on every launch and every 6 hours).'
      : 'Chat database: backup failed — check that the share is writable.'
  );
  return actions;
}

export async function backupNow(): Promise<boolean> {
  const root = db.getSettings().dataRootPath;
  if (!root) return false;
  try {
    const dir = backupsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const target = path.join(dir, `wicked-${stamp}.db`);
    await db.backupTo(target);
    prune(dir);
    return true;
  } catch (err) {
    console.warn('[backup]', (err as Error).message);
    return false;
  }
}

function prune(dir: string): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((n) => /^wicked-\d{4}-\d{2}-\d{2}\.db$/.test(n))
      .sort()
      .reverse();
    for (const name of files.slice(BACKUP_KEEP)) {
      fs.unlinkSync(path.join(dir, name));
    }
  } catch {
    // Best effort.
  }
}

// Back up shortly after launch (deferred so startup isn't slowed), then on an
// interval while the app runs.
export function startBackupSchedule(): void {
  setTimeout(() => void backupNow(), 30_000);
  setInterval(() => void backupNow(), BACKUP_EVERY_MS);
}
