import type { ContentPart } from '../../types';

export function AttachmentPreview({
  attachments,
  onRemove,
}: {
  attachments: ContentPart[];
  onRemove: (index: number) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-3 pb-2">
      {attachments.map((att, i) => (
        <div
          key={i}
          className="group relative flex items-center gap-2 rounded-lg border border-edge bg-raised px-2 py-1.5 text-xs"
        >
          {att.type === 'image_url' && att.image_url ? (
            <img
              src={att.image_url.url}
              alt="attachment"
              className="h-10 w-10 rounded object-cover"
            />
          ) : (
            <span className="max-w-[140px] truncate">📎 {att.name}</span>
          )}
          <button
            onClick={() => onRemove(i)}
            className="text-muted hover:text-red-400"
            title="Remove"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
