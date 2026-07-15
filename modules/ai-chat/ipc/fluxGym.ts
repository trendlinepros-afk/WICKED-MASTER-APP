import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dialog, nativeImage, shell, type BrowserWindow } from 'electron';
import * as db from './db';
import type { FluxGymStatus, TrainingCheck, TrainingImage } from '../types';

// In-app LoRA training pipeline built around FluxGym (usually installed via
// Pinokio). WICKED does the fiddly parts — building the dataset folder with
// trigger-word captions, watching for the finished .safetensors, and copying
// it into ComfyUI's models/loras — while FluxGym does the actual training.

export const FLUXGYM_URL = 'http://127.0.0.1:7860';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);

// A finished safetensors is only trusted once it has stopped growing — the
// trainer writes it in one pass but slowly on big files.
const SETTLE_MS = 20_000;

let child: ChildProcess | null = null;

function looksLikeFluxGym(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'app.py'));
  } catch {
    return false;
  }
}

// Where FluxGym lives: the configured folder, or the usual Pinokio spots.
// Pinokio clones apps under <pinokio-home>/api/<name>/(app/), and the drive
// root install is common on Windows.
export function resolveRoot(): { root: string; autoDetected: boolean } {
  const configured = db.getSettings().fluxGymPath;
  if (configured) {
    // Accept the folder itself or its app/ subfolder (Pinokio layout).
    for (const dir of [configured, path.join(configured, 'app')]) {
      if (looksLikeFluxGym(dir)) return { root: dir, autoDetected: false };
    }
    return { root: '', autoDetected: false };
  }
  const homes = [
    path.join(os.homedir(), 'pinokio'),
    path.join(os.homedir(), 'Documents', 'pinokio'),
    process.platform === 'win32' ? 'C:\\pinokio' : '',
    process.env.PINOKIO_HOME ?? '',
  ].filter(Boolean);
  const names = ['fluxgym.git', 'fluxgym'];
  for (const home of homes) {
    for (const name of names) {
      for (const dir of [
        path.join(home, 'api', name, 'app'),
        path.join(home, 'api', name),
      ]) {
        if (looksLikeFluxGym(dir)) return { root: dir, autoDetected: true };
      }
    }
  }
  // A plain git checkout next to ComfyUI is the other common setup.
  const comfy = db.getSettings().comfyLaunchPath;
  if (comfy) {
    const sibling = path.join(path.dirname(comfy), 'fluxgym');
    if (looksLikeFluxGym(sibling)) return { root: sibling, autoDetected: true };
  }
  return { root: '', autoDetected: false };
}

async function uiReachable(): Promise<boolean> {
  try {
    const res = await fetch(FLUXGYM_URL + '/config', { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getStatus(): Promise<FluxGymStatus> {
  const { root, autoDetected } = resolveRoot();
  const running = await uiReachable();
  return {
    installed: !!root,
    root,
    autoDetected,
    running,
    url: FLUXGYM_URL,
    processRunning: !!child && child.exitCode === null,
  };
}

// Multi-select image picker for training photos. Full paths never leave the
// main process; the renderer only gets small thumbnails to display.
export async function pickImages(win: BrowserWindow | null): Promise<TrainingImage[]> {
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openFile', 'multiSelections'],
    title: 'Choose 10–30 photos of this person',
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
  });
  if (result.canceled) return [];
  const picked: TrainingImage[] = [];
  for (const p of result.filePaths) {
    if (!IMAGE_EXTS.has(path.extname(p).toLowerCase())) continue;
    let thumb = '';
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) thumb = img.resize({ height: 160 }).toDataURL();
    } catch {
      /* unreadable image — keep it listed without a preview */
    }
    picked.push({ path: p, name: path.basename(p), thumb });
  }
  return picked;
}

// Build the training dataset FluxGym expects: datasets/<slug>/ holding the
// photos plus one .txt caption per photo containing the trigger word. The
// images are re-encoded to png via nativeImage when possible so odd formats
// or EXIF rotation don't derail training.
export function prepareDataset(
  slug: string,
  triggerWord: string,
  imagePaths: string[]
): { dir: string; count: number } {
  const { root } = resolveRoot();
  if (!root) throw new Error('FluxGym folder not found — set it in Settings → LoRA training.');
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(slug)) throw new Error(`Invalid dataset name "${slug}".`);
  const dir = path.join(root, 'datasets', slug);
  fs.mkdirSync(dir, { recursive: true });
  // Start clean so a retried wizard doesn't mix two photo sets.
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });

  let n = 0;
  for (const src of imagePaths) {
    if (!fs.existsSync(src)) continue;
    n++;
    const base = `${slug}_${String(n).padStart(2, '0')}`;
    const img = nativeImage.createFromPath(src);
    if (!img.isEmpty()) {
      fs.writeFileSync(path.join(dir, `${base}.png`), img.toPNG());
    } else {
      fs.copyFileSync(src, path.join(dir, base + path.extname(src).toLowerCase()));
    }
    fs.writeFileSync(path.join(dir, `${base}.txt`), `${triggerWord}\n`, 'utf-8');
  }
  if (n === 0) throw new Error('None of the selected photos could be read.');
  return { dir, count: n };
}

function outputsDir(root: string, slug: string): string {
  return path.join(root, 'outputs', slug);
}

// Poll for training progress. `started` = FluxGym created its output folder
// for this run (it writes the train script there the moment the user presses
// Start), which is how WICKED tells "waiting for the user" from "actually
// training". Then kohya sd-scripts drops intermediate epoch files like
// <slug>-000004.safetensors and finally <slug>.safetensors.
export function checkTraining(slug: string): TrainingCheck {
  const { root } = resolveRoot();
  const none: TrainingCheck = { started: false, done: false, loraFile: '', checkpoints: 0 };
  if (!root) return none;
  const dir = outputsDir(root, slug);
  if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) return none;
  let checkpoints = 0;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(`${slug}-`) && f.endsWith('.safetensors')) checkpoints++;
  }
  const finalFile = path.join(dir, `${slug}.safetensors`);
  if (fs.existsSync(finalFile)) {
    const stat = fs.statSync(finalFile);
    if (Date.now() - stat.mtimeMs > SETTLE_MS && stat.size > 0) {
      return { started: true, done: true, loraFile: finalFile, checkpoints };
    }
  }
  return { started: true, done: false, loraFile: '', checkpoints };
}

// Where ComfyUI keeps LoRAs, derived from the configured launch folder
// (portable build nests a ComfyUI/ folder; a git checkout doesn't).
function comfyLorasDir(): string {
  const launch = db.getSettings().comfyLaunchPath;
  if (!launch) {
    throw new Error(
      'Set your ComfyUI folder in Settings → Local images first, so WICKED knows where to install the LoRA.'
    );
  }
  for (const dir of [
    path.join(launch, 'ComfyUI', 'models', 'loras'),
    path.join(launch, 'models', 'loras'),
  ]) {
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(`Couldn't find a models\\loras folder under ${launch}.`);
}

// Copy the finished LoRA into ComfyUI. Returns the filename ComfyUI will list
// (its filename cache notices new files on the next /object_info fetch).
export function installLora(slug: string): string {
  const check = checkTraining(slug);
  if (!check.done) throw new Error(`Training for "${slug}" hasn't produced a final LoRA yet.`);
  const dest = comfyLorasDir();
  const filename = path.basename(check.loraFile);
  fs.copyFileSync(check.loraFile, path.join(dest, filename));
  return filename;
}

// Start FluxGym in the background using the Python environment Pinokio (or a
// manual install) created next to app.py. Falls back to a clear message when
// we can't, so the UI can tell the user to start it from Pinokio instead.
export async function launch(): Promise<{ started: boolean; message: string }> {
  if (await uiReachable()) return { started: false, message: 'FluxGym is already running.' };
  if (child && child.exitCode === null) {
    return { started: false, message: 'FluxGym is starting — give it a moment.' };
  }
  const { root } = resolveRoot();
  if (!root) {
    return {
      started: false,
      message: 'FluxGym not found. Install it with Pinokio, or set its folder in Settings.',
    };
  }
  const python =
    process.platform === 'win32'
      ? path.join(root, 'env', 'Scripts', 'python.exe')
      : path.join(root, 'env', 'bin', 'python');
  if (!fs.existsSync(python)) {
    return {
      started: false,
      message:
        "Couldn't find FluxGym's Python environment — start FluxGym from Pinokio, then come back here.",
    };
  }
  const proc = spawn(python, ['app.py'], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, GRADIO_SERVER_NAME: '127.0.0.1' },
  });
  proc.on('exit', () => {
    if (child === proc) child = null;
  });
  proc.on('error', () => {
    if (child === proc) child = null;
  });
  child = proc;
  return { started: true, message: 'Starting FluxGym in the background (first start takes a minute)…' };
}

export function stop(): void {
  const proc = child;
  child = null;
  if (!proc || proc.exitCode !== null || !proc.pid) return;
  // Never take a live training run down with the app (quit, update, crash
  // recovery): losing hours of progress is far worse than leaving FluxGym
  // running in the background. If any prepared dataset has a started-but-
  // unfinished run, orphan the process instead — it keeps training, and
  // WICKED picks the result up on next launch.
  try {
    const { root } = resolveRoot();
    const datasetsDir = root ? path.join(root, 'datasets') : '';
    const slugs =
      datasetsDir && fs.existsSync(datasetsDir)
        ? fs
            .readdirSync(datasetsDir)
            .filter((n) => fs.statSync(path.join(datasetsDir, n)).isDirectory())
        : [];
    const trainingActive = slugs.some((slug) => {
      const check = checkTraining(slug);
      return check.started && !check.done;
    });
    if (trainingActive) return;
  } catch {
    /* if the check itself fails, fall through and stop the process */
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      proc.kill();
    }
  } else {
    proc.kill('SIGTERM');
  }
}

export function openUi(): void {
  void shell.openExternal(FLUXGYM_URL);
}

export function openDataset(slug: string): void {
  const { root } = resolveRoot();
  if (!root) return;
  const dir = path.join(root, 'datasets', slug);
  if (fs.existsSync(dir)) void shell.openPath(dir);
  else void shell.openPath(root);
}
