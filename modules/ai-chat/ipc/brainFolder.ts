import fs from 'node:fs';
import path from 'node:path';
import type { BrainDoc } from '../types';

// Reads/searches the markdown documents inside an arbitrary Obsidian folder — the
// "brain" backing an agent persona. Unlike vault.ts (which is tied to the single
// configured WickedBrain vault), these work on any folder the user points at.

function walkMarkdown(dir: string, root: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, root, out);
    else if (entry.isFile() && /\.(md|markdown|txt)$/i.test(entry.name)) {
      out.push(path.relative(root, full));
    }
  }
  return out;
}

function stripFrontmatter(raw: string): { title?: string; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
  if (!m) return { body: raw };
  let title: string | undefined;
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx !== -1 && line.slice(0, idx).trim().toLowerCase() === 'title') {
      title = line
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  }
  return { title, body: m[2] };
}

function readDoc(rel: string, root: string): BrainDoc {
  const raw = fs.readFileSync(path.join(root, rel), 'utf-8');
  const { title, body } = stripFrontmatter(raw);
  return {
    path: rel.split(path.sep).join('/'),
    title: title || path.basename(rel).replace(/\.(md|markdown|txt)$/i, ''),
    body: body.trim(),
  };
}

export function readAll(folderPath: string): BrainDoc[] {
  if (!folderPath || !fs.existsSync(folderPath)) return [];
  return walkMarkdown(folderPath, folderPath).map((rel) => readDoc(rel, folderPath));
}

// A compact digest of the brain (file count + titles/excerpts), used to have the
// model auto-write a persona from the documents.
export function digest(folderPath: string): { fileCount: number; sample: string } {
  const docs = readAll(folderPath);
  const parts: string[] = [];
  let budget = 8000;
  for (const d of docs) {
    if (budget <= 0) break;
    const excerpt = d.body.slice(0, 400);
    const block = `## ${d.title}\n${excerpt}\n`;
    parts.push(block);
    budget -= block.length;
  }
  return { fileCount: docs.length, sample: parts.join('\n') };
}

// Keyword-rank the brain's docs against a query and return the most relevant,
// with bodies truncated so the combined injection stays within a char budget.
export function search(folderPath: string, query: string, limit = 6): BrainDoc[] {
  const docs = readAll(folderPath);
  if (docs.length === 0) return [];
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);

  const scored = docs.map((d) => {
    const hay = `${d.title}\n${d.body}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (d.title.toLowerCase().includes(t)) score += 3;
      let idx = hay.indexOf(t);
      while (idx !== -1) {
        score += 1;
        idx = hay.indexOf(t, idx + t.length);
      }
    }
    return { d, score };
  });

  const ranked = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.d);

  // No keyword hits (e.g. very short query) → fall back to the first few docs so
  // the brain still has something grounding, rather than nothing.
  const chosen = ranked.length > 0 ? ranked : docs.slice(0, Math.min(limit, docs.length));

  // Truncate bodies to keep total injection bounded (~16k chars).
  let budget = 16000;
  const out: BrainDoc[] = [];
  for (const d of chosen) {
    if (budget <= 0) break;
    const body = d.body.slice(0, Math.max(500, Math.min(3000, budget)));
    out.push({ ...d, body });
    budget -= body.length;
  }
  return out;
}
