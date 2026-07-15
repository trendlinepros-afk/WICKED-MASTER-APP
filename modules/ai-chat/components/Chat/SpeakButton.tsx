import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../../store/settingsStore';
import { useUIStore } from '../../store/uiStore';
import { useKeysStore } from '../../store/keysStore';
import { getTtsQueue, speakText, unlockAudio } from '../../lib/voice';

// Per-message read-aloud. One shared TTS queue app-wide: starting a message
// stops whatever else was speaking; clicking again while playing stops it.
export function SpeakButton({ text }: { text: string }) {
  const settings = useSettingsStore((s) => s.settings);
  const hasOpenAIKey = useKeysStore((s) => s.status['openai'] === true);
  const toast = useUIStore((s) => s.toast);
  const [speaking, setSpeaking] = useState(false);
  const tokenRef = useRef<object>({});

  useEffect(() => {
    return getTtsQueue().onChange((isSpeaking) => {
      setSpeaking(isSpeaking && getTtsQueue().owner === tokenRef.current);
    });
  }, []);

  const onClick = () => {
    unlockAudio();
    if (!hasOpenAIKey) {
      toast('Read-aloud needs an OpenAI API key — set one in Settings → API Keys.', 'error');
      return;
    }
    const queue = getTtsQueue();
    if (queue.owner === tokenRef.current && queue.speaking) {
      queue.stop();
      return;
    }
    speakText(text, settings, tokenRef.current);
  };

  return (
    <button onClick={onClick} className="hover:text-ink">
      {speaking ? '■ Stop' : '🔊 Speak'}
    </button>
  );
}
