import type { Chat } from '../../types';
import { useChatStore } from '../../store/chatStore';
import { useSend } from '../../hooks/useSend';
import { providerColor } from '../ModelSelector/modelConfig';

// An assistant-style chat bubble that asks whether to generate an image, with
// embedded Yes/No buttons. Shown when the user's message reads like an image
// request and image-gen isn't already on.
export function ImageOfferBubble({ chat }: { chat: Chat }) {
  const prompt = useChatStore((s) => s.pendingImageOffer[chat.id]);
  const { confirmImageOffer, declineImageOffer } = useSend();

  if (!prompt) return null;

  return (
    <div className="mb-5 flex justify-start">
      <div className="max-w-[85%]">
        <div className="mb-1 flex items-center gap-1.5 text-xs text-muted">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: providerColor('gemini') }} />
          WICKED
        </div>
        <div className="rounded-xl bg-raised px-4 py-3">
          <p className="text-ink">
            It looks like you want to <strong>generate an image</strong>. Want me to create it with
            Imagen? <span className="text-muted">(~$0.03–0.04)</span>
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => confirmImageOffer(chat, prompt)}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
            >
              🎨 Yes, generate it
            </button>
            <button
              onClick={() => declineImageOffer(chat)}
              className="rounded-lg border border-edge px-3 py-1.5 text-sm text-muted hover:text-ink"
            >
              No, just reply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
