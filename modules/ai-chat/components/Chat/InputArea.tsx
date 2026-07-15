import { useRef, useState } from 'react';
import type { Chat, ContentPart } from '../../types';
import { useSend } from '../../hooks/useSend';
import { useSettingsStore } from '../../store/settingsStore';
import { useUIStore } from '../../store/uiStore';
import { useVoiceRecorder } from '../../hooks/useVoiceRecorder';
import { transcribe, unlockAudio } from '../../lib/voice';
import { AttachmentPreview } from './AttachmentPreview';
import { CallOverlay } from '../Call/CallOverlay';
import { api } from '../../lib/bridge';
import { useKeysStore } from '../../store/keysStore';

export function InputArea({ chat }: { chat: Chat }) {
  const { send, stop, isStreaming } = useSend();
  const settings = useSettingsStore((s) => s.settings);
  const hasOpenAIKey = useKeysStore((s) => s.status['openai'] === true);
  const toast = useUIStore((s) => s.toast);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ContentPart[]>([]);
  const [callOpen, setCallOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recorder = useVoiceRecorder();

  const autoResize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 8 * 24) + 'px';
  };

  const onPaste = (e: React.ClipboardEvent) => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          setAttachments((prev) => [
            ...prev,
            { type: 'image_url', image_url: { url: reader.result as string }, name: 'pasted-image' },
          ]);
        };
        reader.readAsDataURL(file);
      }
    }
  };

  const onAttach = async () => {
    const file = await api.openFileDialog();
    if (!file) return;
    if (file.mime.startsWith('image/')) {
      setAttachments((prev) => [
        ...prev,
        {
          type: 'image_url',
          image_url: { url: `data:${file.mime};base64,${file.data}` },
          name: file.name,
        },
      ]);
    } else {
      setAttachments((prev) => [
        ...prev,
        { type: 'file', name: file.name, mime: file.mime, data: file.data, text: file.text },
      ]);
    }
  };

  const doSend = () => {
    if (isStreaming) return;
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    const parts: ContentPart[] = [];
    if (trimmed) parts.push({ type: 'text', text: trimmed });
    parts.push(...attachments);
    setText('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    send(chat, parts);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Enter sends; Shift+Enter inserts a newline. Ignore IME composition.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      doSend();
    }
  };

  // One-shot dictation: tap to record, tap again (or ~1.4s of silence) to
  // stop; the transcription is appended to the input for review.
  const finishDictation = async () => {
    const result = await recorder.stop();
    if (!result) {
      recorder.setState('idle');
      return;
    }
    try {
      const spoken = await transcribe(result.blob, result.mime, settings);
      if (spoken) {
        setText((prev) => (prev ? `${prev} ${spoken}` : spoken));
        setTimeout(() => {
          autoResize();
          textareaRef.current?.focus();
        }, 0);
      }
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      recorder.setState('idle');
    }
  };

  const onMic = async () => {
    unlockAudio();
    if (recorder.state === 'recording') {
      void finishDictation();
      return;
    }
    if (recorder.state !== 'idle') return;
    if (!hasOpenAIKey) {
      toast('Voice input needs an OpenAI API key — set one in Settings → API Keys.', 'error');
      return;
    }
    try {
      await recorder.start({ silenceMs: 1400, maxMs: 30_000, onAutoStop: () => void finishDictation() });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <div className="border-t border-edge bg-surface px-4 py-3">
      <div className="mx-auto max-w-3xl">
        <AttachmentPreview
          attachments={attachments}
          onRemove={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
        />
        <div className="flex items-end gap-2 rounded-xl border border-edge bg-raised px-2 py-1.5 focus-within:border-accent/60">
          <button
            onClick={onAttach}
            title="Attach a file"
            className="px-2 py-2 text-muted hover:text-ink"
          >
            📎
          </button>
          <button
            onClick={() => void onMic()}
            title={
              recorder.state === 'recording'
                ? 'Stop and transcribe'
                : 'Dictate — tap, speak, and it types for you'
            }
            className={`relative px-2 py-2 ${
              recorder.state === 'recording'
                ? 'animate-pulse text-red-500'
                : 'text-muted hover:text-ink'
            }`}
          >
            {recorder.state === 'transcribing' ? '⏳' : recorder.state === 'recording' ? '🔴' : '🎤'}
            {recorder.state === 'recording' && (
              <span
                className="absolute bottom-0.5 left-1/2 h-0.5 -translate-x-1/2 rounded bg-red-500"
                style={{ width: `${Math.max(15, recorder.level * 100)}%` }}
              />
            )}
          </button>
          <button
            onClick={() => {
              unlockAudio();
              if (!hasOpenAIKey) {
                toast('Voice calls need an OpenAI API key — set one in Settings → API Keys.', 'error');
                return;
              }
              setCallOpen(true);
            }}
            title="Start a voice call with this chat"
            className="px-2 py-2 text-muted hover:text-ink"
          >
            📱
          </button>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              autoResize();
            }}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Message… (Enter to send, Shift+Enter for newline)"
            className="max-h-48 flex-1 resize-none bg-transparent py-2 text-sm text-ink outline-none placeholder:text-muted"
          />
          {isStreaming ? (
            <button
              onClick={stop}
              className="rounded-lg bg-red-500/80 px-3 py-2 text-sm font-medium text-white hover:bg-red-500"
            >
              ◼ Stop
            </button>
          ) : (
            <button
              onClick={doSend}
              disabled={!text.trim() && attachments.length === 0}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent/90 disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </div>
      {callOpen && <CallOverlay chat={chat} onClose={() => setCallOpen(false)} />}
    </div>
  );
}
