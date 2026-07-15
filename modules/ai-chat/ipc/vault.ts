import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { VaultNote } from '../types';
import { getVaultPath } from './db';

const VAULT_SUBDIR = 'WickedBrain';
const CATEGORIES = [
  'Ideas',
  'Projects',
  'Workflows',
  'Decisions',
  'People',
  'Reference',
  'Uncategorized',
];

function vaultRoot(): string {
  const base = getVaultPath();
  if (!base) throw new Error('Vault path not configured');
  const root = path.join(base, VAULT_SUBDIR);
  ensureStructure(root);
  return root;
}

function ensureStructure(root: string): void {
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  for (const cat of CATEGORIES) {
    const dir = path.join(root, cat);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function embeddingsPath(): string {
  return path.join(vaultRoot(), '.embeddings.json');
}

// Recursively collect all .md files (excluding the auto index).
function walkMarkdown(dir: string, root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full, root));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const rel = path.relative(root, full);
      if (rel === '_index.md') continue;
      out.push(rel);
    }
  }
  return out;
}

interface ParsedFrontmatter {
  data: Record<string, string | string[]>;
  body: string;
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
  if (!match) return { data: {}, body: raw };
  const data: Record<string, string | string[]> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      data[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return { data, body: match[2] };
}

function noteFromFile(rel: string, root: string): VaultNote {
  const raw = fs.readFileSync(path.join(root, rel), 'utf-8');
  const { data, body } = parseFrontmatter(raw);
  const tags = Array.isArray(data.tags) ? data.tags : data.tags ? [String(data.tags)] : [];
  return {
    path: rel.split(path.sep).join('/'),
    title: (data.title as string) || path.basename(rel, '.md'),
    category: (data.category as string) || rel.split(path.sep)[0] || 'Uncategorized',
    tags,
    date: (data.date as string) || '',
    status: data.status as string | undefined,
    body: body.trim(),
  };
}

export function readAll(): VaultNote[] {
  const root = vaultRoot();
  const files = walkMarkdown(root, root);
  return files.map((rel) => noteFromFile(rel, root));
}

export function readNote(relPath: string): string {
  const root = path.resolve(vaultRoot());
  const full = path.resolve(path.join(root, relPath));
  // Prevent path traversal outside the vault. Compare against root + separator
  // so a sibling like `<base>/WickedBrain-secret` can't satisfy the check.
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('Invalid note path');
  }
  return fs.readFileSync(full, 'utf-8');
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'note'
  );
}

export function writeNote(category: string, filename: string, content: string): string {
  const root = vaultRoot();
  const cat = CATEGORIES.includes(category) ? category : 'Uncategorized';
  const dir = path.join(root, cat);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let base = slugify(filename);
  let target = path.join(dir, `${base}.md`);
  let counter = 1;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${base}-${counter}.md`);
    counter++;
  }
  fs.writeFileSync(target, content, 'utf-8');
  const rel = path.relative(root, target).split(path.sep).join('/');
  regenerateIndex();
  return rel;
}

// Write a note for a chat, overwriting the existing note for that chat if one
// exists (matched by `source_chat_id` frontmatter). Keeps one note per chat so
// scheduled re-commits update rather than pile up duplicates.
export function writeNoteForChat(
  category: string,
  filename: string,
  content: string,
  sourceChatId: string
): string {
  const root = vaultRoot();
  for (const rel of walkMarkdown(root, root)) {
    const raw = fs.readFileSync(path.join(root, rel), 'utf-8');
    const { data } = parseFrontmatter(raw);
    if (data.source_chat_id === sourceChatId) {
      fs.writeFileSync(path.join(root, rel), content, 'utf-8');
      regenerateIndex();
      return rel.split(path.sep).join('/');
    }
  }
  return writeNote(category, filename, content);
}

export function search(query: string): VaultNote[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (terms.length === 0) return [];
  const notes = readAll();
  const scored = notes.map((note) => {
    const haystack = `${note.title} ${note.tags.join(' ')} ${note.body}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (note.title.toLowerCase().includes(term)) score += 3;
      if (note.tags.some((tag) => tag.toLowerCase().includes(term))) score += 2;
      if (haystack.includes(term)) score += 1;
    }
    return { note, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.note);
}

export function getEmbeddings(): Record<string, number[]> {
  try {
    const raw = fs.readFileSync(embeddingsPath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveEmbedding(relPath: string, embedding: number[]): void {
  const all = getEmbeddings();
  all[relPath] = embedding;
  fs.writeFileSync(embeddingsPath(), JSON.stringify(all), 'utf-8');
}

// ---------- Git sync ----------

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: vaultRoot(), encoding: 'utf-8' }).trim();
}

export interface GitStatus {
  isRepo: boolean;
  hasRemote: boolean;
  branch: string;
  dirtyCount: number;
}

export function gitStatus(): GitStatus {
  const root = vaultRoot();
  const isRepo = fs.existsSync(path.join(root, '.git'));
  if (!isRepo) return { isRepo: false, hasRemote: false, branch: '', dirtyCount: 0 };
  let hasRemote = false;
  let branch = '';
  let dirtyCount = 0;
  try {
    hasRemote = git(['remote']).length > 0;
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    dirtyCount = git(['status', '--porcelain']).split('\n').filter(Boolean).length;
  } catch {
    /* ignore */
  }
  return { isRepo, hasRemote, branch, dirtyCount };
}

// Initialise the repo if needed, commit all changes, and push when a remote exists.
export function gitSync(message: string): string {
  const root = vaultRoot();
  if (!fs.existsSync(path.join(root, '.git'))) {
    git(['init']);
    try {
      git(['checkout', '-b', 'main']);
    } catch {
      /* already on a branch */
    }
  }
  git(['add', '-A']);
  const dirty = git(['status', '--porcelain']).length > 0;
  if (dirty) {
    try {
      git(['commit', '-m', message || 'WICKED vault sync']);
    } catch (err) {
      return `Commit failed: ${(err as Error).message}`;
    }
  }
  const hasRemote = (() => {
    try {
      return git(['remote']).length > 0;
    } catch {
      return false;
    }
  })();
  if (hasRemote) {
    try {
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
      git(['push', '-u', 'origin', branch]);
      return dirty ? 'Committed and pushed.' : 'Already up to date; pushed.';
    } catch (err) {
      return `Committed locally; push failed: ${(err as Error).message}`;
    }
  }
  return dirty ? 'Committed locally (no remote configured).' : 'Nothing to commit.';
}

export function regenerateIndex(): void {
  const root = vaultRoot();
  const notes = readAll();
  const byCategory = new Map<string, VaultNote[]>();
  for (const note of notes) {
    const list = byCategory.get(note.category) ?? [];
    list.push(note);
    byCategory.set(note.category, list);
  }

  let md = `---\ntitle: WICKED Brain Index\ngenerated: ${new Date().toISOString().slice(0, 10)}\n---\n\n# 🧠 WICKED Brain Index\n\nAuto-generated index of all notes in the vault.\n\n`;

  for (const cat of CATEGORIES) {
    const list = byCategory.get(cat);
    if (!list || list.length === 0) continue;
    md += `## ${cat}\n\n`;
    for (const note of list) {
      const firstLine =
        note.body
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith('#')) || '';
      const summary = firstLine.slice(0, 120);
      md += `- [[${note.path.replace(/\.md$/, '')}|${note.title}]]${
        summary ? ` — ${summary}` : ''
      }\n`;
    }
    md += '\n';
  }

  fs.writeFileSync(path.join(root, '_index.md'), md, 'utf-8');
}
