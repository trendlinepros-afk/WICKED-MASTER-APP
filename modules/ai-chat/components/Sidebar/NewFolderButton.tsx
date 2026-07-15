import { useState } from 'react';
import { useFolderStore } from '../../store/folderStore';

export function NewFolderButton() {
  const createFolder = useFolderStore((s) => s.createFolder);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) createFolder(trimmed);
    setName('');
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={submit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') {
            setName('');
            setEditing(false);
          }
        }}
        placeholder="Folder name…"
        className="w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
      />
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted hover:bg-raised hover:text-ink"
    >
      <span className="text-base leading-none">+</span> New Folder
    </button>
  );
}
