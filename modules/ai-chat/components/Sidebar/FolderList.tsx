import { useState } from 'react';
import { useFolderStore } from '../../store/folderStore';
import { FolderItem } from './FolderItem';
import { DND_FOLDER, childrenOf } from '../../lib/folderTree';

export function FolderList() {
  const folders = useFolderStore((s) => s.folders);
  const moveFolder = useFolderStore((s) => s.moveFolder);
  const [dragOver, setDragOver] = useState(false);

  if (folders.length === 0) return null;

  const topLevel = childrenOf(folders, null);

  return (
    <div className="mb-3">
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DND_FOLDER)) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false);
          const folderId = e.dataTransfer.getData(DND_FOLDER);
          if (folderId) moveFolder(folderId, null); // promote to top level
        }}
        className={`px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted ${
          dragOver ? 'rounded bg-accent/10 ring-1 ring-accent' : ''
        }`}
      >
        Folders
      </div>
      <div className="space-y-0.5">
        {topLevel.map((folder) => (
          <FolderItem key={folder.id} folder={folder} />
        ))}
      </div>
    </div>
  );
}
