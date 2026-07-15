import type { StreamTokenEvent, WickedAPI } from '../types';
import { RPC_CHANNELS, STREAM_TOKEN_EVENT } from '../shared/rpc';

/**
 * Renderer-side bridge. The standalone app exposed `window.polyglot` from its
 * preload; inside WICKED the shell exposes only the generic
 * `window.wicked.invoke/on` bridge, so this file recreates the same typed API
 * object on top of it, generated from the shared method → channel map
 * (shared/rpc.ts). Components import { api } from '../lib/bridge' instead of
 * touching window.polyglot.
 *
 * In the LAN web portal the injected bridge script provides a window.wicked
 * shim (HTTP RPC) and sets `__wickedPortal`; a few desktop-only methods are
 * replaced with browser-native equivalents below, exactly like the standalone
 * portal did.
 */

declare global {
  interface Window {
    /** set by the LAN portal's injected bridge script */
    __wickedPortal?: boolean;
  }
}

const generated = Object.fromEntries(
  Object.entries(RPC_CHANNELS).map(([method, channel]) => [
    method,
    (...args: unknown[]) => window.wicked.invoke(channel, ...args),
  ])
) as unknown as WickedAPI;

export const api: WickedAPI = generated;

/** Subscribe to cumulative stream-token pushes; returns an unsubscribe fn. */
export function onStreamToken(cb: (e: StreamTokenEvent) => void): () => void {
  return window.wicked.on(STREAM_TOKEN_EVENT, (...args: unknown[]) =>
    cb(args[0] as StreamTokenEvent)
  );
}

// ---------- LAN portal: browser-native replacements ----------

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    (input as HTMLInputElement & { oncancel: (() => void) | null }).oncancel = () =>
      resolve(null);
    input.click();
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

if (typeof window !== 'undefined' && window.__wickedPortal) {
  api.openFileDialog = async () => {
    const file = await pickFile('.jpg,.jpeg,.png,.gif,.webp,.pdf,.txt,.md');
    if (!file) return null;
    const dataUrl = await fileToDataUrl(file);
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const text = /\.(txt|md)$/i.test(file.name) ? await file.text() : undefined;
    return { name: file.name, mime: file.type || 'application/octet-stream', data: base64, text };
  };

  api.pbImportImage = async (projectId: string) => {
    const file = await pickFile('image/*');
    if (!file) return null;
    const dataUrl = await fileToDataUrl(file);
    const { assetId } = await api.pbSaveAsset(projectId, dataUrl);
    return { assetId, dataUrl };
  };

  api.exportMarkdown = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${filename}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    return Promise.resolve(a.download);
  };

  api.exportPDF = () => Promise.resolve(null);
  api.openVaultFolderDialog = () => Promise.resolve(null);
  api.pbChooseDataFolder = () => Promise.resolve(null);
  api.comfyChooseFolder = () => Promise.resolve(null);
  api.fluxGymChooseFolder = () => Promise.resolve(null);
  api.fluxGymPickImages = () => Promise.resolve([]);
  api.openExternal = (p: string) => {
    if (/^https?:\/\//i.test(String(p))) window.open(p, '_blank', 'noopener');
    return Promise.resolve();
  };
}
