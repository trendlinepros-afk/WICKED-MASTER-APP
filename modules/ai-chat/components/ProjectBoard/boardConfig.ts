import type { BoardPriority } from '../../types';

export const PRIORITIES: { value: BoardPriority; label: string; chip: string }[] = [
  { value: 'none', label: 'No priority', chip: '' },
  { value: 'low', label: 'Low', chip: 'bg-sky-500/20 text-sky-500' },
  { value: 'medium', label: 'Medium', chip: 'bg-amber-500/20 text-amber-500' },
  { value: 'high', label: 'High', chip: 'bg-orange-500/25 text-orange-500' },
  { value: 'urgent', label: 'Urgent', chip: 'bg-red-500/25 text-red-500' },
];

export function priorityMeta(p: BoardPriority) {
  return PRIORITIES.find((x) => x.value === p) ?? PRIORITIES[0];
}

// Background tints for text notes — translucent so they read in both themes.
export const NOTE_COLORS: { key: string; label: string; bg: string; dot: string }[] = [
  { key: 'default', label: 'Plain', bg: '', dot: '#9ca3af' },
  { key: 'yellow', label: 'Yellow', bg: 'rgba(245, 158, 11, 0.16)', dot: '#f59e0b' },
  { key: 'green', label: 'Green', bg: 'rgba(34, 197, 94, 0.16)', dot: '#22c55e' },
  { key: 'blue', label: 'Blue', bg: 'rgba(59, 130, 246, 0.16)', dot: '#3b82f6' },
  { key: 'pink', label: 'Pink', bg: 'rgba(236, 72, 153, 0.16)', dot: '#ec4899' },
  { key: 'purple', label: 'Purple', bg: 'rgba(168, 85, 247, 0.16)', dot: '#a855f7' },
];

export function noteBg(key?: string): string {
  return NOTE_COLORS.find((c) => c.key === key)?.bg ?? '';
}

export const PEN_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#64748b'];
export const PEN_SIZES = [2, 4, 7];
