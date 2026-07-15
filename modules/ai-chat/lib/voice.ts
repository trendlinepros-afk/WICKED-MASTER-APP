import type { Settings } from '../types';
import { api } from './bridge';

// Core audio plumbing for the voice features (dictation, call mode,
// read-aloud). Port note: the OpenAI STT/TTS requests moved to the main
// process (ipc/providers.ts) so the API key never reaches the renderer — this
// file keeps the recording/playback plumbing and calls over IPC. The
// `settings` parameters are kept for call-site compatibility; the models and
// voice defaults are read from the module's saved settings in the main
// process.
//
// Playback uses ONE shared <audio> element for the whole app: iOS Safari only
// allows programmatic .play() on an element that was activated by a user
// gesture, and (unlike WebAudio) HTMLMediaElement output ignores the hardware
// ring/silent switch — which is what you want for a phone call. Every voice
// button calls unlockAudio() synchronously in its click handler.

export const TTS_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
];

// A tiny silent WAV used to "activate" the shared element inside a gesture.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

let sharedAudio: HTMLAudioElement | null = null;
let audioCtx: AudioContext | null = null;
let unlocked = false;

export function getSharedAudio(): HTMLAudioElement {
  if (!sharedAudio) {
    sharedAudio = new Audio();
    sharedAudio.setAttribute('playsinline', 'true');
  }
  return sharedAudio;
}

export function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

// Must be called synchronously from a click/tap handler (before any await).
export function unlockAudio(): void {
  try {
    void getAudioContext().resume();
  } catch {
    // AudioContext may be unavailable in odd embeds; VAD will fail loudly later.
  }
  if (unlocked) return;
  const audio = getSharedAudio();
  audio.src = SILENT_WAV;
  const p = audio.play();
  if (p) p.then(() => audio.pause()).catch(() => {});
  unlocked = true;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// ---------- Speech-to-text ----------

// Pick a recording format the current browser supports. OpenAI validates by
// file extension, so the two travel together.
export function pickRecordingMime(): { mime: string; ext: string } {
  const candidates: [string, string][] = [
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/ogg;codecs=opus', 'ogg'],
    ['audio/mp4;codecs=mp4a.40.2', 'mp4'], // Safari / iOS
    ['audio/mp4', 'mp4'],
  ];
  for (const [mime, ext] of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
      return { mime, ext };
    }
  }
  return { mime: '', ext: 'webm' }; // let MediaRecorder pick; webm is the common default
}

export async function transcribe(blob: Blob, mime: string, _settings: Settings): Promise<string> {
  const baseMime = (mime || blob.type || 'audio/webm').split(';')[0];
  const base64 = await blobToBase64(blob);
  return (await api.voiceTranscribe(base64, baseMime)).trim();
}

// ---------- Text preparation ----------

// Return the sentences of text[from..] whose terminator is already followed by
// whitespace (i.e. definitely complete), plus the index consumed up to. The
// trailing in-progress fragment is never emitted.
export function splitCompleteSentences(
  text: string,
  from: number
): { sentences: string[]; end: number } {
  const slice = text.slice(from);
  const re = /([.!?…]+["')\]]*)(\s+)|(\n+)/g;
  const sentences: string[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    const sentence = slice.slice(cursor, m.index + (m[1]?.length ?? 0)).trim();
    if (sentence) sentences.push(sentence);
    cursor = m.index + m[0].length;
  }
  return { sentences, end: from + cursor };
}

export function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// Make markdown listenable: drop syntax, replace code blocks, strip links to
// their labels. Not perfect — just good enough for TTS.
export function stripForSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' Code omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' image ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Status lines the tool loop injects into the stream — not for speaking.
export function isToolStatus(s: string): boolean {
  return /🛠️\s*Running \d+ tool call/u.test(s);
}

// ---------- Text-to-speech queue ----------

// One app-wide queue: sentences go in, speech comes out in order. The first
// chunk is requested immediately (latency); while one chunk plays the next is
// prefetched; short pending sentences are coalesced into ~180-char requests
// (smoother prosody, fewer round-trips). Any new consumer calls stop() first,
// so only one thing ever speaks.
const COALESCE_CHARS = 180;

class TtsQueue {
  private pending: { text: string; voice: string }[] = [];
  private fetched: { url: string } | null = null;
  private fetching = false;
  private playing = false;
  private aborts = new Set<AbortController>();
  private drainResolvers: (() => void)[] = [];
  private listeners = new Set<(speaking: boolean) => void>();

  // Who started the current speech (e.g. a specific SpeakButton) — lets UI
  // show ■ Stop only on the button that owns the audio.
  owner: unknown = null;

  // Subscribe to speaking-state changes; returns an unsubscribe function.
  onChange(listener: (speaking: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get speaking(): boolean {
    return this.playing || this.fetching || this.pending.length > 0 || !!this.fetched;
  }

  // voice '' = the saved settings voice; callers may pass an override.
  enqueue(text: string, _settings: Settings, voice = ''): void {
    const t = text.trim();
    if (!t) return;
    this.pending.push({ text: t, voice });
    void this.pump();
  }

  stop(): void {
    this.pending = [];
    for (const a of this.aborts) a.abort();
    this.aborts.clear();
    if (this.fetched) {
      URL.revokeObjectURL(this.fetched.url);
      this.fetched = null;
    }
    const audio = getSharedAudio();
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    this.playing = false;
    this.fetching = false;
    this.settle();
  }

  // Resolves once everything enqueued so far has finished playing.
  drained(): Promise<void> {
    if (!this.speaking) return Promise.resolve();
    return new Promise((resolve) => this.drainResolvers.push(resolve));
  }

  private settle(): void {
    for (const l of this.listeners) l(this.speaking);
    if (!this.speaking) {
      const resolvers = this.drainResolvers;
      this.drainResolvers = [];
      for (const r of resolvers) r();
    }
  }

  // Pull the next ~COALESCE_CHARS worth of pending sentences as one request —
  // but never merge across a voice change (each speaker keeps their voice).
  private takeChunk(): { text: string; voice: string } {
    const first = this.pending.shift() ?? { text: '', voice: '' };
    let chunk = first.text;
    while (
      this.pending.length > 0 &&
      this.pending[0].voice === first.voice &&
      chunk.length + this.pending[0].text.length + 1 < COALESCE_CHARS
    ) {
      chunk += ' ' + this.pending.shift()!.text;
    }
    return { text: chunk, voice: first.voice };
  }

  private async pump(): Promise<void> {
    if (this.fetching || this.fetched || this.pending.length === 0) {
      this.settle();
      return;
    }
    const chunk = this.takeChunk();
    this.fetching = true;
    this.settle();
    // The IPC request itself can't be cancelled mid-flight, but an abort makes
    // the result be dropped — same effective behavior as the old fetch abort.
    const abort = new AbortController();
    this.aborts.add(abort);
    try {
      const base64 = await api.voiceSpeak(chunk.text, chunk.voice);
      if (!abort.signal.aborted) {
        const blob = base64ToBlob(base64, 'audio/mpeg');
        this.fetched = { url: URL.createObjectURL(blob) };
      }
    } catch (err) {
      if (!abort.signal.aborted) console.warn('[tts]', (err as Error).message);
      // Drop the chunk and keep going — one failed sentence shouldn't kill the call.
    } finally {
      this.aborts.delete(abort);
      this.fetching = false;
    }
    if (!this.playing) this.playNext();
    else this.settle();
  }

  private playNext(): void {
    const item = this.fetched;
    this.fetched = null;
    if (!item) {
      this.playing = false;
      this.settle();
      // A fetch may have failed while another sentence is still pending.
      if (this.pending.length > 0) void this.pump();
      return;
    }
    this.playing = true;
    this.settle();
    const audio = getSharedAudio();
    audio.src = item.url;
    const done = () => {
      URL.revokeObjectURL(item.url);
      audio.onended = null;
      audio.onerror = null;
      this.playing = false;
      this.playNext();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
    // Prefetch the next chunk while this one plays.
    void this.pump();
  }
}

let queue: TtsQueue | null = null;

export function getTtsQueue(): TtsQueue {
  if (!queue) queue = new TtsQueue();
  return queue;
}

// Read a whole message aloud (used by SpeakButton): stops whatever else is
// playing, then queues this text in sentence chunks.
export function speakText(text: string, settings: Settings, owner?: unknown): void {
  const q = getTtsQueue();
  q.stop();
  q.owner = owner ?? null;
  speakAppendText(text, settings);
}

// Queue more speech WITHOUT interrupting what's already playing — appended
// text is read in arrival order after everything already queued.
export function speakAppendText(text: string, settings: Settings): void {
  const q = getTtsQueue();
  const clean = stripForSpeech(text);
  if (!clean) return;
  const { sentences, end } = splitCompleteSentences(clean + ' ', 0);
  for (const s of sentences) q.enqueue(s, settings);
  const tail = (clean + ' ').slice(end).trim();
  if (tail) q.enqueue(tail, settings);
}
