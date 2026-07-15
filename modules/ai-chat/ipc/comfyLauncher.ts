import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db';

// Manages ComfyUI as a background child of WICKED: launched hidden at app
// startup (when a launch path is configured), stopped on quit. Never
// double-launches — if ComfyUI is already reachable (user started their own),
// autoLaunch is a no-op. VRAM stays untouched until the user hits Load.

const LOG_KEEP = 50;

let child: ChildProcess | null = null;
const logRing: string[] = [];

function pushLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  logRing.push(trimmed);
  if (logRing.length > LOG_KEEP) logRing.splice(0, logRing.length - LOG_KEEP);
}

function pushChunk(chunk: Buffer): void {
  for (const line of chunk.toString('utf-8').split(/\r?\n/)) pushLine(line);
}

export function getProcessState(): {
  managed: boolean;
  processRunning: boolean;
  lastLog: string;
} {
  return {
    managed: !!db.getSettings().comfyLaunchPath,
    processRunning: !!child && child.exitCode === null,
    lastLog: logRing[logRing.length - 1] ?? '',
  };
}

function portFromUrl(url: string): number {
  try {
    return Number(new URL(url).port) || 8188;
  } catch {
    return 8188;
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/system_stats', {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Called at app startup. No-op unless a launch path is set and ComfyUI isn't
// already running.
export async function autoLaunch(): Promise<void> {
  const settings = db.getSettings();
  if (!settings.comfyLaunchPath) return;
  if (await reachable(settings.comfyUrl || 'http://127.0.0.1:8188')) return;
  launch();
}

export function launch(): void {
  if (child && child.exitCode === null) return; // already running under us
  const settings = db.getSettings();
  const target = settings.comfyLaunchPath;
  if (!target || !fs.existsSync(target)) {
    pushLine(`ComfyUI launch path not found: ${target}`);
    return;
  }
  const port = portFromUrl(settings.comfyUrl || '');
  logRing.length = 0;

  const stdio: ('ignore' | 'pipe')[] = ['ignore', 'pipe', 'pipe'];
  let proc: ChildProcess;
  const isDir = fs.statSync(target).isDirectory();
  const portablePython = path.join(
    target,
    'python_embeded',
    process.platform === 'win32' ? 'python.exe' : 'python'
  );

  if (isDir && fs.existsSync(portablePython)) {
    // Windows portable build: run its embedded python directly — no console
    // window, no browser auto-open, and kill() reaches the real process.
    proc = spawn(
      portablePython,
      ['-s', path.join('ComfyUI', 'main.py'), '--disable-auto-launch', '--port', String(port)],
      { cwd: target, windowsHide: true, stdio }
    );
  } else if (isDir && fs.existsSync(path.join(target, 'main.py'))) {
    // A plain ComfyUI checkout: use the system python on PATH.
    proc = spawn(
      process.platform === 'win32' ? 'python' : 'python3',
      ['main.py', '--disable-auto-launch', '--port', String(port)],
      { cwd: target, windowsHide: true, stdio }
    );
  } else if (/\.(bat|cmd)$/i.test(target)) {
    proc = spawn('cmd.exe', ['/c', target], {
      cwd: path.dirname(target),
      windowsHide: true,
      stdio,
    });
  } else {
    proc = spawn(target, [], { cwd: path.dirname(target), windowsHide: true, stdio });
  }

  proc.stdout?.on('data', pushChunk);
  proc.stderr?.on('data', pushChunk);
  proc.on('exit', (code) => {
    pushLine(`[ComfyUI exited with code ${code}]`);
    if (child === proc) child = null;
  });
  proc.on('error', (err) => {
    pushLine(`Launch failed: ${err.message}`);
    if (child === proc) child = null;
  });
  child = proc;
}

export function stop(): void {
  const proc = child;
  child = null;
  if (!proc || proc.exitCode !== null || !proc.pid) return;
  if (process.platform === 'win32') {
    // Tree-kill: a .bat wrapper spawns cmd → python; plain kill() would
    // orphan the python (and its VRAM). Harmless for direct spawns too.
    try {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      proc.kill();
    }
  } else {
    proc.kill('SIGTERM');
  }
}
