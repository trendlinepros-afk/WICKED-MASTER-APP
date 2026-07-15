import { useUIStore } from '../store/uiStore';

const KIND_STYLES: Record<string, string> = {
  info: 'border-accent/40 bg-accent/10',
  success: 'border-ok/40 bg-ok/10',
  error: 'border-red-500/40 bg-red-500/10',
};

export function Toaster() {
  const toasts = useUIStore((s) => s.toasts);
  const dismiss = useUIStore((s) => s.dismissToast);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto max-w-sm cursor-pointer rounded-lg border px-4 py-2.5 text-sm text-ink shadow-lg backdrop-blur ${
            KIND_STYLES[t.kind]
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
