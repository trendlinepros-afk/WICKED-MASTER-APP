import { useCallback } from 'react';
import type { Message, Settings, VaultNote } from '../types';
import type { InjectedNote } from '../store/brainStore';
import { api } from '../lib/bridge';
import { useKeysStore } from '../store/keysStore';

// Port note: embeddings are generated in the main process (the OpenAI key
// lives in the shell's central vault and never reaches the renderer).
export function embedText(text: string): Promise<number[]> {
  return api.embedText(text);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function lastUserText(messages: Message[], n: number): string {
  return messages
    .filter((m) => m.role === 'user')
    .slice(-n)
    .flatMap((m) => m.content.filter((p) => p.type === 'text').map((p) => p.text || ''))
    .join(' ');
}

export interface BrainContextResult {
  systemText: string | null;
  injected: InjectedNote[];
}

export function useVaultSearch() {
  // Returns a system-message text block + the list of injected notes, or null context.
  const buildBrainContext = useCallback(
    async (messages: Message[], settings: Settings): Promise<BrainContextResult> => {
      const query = lastUserText(messages, 3);
      if (!query.trim()) return { systemText: null, injected: [] };

      // Step 1: keyword search via main process.
      const keywordHits = await api.vaultSearch(query);
      const merged = new Map<string, VaultNote>();
      for (const note of keywordHits.slice(0, 5)) merged.set(note.path, note);

      // Step 2: semantic search (only when an OpenAI key + indexing are available).
      const hasOpenAI = useKeysStore.getState().status['openai'] === true;
      if (hasOpenAI && settings.semanticIndexingEnabled) {
        try {
          const embeddings = await api.vaultGetEmbeddings();
          const paths = Object.keys(embeddings);
          if (paths.length > 0) {
            const queryEmbedding = await embedText(query);
            const scored = paths
              .map((p) => ({ path: p, score: cosineSimilarity(queryEmbedding, embeddings[p]) }))
              .sort((a, b) => b.score - a.score)
              .slice(0, 3)
              .filter((s) => s.score > 0.2);

            const allNotes = await api.vaultReadAll();
            const byPath = new Map(allNotes.map((n) => [n.path, n]));
            for (const s of scored) {
              const note = byPath.get(s.path);
              if (note && !merged.has(note.path)) merged.set(note.path, note);
            }
          }
        } catch (err) {
          console.warn('Semantic search failed, keyword only:', err);
        }
      }

      // Step 3: merge + take top 4, build injection block.
      const top = Array.from(merged.values()).slice(0, 4);
      if (top.length === 0) return { systemText: null, injected: [] };

      const blocks = top
        .map((n) => `[Note: ${n.path}]\n${n.body.slice(0, 2000)}`)
        .join('\n\n');
      const systemText = `=== Master Brain Context ===\nThe following notes from your knowledge vault are relevant to this conversation:\n\n${blocks}\n=== End Brain Context ===`;

      return {
        systemText,
        injected: top.map((n) => ({ path: n.path, title: n.title })),
      };
    },
    []
  );

  return { buildBrainContext };
}
