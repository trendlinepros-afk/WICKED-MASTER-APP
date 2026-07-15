import { randomUUID } from 'node:crypto';
import * as db from './db';
import * as launcher from './comfyLauncher';
import type { ComfyModels, ComfyStatus } from '../types';

// Client for a locally-running ComfyUI instance (the user installs and runs
// it themselves — see the setup guide). Lives in the main process so it works
// identically from the desktop renderer and the web portal, with no CORS/CSP
// involvement. WICKED only submits prompts and fetches results; models,
// LoRAs, and workflow behavior are entirely the user's ComfyUI configuration.

function base(): string {
  return (db.getSettings().comfyUrl || 'http://127.0.0.1:8188').replace(/\/$/, '');
}

async function jget<T>(path: string, timeoutMs = 8000): Promise<T> {
  const res = await fetch(base() + path, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`ComfyUI ${path} returned ${res.status}`);
  return (await res.json()) as T;
}

interface SystemStats {
  devices?: { name?: string; vram_total?: number; vram_free?: number }[];
}

export async function getStatus(): Promise<ComfyStatus> {
  const proc = launcher.getProcessState();
  try {
    const stats = await jget<SystemStats>('/system_stats', 4000);
    const dev = stats.devices?.[0] ?? {};
    return {
      reachable: true,
      deviceName: dev.name ?? '',
      vramTotal: dev.vram_total ?? 0,
      vramFree: dev.vram_free ?? 0,
      managed: proc.managed,
      processRunning: proc.processRunning,
    };
  } catch (err) {
    return {
      reachable: false,
      deviceName: '',
      vramTotal: 0,
      vramFree: 0,
      managed: proc.managed,
      processRunning: proc.processRunning,
      lastLog: proc.lastLog || undefined,
      error: (err as Error).message,
    };
  }
}

type ObjectInfo = Record<
  string,
  { input?: { required?: Record<string, unknown[]> } }
>;

async function inputOptions(nodeType: string, field: string): Promise<string[]> {
  try {
    const info = await jget<ObjectInfo>(`/object_info/${nodeType}`);
    const options = info?.[nodeType]?.input?.required?.[field]?.[0];
    return Array.isArray(options) ? (options as string[]) : [];
  } catch {
    return [];
  }
}

export async function listModels(): Promise<ComfyModels> {
  const [checkpoints, loras] = await Promise.all([
    inputOptions('CheckpointLoaderSimple', 'ckpt_name'),
    inputOptions('LoraLoaderModelOnly', 'lora_name'),
  ]);
  return { checkpoints, loras };
}

export async function freeVram(): Promise<void> {
  const res = await fetch(base() + '/free', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ComfyUI /free returned ${res.status}`);
}

// A tiny 1-step render forces the checkpoint into VRAM so the first real
// generation isn't slow. The output is discarded.
export async function loadModel(): Promise<void> {
  await generate({ prompt: 'warm up', width: 256, height: 256, steps: 1 });
}

export interface GenerateOpts {
  prompt: string;
  loraName?: string;
  loraStrength?: number;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
}

// Each checkpoint family needs very different sampling settings — running an
// SDXL/SD1.5 checkpoint with Flux's cfg=1/no-negative setup is the classic
// cause of melted, broken people. Detect the family from the filename and
// build the right graph automatically so the user never tunes samplers.
type ModelFamily = 'flux' | 'sdxl';

// The Settings override wins; otherwise guess from the filename. A wrong
// guess (e.g. a Flux fp8 build not named "flux") drives Flux at CFG 6.5,
// which is precisely what produces extra limbs — hence the explicit setting.
function familyOf(checkpoint: string): ModelFamily {
  const override = db.getSettings().comfyModelFamily;
  if (override === 'flux' || override === 'sdxl') return override;
  return /flux/i.test(checkpoint) ? 'flux' : 'sdxl';
}

// Steps used when the caller doesn't ask for a specific count. Flux Schnell
// is a 4-step distilled model — running it at 20 wastes time and degrades
// the output.
export function defaultSteps(checkpoint: string): number {
  if (familyOf(checkpoint) !== 'flux') return 28;
  return /schnell/i.test(checkpoint) ? 4 : 20;
}

const SDXL_NEGATIVE =
  'lowres, bad anatomy, bad hands, extra fingers, missing fingers, extra limbs, deformed, ' +
  'disfigured, mutated, blurry, worst quality, low quality, jpeg artifacts, watermark, text';

function defaultWorkflow(o: Required<Omit<GenerateOpts, 'loraName' | 'loraStrength'>> & {
  loraName: string;
  loraStrength: number;
  checkpoint: string;
}): Record<string, unknown> {
  const family = familyOf(o.checkpoint);
  const useLora = !!o.loraName;
  const modelSource: [string, number] = useLora ? ['lora', 0] : ['ckpt', 0];
  // SDXL-family LoRAs also patch the text encoder, so their prompts route
  // through the LoRA's CLIP output; Flux LoRAs are model-only.
  const clipSource: [string, number] = useLora && family === 'sdxl' ? ['lora', 1] : ['ckpt', 1];
  const graph: Record<string, unknown> = {
    ckpt: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: o.checkpoint } },
    pos: { class_type: 'CLIPTextEncode', inputs: { text: o.prompt, clip: clipSource } },
    neg: {
      class_type: 'CLIPTextEncode',
      inputs: { text: family === 'flux' ? '' : SDXL_NEGATIVE, clip: clipSource },
    },
    latent: {
      class_type: family === 'flux' ? 'EmptySD3LatentImage' : 'EmptyLatentImage',
      inputs: { width: o.width, height: o.height, batch_size: 1 },
    },
    sampler: {
      class_type: 'KSampler',
      inputs: {
        model: modelSource,
        positive: ['pos', 0],
        negative: ['neg', 0],
        latent_image: ['latent', 0],
        seed: o.seed,
        steps: o.steps,
        // Flux uses embedded guidance (cfg must stay 1); SDXL needs real CFG.
        cfg: family === 'flux' ? 1 : 6.5,
        sampler_name: family === 'flux' ? 'euler' : 'dpmpp_2m',
        scheduler: family === 'flux' ? 'simple' : 'karras',
        denoise: 1,
      },
    },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: ['ckpt', 2] } },
    save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'WICKED' } },
  };
  if (useLora) {
    graph.lora =
      family === 'flux'
        ? {
            class_type: 'LoraLoaderModelOnly',
            inputs: { lora_name: o.loraName, strength_model: o.loraStrength, model: ['ckpt', 0] },
          }
        : {
            class_type: 'LoraLoader',
            inputs: {
              lora_name: o.loraName,
              strength_model: o.loraStrength,
              strength_clip: o.loraStrength,
              model: ['ckpt', 0],
              clip: ['ckpt', 1],
            },
          };
  }
  return graph;
}

// Substitute {{PROMPT}} / {{SEED}} placeholders in a user-supplied workflow
// (exported from ComfyUI in API format).
function fillCustomWorkflow(json: string, prompt: string, seed: number): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (v === '{{SEED}}') return seed;
      return v.replace(/\{\{PROMPT\}\}/g, prompt).replace(/\{\{SEED\}\}/g, String(seed));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(JSON.parse(json)) as Record<string, unknown>;
}

export async function generate(opts: GenerateOpts): Promise<{ image: string; seed: number }> {
  const settings = db.getSettings();
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 48);

  let workflow: Record<string, unknown>;
  if (settings.comfyWorkflow.trim()) {
    workflow = fillCustomWorkflow(settings.comfyWorkflow, opts.prompt, seed);
  } else {
    if (!settings.comfyCheckpoint) {
      throw new Error('Pick a checkpoint in Settings → Local images first.');
    }
    workflow = defaultWorkflow({
      prompt: opts.prompt,
      width: opts.width ?? 1024,
      height: opts.height ?? 1024,
      steps: opts.steps ?? defaultSteps(settings.comfyCheckpoint),
      seed,
      loraName: opts.loraName ?? '',
      loraStrength: opts.loraStrength ?? 0.85,
      checkpoint: settings.comfyCheckpoint,
    });
  }

  const submit = await fetch(base() + '/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!submit.ok) {
    const detail = await submit.text().catch(() => '');
    throw new Error(`ComfyUI rejected the workflow (${submit.status}): ${detail.slice(0, 300)}`);
  }
  const { prompt_id: promptId } = (await submit.json()) as { prompt_id: string };

  // Poll history until the job produces an image (Flux runs take a while).
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    type HistoryEntry = {
      status?: { status_str?: string; completed?: boolean };
      outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }>;
    };
    const history = await jget<Record<string, HistoryEntry>>(`/history/${promptId}`, 10_000);
    const entry = history?.[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') {
      throw new Error('Generation failed inside ComfyUI — check its console window.');
    }
    for (const output of Object.values(entry.outputs ?? {})) {
      const img = output.images?.find((i) => (i.type ?? 'output') === 'output');
      if (!img) continue;
      const view = await fetch(
        `${base()}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(
          img.subfolder ?? ''
        )}&type=${encodeURIComponent(img.type ?? 'output')}`,
        { signal: AbortSignal.timeout(30_000) }
      );
      if (!view.ok) throw new Error(`ComfyUI /view returned ${view.status}`);
      const buffer = Buffer.from(await view.arrayBuffer());
      return { image: `data:image/png;base64,${buffer.toString('base64')}`, seed };
    }
  }
  throw new Error('Timed out waiting for ComfyUI (10 minutes).');
}
