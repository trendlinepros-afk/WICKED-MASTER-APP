import { useCallback, useEffect, useRef, useState } from 'react';
import { getAudioContext, pickRecordingMime } from '../lib/voice';

// Microphone capture with lightweight voice-activity detection: calibrates the
// noise floor for the first 400ms, requires ~150ms of sustained speech before
// arming, then auto-stops after `silenceMs` of continuous quiet. Never
// auto-stops before any speech was heard — so it won't cut off slow starters.

export type RecorderState = 'idle' | 'recording' | 'transcribing';

export interface RecordingResult {
  blob: Blob;
  mime: string;
  durationMs: number;
}

interface StartOpts {
  stream?: MediaStream; // call mode passes a long-lived stream it owns
  silenceMs?: number;
  maxMs?: number;
  onAutoStop?: () => void;
}

const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
};

export async function getMicStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'Microphone unavailable. On another device, open the https:// portal link (Settings → Web portal).'
    );
  }
  return navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
}

export function useVoiceRecorder() {
  const [state, setState] = useState<RecorderState>('idle');
  const [level, setLevel] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const ownedStreamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const vadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const hadSpeechRef = useRef(false);
  const mimeRef = useRef('');
  const stopResolveRef = useRef<((r: RecordingResult | null) => void) | null>(null);

  const teardown = useCallback(() => {
    if (vadTimerRef.current) clearInterval(vadTimerRef.current);
    vadTimerRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    ownedStreamRef.current?.getTracks().forEach((t) => t.stop());
    ownedStreamRef.current = null;
    recorderRef.current = null;
    setLevel(0);
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const start = useCallback(
    async (opts: StartOpts = {}) => {
      if (recorderRef.current) return;
      const silenceMs = opts.silenceMs ?? 1400;
      const maxMs = opts.maxMs ?? 30_000;

      let stream = opts.stream ?? null;
      if (!stream) {
        stream = await getMicStream();
        ownedStreamRef.current = stream;
      }

      const { mime } = pickRecordingMime();
      const recorder = new MediaRecorder(
        stream,
        mime ? { mimeType: mime, audioBitsPerSecond: 32_000 } : { audioBitsPerSecond: 32_000 }
      );
      mimeRef.current = mime || recorder.mimeType || 'audio/webm';
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const durationMs = Date.now() - startedAtRef.current;
        const resolve = stopResolveRef.current;
        stopResolveRef.current = null;
        const blob = new Blob(chunksRef.current, { type: mimeRef.current.split(';')[0] });
        chunksRef.current = [];
        // Discard obvious non-speech: prevents transcription hallucinating
        // ("Thank you.") on silence, and wasted round-trips.
        const ok = hadSpeechRef.current && durationMs >= 400 && blob.size >= 2000;
        resolve?.(ok ? { blob, mime: mimeRef.current, durationMs } : null);
      };

      // Voice-activity detection on a parallel WebAudio tap.
      const ctx = getAudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      sourceRef.current = source;

      const samples = new Float32Array(analyser.fftSize);
      const floor: number[] = [];
      let threshold = 0.02;
      let loudStreak = 0;
      let silentMs = 0;
      hadSpeechRef.current = false;
      startedAtRef.current = Date.now();

      vadTimerRef.current = setInterval(() => {
        const rec = recorderRef.current;
        if (!rec || rec.state !== 'recording') return;
        // Muted (call mode): don't count silence against the speaker.
        if (stream!.getAudioTracks().some((t) => !t.enabled)) {
          silentMs = 0;
          setLevel(0);
          return;
        }
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / samples.length);
        setLevel(Math.min(1, rms * 12));

        const elapsed = Date.now() - startedAtRef.current;
        if (elapsed < 400) {
          floor.push(rms);
          return; // calibration window
        }
        if (floor.length > 0) {
          const sorted = [...floor].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)];
          threshold = Math.min(0.08, Math.max(0.012, median * 3));
          floor.length = 0;
        }

        if (rms > threshold) {
          loudStreak++;
          if (loudStreak >= 3) hadSpeechRef.current = true;
          silentMs = 0;
        } else {
          loudStreak = 0;
          if (rms < threshold * 0.6) silentMs += 50;
        }

        const shouldStop =
          (hadSpeechRef.current && elapsed > 700 && silentMs >= silenceMs) || elapsed >= maxMs;
        if (shouldStop) {
          // One-shot: stop watching before notifying so this can't re-fire.
          if (vadTimerRef.current) clearInterval(vadTimerRef.current);
          vadTimerRef.current = null;
          opts.onAutoStop?.();
        }
      }, 50);

      recorderRef.current = recorder;
      recorder.start(250); // timeslice: Safari is unreliable with a single final chunk
      setState('recording');
    },
    []
  );

  // Stops recording and resolves with the audio (or null if discarded).
  const stop = useCallback((): Promise<RecordingResult | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      teardown();
      setState('idle');
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      stopResolveRef.current = (r) => {
        teardown();
        resolve(r);
      };
      setState('transcribing');
      recorder.stop();
    });
  }, [teardown]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    stopResolveRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      recorder.stop();
    }
    teardown();
    setState('idle');
  }, [teardown]);

  return { state, setState, level, start, stop, cancel };
}
