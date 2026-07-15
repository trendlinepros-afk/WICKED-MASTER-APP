export function IdeaLogBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-ok/15 px-2 py-0.5 text-xs text-ok">
      💡 {count} idea{count === 1 ? '' : 's'} captured
    </span>
  );
}
