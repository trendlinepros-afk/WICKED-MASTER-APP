import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as db from './db';
import type { BoardData, Project } from '../types';

// File-backed storage for the Project Board. Everything lives under one root
// folder the user can re-map (e.g. onto a network drive):
//
//   <root>/projects.json                      — the project index
//   <root>/boards/<projectId>/board.json      — items, strokes, categories
//   <root>/boards/<projectId>/assets/<id>.png — pasted / imported images
//
// board.json only references images by assetId, so boards stay small and
// images are written once.

export function getDataFolder(): string {
  const configured = db.getSettings().projectBoardPath;
  return configured || path.join(db.moduleDataDir(), 'ProjectBoards');
}

function ensureRoot(): string {
  const root = getDataFolder();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function indexPath(root: string): string {
  return path.join(root, 'projects.json');
}

function boardDir(root: string, projectId: string): string {
  return path.join(root, 'boards', projectId);
}

function assetsDir(root: string, projectId: string): string {
  return path.join(boardDir(root, projectId), 'assets');
}

// Write via temp file + rename so a crash (or a flaky network share) never
// leaves a half-written JSON file behind.
function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

// ---------- Projects ----------

export function listProjects(): Project[] {
  const root = ensureRoot();
  const projects = readJson<Project[]>(indexPath(root), []);
  return Array.isArray(projects) ? projects : [];
}

function saveIndex(projects: Project[]): void {
  writeJsonAtomic(indexPath(ensureRoot()), projects);
}

export function createProject(name: string, icon?: string): Project {
  const now = Date.now();
  const project: Project = {
    id: randomUUID(),
    name: name.trim() || 'Untitled project',
    icon: icon || '📁',
    createdAt: now,
    updatedAt: now,
  };
  saveIndex([...listProjects(), project]);
  fs.mkdirSync(assetsDir(getDataFolder(), project.id), { recursive: true });
  return project;
}

export function renameProject(id: string, name: string): void {
  saveIndex(
    listProjects().map((p) =>
      p.id === id ? { ...p, name: name.trim() || p.name, updatedAt: Date.now() } : p
    )
  );
}

export function deleteProject(id: string): void {
  saveIndex(listProjects().filter((p) => p.id !== id));
  const dir = boardDir(getDataFolder(), id);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn('[projectBoard] delete failed:', (err as Error).message);
  }
}

// ---------- Boards ----------

const EMPTY_BOARD: BoardData = { items: [], strokes: [], categories: [], updatedAt: 0 };

export function loadBoard(projectId: string): BoardData {
  const file = path.join(boardDir(ensureRoot(), projectId), 'board.json');
  const data = readJson<BoardData>(file, EMPTY_BOARD);
  return {
    items: Array.isArray(data.items) ? data.items : [],
    strokes: Array.isArray(data.strokes) ? data.strokes : [],
    categories: Array.isArray(data.categories) ? data.categories : [],
    updatedAt: data.updatedAt || 0,
  };
}

export function saveBoard(projectId: string, data: BoardData): void {
  const dir = boardDir(ensureRoot(), projectId);
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, 'board.json'), data);
  saveIndex(
    listProjects().map((p) => (p.id === projectId ? { ...p, updatedAt: Date.now() } : p))
  );
  pruneAssets(projectId, data);
}

// Remove image files no longer referenced by any board item. Only files older
// than a few minutes are touched so an asset saved moments ago (whose item may
// not be in this snapshot yet) is never swept up.
function pruneAssets(projectId: string, data: BoardData): void {
  const dir = assetsDir(getDataFolder(), projectId);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const referenced = new Set(data.items.map((i) => i.assetId).filter(Boolean));
  const cutoff = Date.now() - 10 * 60_000;
  for (const name of entries) {
    const assetId = name.replace(/\.[^.]+$/, '');
    if (referenced.has(assetId)) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {
      // Ignore — the file may be locked or already gone.
    }
  }
}

// ---------- Assets (images) ----------

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export function saveAsset(projectId: string, dataUrl: string): { assetId: string } {
  const m = /^data:(image\/[\w+.-]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) throw new Error('Not an image data URL');
  const [, mime, base64] = m;
  const dir = assetsDir(ensureRoot(), projectId);
  fs.mkdirSync(dir, { recursive: true });
  const assetId = randomUUID();
  fs.writeFileSync(path.join(dir, assetId + (EXT_BY_MIME[mime] ?? '.png')), base64, 'base64');
  return { assetId };
}

export function saveAssetFromFile(
  projectId: string,
  filePath: string
): { assetId: string; dataUrl: string } {
  const ext = path.extname(filePath).toLowerCase();
  const mime =
    Object.entries(EXT_BY_MIME).find(([, e]) => e === (ext === '.jpeg' ? '.jpg' : ext))?.[0] ??
    'image/png';
  const buffer = fs.readFileSync(filePath);
  const dir = assetsDir(ensureRoot(), projectId);
  fs.mkdirSync(dir, { recursive: true });
  const assetId = randomUUID();
  fs.writeFileSync(path.join(dir, assetId + (EXT_BY_MIME[mime] ?? '.png')), buffer);
  return { assetId, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
}

export function getAsset(projectId: string, assetId: string): string | null {
  // assetId is a UUID we generated; reject anything path-like defensively.
  if (!/^[\w-]+$/.test(assetId)) return null;
  const dir = assetsDir(getDataFolder(), projectId);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const name = entries.find((n) => n.startsWith(assetId));
  if (!name) return null;
  const ext = path.extname(name);
  const mime = Object.entries(EXT_BY_MIME).find(([, e]) => e === ext)?.[0] ?? 'image/png';
  const buffer = fs.readFileSync(path.join(dir, name));
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

// ---------- Re-mapping the data folder ----------

// Copy the current root's contents into a new folder (used when the user maps
// a network drive and wants existing boards brought along). The setting itself
// is saved by the caller after this succeeds.
export function migrateData(newRoot: string): void {
  const oldRoot = getDataFolder();
  if (path.resolve(oldRoot) === path.resolve(newRoot)) return;
  fs.mkdirSync(newRoot, { recursive: true });
  if (fs.existsSync(indexPath(oldRoot))) {
    fs.copyFileSync(indexPath(oldRoot), indexPath(newRoot));
  }
  const boards = path.join(oldRoot, 'boards');
  if (fs.existsSync(boards)) {
    fs.cpSync(boards, path.join(newRoot, 'boards'), { recursive: true });
  }
}
