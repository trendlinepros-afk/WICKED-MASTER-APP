import { useEffect, useRef, useState } from 'react';
import type { Chat } from '../../types';
import { useChatStore } from '../../store/chatStore';
import { useStreamStore, abortCurrentStream } from '../../store/streamStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useUIStore } from '../../store/uiStore';
import { useSend } from '../../hooks/useSend';
import { getMicStream, useVoiceRecorder } from '../../hooks/useVoiceRecorder';
import {
  commonPrefixLen,
  getTtsQueue,
  isToolStatus,
  splitCompleteSentences,
  stripForSpeech,
  transcribe,
} from '../../lib/voice';

type Phase = 'connecting' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'ended';

const PHASE_LABEL: Record<Phase, string> = {
  connecting: 'Connecting…',
  listening: 'Listening — just talk',
  transcribing: 'Got it…',
  thinking: 'Thinking…',
  speaking: 'Speaking — tap to interrupt',
  ended: 'Call ended',
};

// A phone-call experience with the current chat: listen → transcribe → send
// through the normal pipeline (every turn is persisted like a typed message,
// so memory features see the whole call) → speak the reply sentence-by-
// sentence while it streams → listen again.
export function CallOverlay({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const { send } = useSend();
  const settings = useSettingsStore((s) => s.settings);
  const toast = useUIStore((s) => s.toast);
  const recorder = useVoiceRecorder();

  const [phase, setPhase] = useState<Phase>('connecting');
  const [heard, setHeard] = useState(''); // last transcription, shown on screen
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);

  // Refs the async loop reads on every iteration.
  const activeRef = useRef(true);
  const interruptedRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Call duration ticker.
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // End the call if the user switches chats underneath us.
  const activeChatId = useChatStore((s) => s.activeChatId);
  useEffect(() => {
    if (activeChatId !== chat.id) onClose();
  }, [activeChatId, chat.id, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The call loop. Runs once; every await checks activeRef before continuing.
  useEffect(() => {
    const queue = getTtsQueue();
    queue.stop(); // we own the speaker for the duration of the call
    queue.owner = null;

    const waitForStreamIdle = () =>
      new Promise<void>((resolve) => {
        if (!useStreamStore.getState().isStreaming) return resolve();
        const unsub = useStreamStore.subscribe((s) => {
          if (!s.isStreaming) {
            unsub();
            resolve();
          }
        });
      });

    const lastAssistantText = (): string => {
      const messages = useChatStore.getState().messages;
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant') return '';
      return last.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('\n');
    };

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const run = async () => {
      try {
        streamRef.current = await getMicStream();
      } catch (err) {
        toast((err as Error).message, 'error');
        onClose();
        return;
      }

      while (activeRef.current) {
        // ---- Listen ----
        setPhase('listening');
        let autoStopped: (() => void) | null = null;
        const autoStop = new Promise<void>((r) => (autoStopped = r));
        await recorderRef.current.start({
          stream: streamRef.current!,
          silenceMs: 1400,
          maxMs: 90_000,
          onAutoStop: () => autoStopped?.(),
        });
        await autoStop;
        if (!activeRef.current) return;

        // ---- Transcribe ----
        setPhase('transcribing');
        const result = await recorderRef.current.stop();
        recorderRef.current.setState('idle');
        if (!activeRef.current) return;
        if (!result) continue; // silence/noise — just listen again
        let spoken = '';
        try {
          spoken = await transcribe(result.blob, result.mime, settingsRef.current);
        } catch (err) {
          toast((err as Error).message, 'error');
          continue;
        }
        if (!activeRef.current) return;
        if (!spoken) continue;
        setHeard(spoken);

        // ---- Send through the normal pipeline & speak the streaming reply ----
        setPhase('thinking');
        await waitForStreamIdle(); // never overlap streams (beginStream aborts!)
        if (!activeRef.current) return;

        interruptedRef.current = false;
        let consumed = 0;
        let lastSeen = '';
        let sawReply = false;
        const tick = () => {
          if (interruptedRef.current || !activeRef.current) return;
          const text = lastAssistantText();
          if (!text) return;
          if (!text.startsWith(lastSeen)) {
            // Tool-loop status lines can replace/shrink the text — resync.
            consumed = Math.min(consumed, commonPrefixLen(text, lastSeen));
          }
          lastSeen = text;
          const { sentences, end } = splitCompleteSentences(text, consumed);
          for (const s of sentences) {
            if (isToolStatus(s)) continue;
            const clean = stripForSpeech(s);
            if (clean) {
              queue.enqueue(clean, settingsRef.current);
              sawReply = true;
              setPhase('speaking');
            }
          }
          consumed = end;
        };
        const unsub = useChatStore.subscribe(tick);

        try {
          await send(chat, [{ type: 'text', text: spoken }]);
        } catch {
          // streamReply already toasts and persists what it can.
        }
        unsub();
        if (!activeRef.current) return;

        // Image-offer path: send() returns without any assistant reply.
        if (useChatStore.getState().pendingImageOffer[chat.id]) {
          queue.enqueue(
            'I can generate that image — tap Yes in the chat to confirm.',
            settingsRef.current
          );
          sawReply = true;
        } else if (!interruptedRef.current) {
          // Flush the tail: final sentence usually has no trailing whitespace.
          tick();
          const text = lastAssistantText();
          const tail = stripForSpeech(text.slice(consumed));
          if (tail && !isToolStatus(tail)) {
            queue.enqueue(tail, settingsRef.current);
            sawReply = true;
          }
        }

        if (sawReply) setPhase('speaking');
        await queue.drained();
        if (!activeRef.current) return;

        // Brief settle so speaker tail/reverb doesn't count as user speech.
        if (interruptedRef.current || sawReply) await sleep(300);
      }
    };

    void run();

    return () => {
      activeRef.current = false;
      recorderRef.current.cancel();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      queue.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tap anywhere on the call screen while it's speaking/thinking → interrupt
  // and go straight back to listening (like talking over someone).
  const bargeIn = () => {
    if (phase !== 'speaking' && phase !== 'thinking') return;
    interruptedRef.current = true;
    getTtsQueue().stop();
    abortCurrentStream();
  };

  const toggleMute = () => {
    const stream = streamRef.current;
    if (!stream) return;
    const next = !muted;
    for (const track of stream.getAudioTracks()) track.enabled = !next;
    setMuted(next);
  };

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-between bg-bg/95 py-10 backdrop-blur"
      onClick={bargeIn}
    >
      <div className="text-center">
        <div className="text-sm text-muted">Voice call · {mmss}</div>
        <h2 className="mt-1 max-w-[80vw] truncate text-lg font-semibold">{chat.title}</h2>
      </div>

      {/* The "orb": phase indicator + live mic level */}
      <div className="flex flex-col items-center gap-6">
        <div
          className={`flex h-40 w-40 items-center justify-center rounded-full border-4 text-6xl transition-all ${
            phase === 'listening'
              ? 'border-green-500/70'
              : phase === 'speaking'
                ? 'animate-pulse border-accent'
                : 'border-edge'
          }`}
          style={
            phase === 'listening'
              ? { boxShadow: `0 0 0 ${Math.round(recorder.level * 40)}px rgba(34,197,94,0.15)` }
              : undefined
          }
        >
          {phase === 'listening' ? '🎙' : phase === 'speaking' ? '🔊' : phase === 'ended' ? '📴' : '💭'}
        </div>
        <div className="text-sm font-medium text-ink">{PHASE_LABEL[phase]}</div>
        {heard && (
          <div className="max-w-md px-6 text-center text-sm text-muted">“{heard}”</div>
        )}
      </div>

      <div className="flex items-center gap-4" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={toggleMute}
          className={`flex h-14 w-14 items-center justify-center rounded-full border text-xl ${
            muted ? 'border-amber-500 bg-amber-500/20' : 'border-edge bg-raised hover:bg-raised'
          }`}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? '🔇' : '🎤'}
        </button>
        <button
          onClick={onClose}
          className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500 text-2xl text-white shadow-lg hover:bg-red-600"
          title="End call"
        >
          📵
        </button>
      </div>
    </div>
  );
}
