import { useChatStore } from '../../store/chatStore';
import { useSettingsStore } from '../../store/settingsStore';
import { defaultVersionFor } from '../ModelSelector/modelConfig';
import { PLANNING_SYSTEM_PROMPT } from '../../lib/planning';

export function NewChatButton() {
  const createChat = useChatStore((s) => s.createChat);
  const setSystemPrompt = useChatStore((s) => s.setSystemPrompt);
  const renameChat = useChatStore((s) => s.renameChat);
  const settings = useSettingsStore((s) => s.settings);

  const defaults = () => {
    const provider = settings.defaultProvider;
    const version = settings.defaultModelVersion || defaultVersionFor(provider);
    return { provider, version };
  };

  const onNewChat = () => {
    const { provider, version } = defaults();
    createChat(provider, version, null);
  };

  // Plan Mode: a chat seeded with the structured app-planning system prompt.
  const onNewPlan = async () => {
    const { provider, version } = defaults();
    const chat = await createChat(provider, version, null);
    await setSystemPrompt(chat.id, PLANNING_SYSTEM_PROMPT);
    await renameChat(chat.id, 'New App Plan');
  };

  return (
    <div className="flex gap-2">
      <button
        onClick={onNewChat}
        className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition hover:bg-accent/90"
      >
        <span className="text-base leading-none">+</span> New Chat
      </button>
      <button
        onClick={onNewPlan}
        title="Plan Mode — design an app, then generate a build prompt"
        className="flex items-center justify-center gap-1.5 rounded-lg border border-accent/40 px-3 py-2 text-sm font-medium text-accent transition hover:bg-accent/10"
      >
        🗺 Plan
      </button>
    </div>
  );
}
