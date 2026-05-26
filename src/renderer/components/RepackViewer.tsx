import React, { useState, useCallback, useRef, useEffect } from 'react';

interface RepackViewerProps {
  images: string[];
  imageNames?: string[];
  extractionId: string;
  fileName: string;
  initialFolderName?: string;
  darkMode: boolean;
  centerPage?: boolean;
  dockedPanelWidth?: number; // playlist panel width for center calculation
  initialColumns?: number;
  initialPanelWidthPercent?: number;
  onRepack: (keepIndices: number[], renames: Record<number, string>, folderName: string, fileName: string) => void;
  onSave: (keepIndices: number[], renames: Record<number, string>, folderName: string, fileName: string) => void;
  onCancel: () => void;
}

function imageUrl(extractionId: string, filename: string): string {
  return `cbz-image://host/${extractionId}/${filename}`;
}

// Keep panel width and columns persistent across file changes (module-level state)
let persistedPanelWidth = 0;
let persistedColumns = 3;

export default function RepackViewer({ images, imageNames, extractionId, fileName, initialFolderName = '', darkMode, centerPage, dockedPanelWidth = 0, initialColumns = 3, initialPanelWidthPercent = 40, onRepack, onSave, onCancel }: RepackViewerProps) {
  const [panelWidth, setPanelWidth] = useState(persistedPanelWidth); // 0 = use percentage
  const [columns, setColumns] = useState(persistedColumns || initialColumns);

  // Persist across file changes
  useEffect(() => { persistedPanelWidth = panelWidth; }, [panelWidth]);
  useEffect(() => { persistedColumns = columns; }, [columns]);

  const handlePanelResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth || (e.currentTarget.parentElement?.querySelector('[data-repack-panel]') as HTMLElement)?.offsetWidth || 400;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      setPanelWidth(Math.max(200, startW + delta));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panelWidth]);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [deletedIndices, setDeletedIndices] = useState<Set<number>>(new Set());
  const [previewIndex, setPreviewIndex] = useState(0);
  const [renames, setRenames] = useState<Record<number, string>>({});
  const [renamingIndex, setRenamingIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const [folderName, setFolderName] = useState<string>(initialFolderName);
  const [editableFileName, setEditableFileName] = useState<string>(fileName);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Reset editing state when file changes, but keep panel width
  useEffect(() => {
    setSelectedIndices(new Set());
    setDeletedIndices(new Set());
    setPreviewIndex(0);
    setRenames({});
    setRenamingIndex(null);
    setContextMenu(null);
    setFolderName(initialFolderName);
    setEditableFileName(fileName);
  }, [extractionId, initialFolderName, fileName]);
  const lastClickIndex = useRef<number | null>(null);

  const liveImages = images.map((img, i) => ({ original: img, index: i })).filter(e => !deletedIndices.has(e.index));

  // Close context menu on click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  // Ref forwarded to handleRepack once it's defined below. Declared up here so
  // the keydown effect can reference it without TDZ concerns. Ctrl+S triggers
  // the full "save and repack" action (writes the CBZ and exits repack mode),
  // matching common editor convention where Ctrl+S commits and finalizes.
  // The save-in-place ("Save" button) is still available via the on-screen
  // button for users who want to commit changes without exiting.
  const repackRef = useRef<() => void>(() => {});

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (renamingIndex !== null) setRenamingIndex(null);
        else if (selectedIndices.size > 0) setSelectedIndices(new Set());
        else onCancel();
        return;
      }
      // F2 is reserved for renaming the CBZ file in the playlist — not used here
      if (e.key === 'Delete' && selectedIndices.size > 0) {
        setDeletedIndices(prev => {
          const next = new Set(prev);
          selectedIndices.forEach(i => next.add(i));
          return next;
        });
        setSelectedIndices(new Set());
        return;
      }
      if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setSelectedIndices(new Set(liveImages.map(e => e.index)));
        return;
      }
      // Ctrl+S: save and repack (writes the CBZ to disk and exits repack mode).
      // Same as clicking the blue "Repack & Save" button at the bottom. The
      // separate "Save" button (save-in-place, stays in repack) remains for
      // users who want to commit without exiting. preventDefault blocks the
      // browser's "save page" prompt. stopPropagation + the local listener
      // keep this from colliding with the global useHotkeys dispatcher.
      // Explicitly NOT shift or alt — those combos mean toggle-shuffle and
      // randomize-playlist globally.
      if (e.key.toLowerCase() === 's' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        repackRef.current();
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedIndices, renamingIndex, liveImages, onCancel]);

  const handleThumbnailClick = useCallback((index: number, e: React.MouseEvent) => {
    setPreviewIndex(index);

    if (e.shiftKey && lastClickIndex.current !== null) {
      const start = Math.min(lastClickIndex.current, index);
      const end = Math.max(lastClickIndex.current, index);
      const liveIndices = liveImages.map(e => e.index);
      setSelectedIndices(prev => {
        const next = new Set(prev);
        liveIndices.forEach(i => { if (i >= start && i <= end) next.add(i); });
        return next;
      });
    } else {
      // Normal click — toggle selection
      setSelectedIndices(prev => {
        const next = new Set(prev);
        if (next.has(index)) next.delete(index); else next.add(index);
        return next;
      });
    }
    lastClickIndex.current = index;
  }, [liveImages]);

  const handleContextMenu = useCallback((e: React.MouseEvent, index: number) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, index });
    setPreviewIndex(index);
  }, []);

  const handleDeleteSelected = useCallback(() => {
    setDeletedIndices(prev => {
      const next = new Set(prev);
      selectedIndices.forEach(i => next.add(i));
      return next;
    });
    setSelectedIndices(new Set());
  }, [selectedIndices]);

  const selectFirstHalf = useCallback(() => {
    const half = Math.floor(liveImages.length / 2);
    setSelectedIndices(new Set(liveImages.slice(0, half).map(e => e.index)));
  }, [liveImages]);

  const selectSecondHalf = useCallback(() => {
    const half = Math.floor(liveImages.length / 2);
    // For odd counts: skip the middle page, take from half+1 onward
    const startFrom = liveImages.length % 2 === 0 ? half : half + 1;
    setSelectedIndices(new Set(liveImages.slice(startFrom).map(e => e.index)));
  }, [liveImages]);

  const selectOdd = useCallback(() => {
    setSelectedIndices(new Set(liveImages.filter((_, i) => i % 2 === 0).map(e => e.index)));
  }, [liveImages]);

  const selectEven = useCallback(() => {
    setSelectedIndices(new Set(liveImages.filter((_, i) => i % 2 === 1).map(e => e.index)));
  }, [liveImages]);

  const deselectAll = useCallback(() => {
    setSelectedIndices(new Set());
  }, []);

  const handleRenameSubmit = useCallback((index: number, newName: string) => {
    if (newName.trim()) {
      setRenames(prev => ({ ...prev, [index]: newName.trim() }));
    }
    setRenamingIndex(null);
  }, []);

  const handleRepack = useCallback(() => {
    const keepIndices = liveImages.map(e => e.index);
    onRepack(keepIndices, renames, folderName, editableFileName);
  }, [liveImages, renames, folderName, editableFileName, onRepack]);

  const handleSave = useCallback(() => {
    const keepIndices = liveImages.map(e => e.index);
    onSave(keepIndices, renames, folderName, editableFileName);
  }, [liveImages, renames, folderName, editableFileName, onSave]);

  // Keep repackRef.current pointed at the latest handleRepack closure so the
  // keydown listener above can call it without listing handleRepack in its deps
  // (which would tear down and re-add the listener on every rename/folder edit).
  useEffect(() => { repackRef.current = handleRepack; }, [handleRepack]);

  const bg = darkMode ? 'bg-zinc-950' : 'bg-zinc-100';
  const panelBg = darkMode ? 'bg-zinc-900' : 'bg-white';
  const border = darkMode ? 'border-zinc-800' : 'border-zinc-300';
  const text = darkMode ? 'text-zinc-300' : 'text-zinc-700';
  const subtext = darkMode ? 'text-zinc-500' : 'text-zinc-500';
  const selectedBg = darkMode ? 'ring-3 ring-blue-400 bg-blue-700/40 shadow-[0_0_12px_rgba(59,130,246,0.5)]' : 'ring-3 ring-blue-500 bg-blue-200/60 shadow-[0_0_12px_rgba(59,130,246,0.4)]';
  const btnBase = `px-3 py-1.5 rounded text-sm transition-colors whitespace-nowrap`;

  const previewImg = images[previewIndex];
  const displayName = (index: number) => renames[index] ?? imageNames?.[index] ?? `Page ${index + 1}`;

  return (
    <div className={`h-full w-full ${bg} flex flex-col`}>
      {/* Header */}
      <div className={`px-4 py-2 border-b ${border} flex items-center justify-between gap-3 ${panelBg}`}>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className={`text-sm font-semibold whitespace-nowrap ${darkMode ? 'text-zinc-100' : 'text-zinc-900'}`}>Repack:</span>
          <input
            value={editableFileName}
            onChange={(e) => setEditableFileName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') handleSave();
              if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
            }}
            placeholder="filename.cbz"
            title="CBZ filename on disk. Will be renamed on save. .cbz extension added automatically if omitted."
            className={`flex-1 min-w-0 text-sm px-2 py-0.5 rounded border ${darkMode ? 'bg-zinc-800 text-zinc-200 border-zinc-700 focus:border-blue-500' : 'bg-white text-zinc-800 border-zinc-300 focus:border-blue-500'} focus:outline-none`}
          />
          <span className={`text-sm ${subtext}`}>/</span>
          <input
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') handleSave();
              if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
            }}
            placeholder="(no folder inside archive)"
            title="Top-level folder inside the archive. Leave empty for a flat archive."
            className={`flex-1 min-w-0 text-sm px-2 py-0.5 rounded border ${darkMode ? 'bg-zinc-800 text-zinc-200 border-zinc-700 focus:border-blue-500' : 'bg-white text-zinc-800 border-zinc-300 focus:border-blue-500'} focus:outline-none`}
          />
          <button
            onClick={handleSave}
            disabled={liveImages.length === 0}
            className={`px-3 py-1 rounded text-xs whitespace-nowrap bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 disabled:cursor-not-allowed`}
            title="Save current changes (pages + folder name + filename) and stay in repack mode"
          >
            Save
          </button>
        </div>
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span className={`text-xs ${subtext}`}>{liveImages.length}/{images.length} pages</span>
          {selectedIndices.size > 0 && (
            <span className={`text-xs ${darkMode ? 'text-blue-400' : 'text-blue-600'}`}>{selectedIndices.size} selected</span>
          )}
        </div>
      </div>

      {/* Main content: thumbnails left, preview right */}
      <div className="flex-1 flex min-h-0">
        {/* Thumbnail panel + resize handle */}
        <div data-repack-panel className={`flex-shrink-0 overflow-y-auto p-2 ${panelBg}`} style={{ width: panelWidth > 0 ? panelWidth : `${initialPanelWidthPercent}%` }}>
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
            {liveImages.map(({ original, index }) => {
              const isSelected = selectedIndices.has(index);
              const isRenaming = renamingIndex === index;
              return (
                <div
                  key={index}
                  className={`rounded overflow-hidden cursor-pointer transition-all ${isSelected ? selectedBg : `hover:ring-1 ${darkMode ? 'hover:ring-zinc-600' : 'hover:ring-zinc-400'}`}`}
                  onClick={(e) => handleThumbnailClick(index, e)}
                  onContextMenu={(e) => handleContextMenu(e, index)}
                >
                  <img
                    src={imageUrl(extractionId, original)}
                    alt={`Page ${index + 1}`}
                    className="w-full object-contain"
                    style={{}}

                    draggable={false}
                  />
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      className={`w-full text-[10px] px-1 py-0.5 border-t ${darkMode ? 'bg-zinc-800 text-zinc-200 border-blue-500' : 'bg-white text-zinc-800 border-blue-500'}`}
                      defaultValue={displayName(index)}
                      autoFocus
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') handleRenameSubmit(index, (e.target as HTMLInputElement).value);
                        if (e.key === 'Escape') setRenamingIndex(null);
                      }}
                      onBlur={() => setRenamingIndex(null)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <p className={`text-[10px] px-1 py-0.5 truncate border-t ${border} ${subtext}`} title={displayName(index)}>
                      {displayName(index)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Resize handle */}
        <div
          className={`w-1 flex-shrink-0 cursor-ew-resize ${darkMode ? 'hover:bg-blue-500/40' : 'hover:bg-blue-400/40'}`}
          onMouseDown={handlePanelResize}
        />

        {/* Preview — center on screen only when thumbnail panel doesn't push past center */}
        <div className={`flex-1 flex items-center justify-center overflow-hidden ${bg} p-4`}>
          {previewImg && (() => {
            // Calculate how much to shift image right to reach screen center
            // Only shift when the playlist side (right) is wider than the thumbnail side (left)
            // Once thumbnail panel grows wider than playlist, stop shifting (offset = 0)
            let offset = 0;
            if (centerPage && dockedPanelWidth > 0) {
              // Get actual thumbnail panel pixel width
              const thumbEl = document.querySelector('[data-repack-panel]') as HTMLElement;
              const thumbW = thumbEl?.offsetWidth || panelWidth || 0;
              // Only shift if playlist is wider than thumbnail panel
              if (dockedPanelWidth > thumbW) {
                offset = (dockedPanelWidth - thumbW) / 2;
              }
            }
            return (
              <img
                src={imageUrl(extractionId, previewImg)}
                alt={`Preview page ${previewIndex + 1}`}
                className="max-w-full max-h-full object-contain"
                style={offset > 0 ? { position: 'relative' as const, left: `${offset}px` } : undefined}
                draggable={false}
              />
            );
          })()}
        </div>
      </div>

      {/* Action bar */}
      <div className={`px-4 py-2 border-t ${border} flex items-center justify-between gap-2 ${panelBg}`}>
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Column control */}
          <div className="flex items-center gap-1">
            <button onClick={() => setColumns(c => Math.max(1, c - 1))} className={`w-6 h-6 rounded text-xs ${darkMode ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300' : 'bg-zinc-200 hover:bg-zinc-300 text-zinc-700'}`}>−</button>
            <span className={`text-xs tabular-nums w-8 text-center ${subtext}`}>{columns}col</span>
            <button onClick={() => setColumns(c => Math.min(10, c + 1))} className={`w-6 h-6 rounded text-xs ${darkMode ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300' : 'bg-zinc-200 hover:bg-zinc-300 text-zinc-700'}`}>+</button>
          </div>
          <div className={`w-px h-5 ${border}`} />
          {/* Delete */}
          <button
            onClick={handleDeleteSelected}
            disabled={selectedIndices.size === 0}
            className={`${btnBase} bg-red-700 hover:bg-red-600 text-white disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            Delete ({selectedIndices.size})
          </button>
          {deletedIndices.size > 0 && (
            <button
              onClick={() => setDeletedIndices(new Set())}
              className={`${btnBase} ${darkMode ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200' : 'bg-zinc-300 hover:bg-zinc-400 text-zinc-800'}`}
            >
              Undo ({deletedIndices.size})
            </button>
          )}
          <div className={`w-px h-5 ${border}`} />
          {/* Selection helpers */}
          <button onClick={deselectAll} disabled={selectedIndices.size === 0}
            className={`${btnBase} ${darkMode ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200' : 'bg-zinc-300 hover:bg-zinc-400 text-zinc-800'} disabled:opacity-40`}>
            Deselect
          </button>
          <button onClick={selectFirstHalf}
            className={`${btnBase} ${darkMode ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200' : 'bg-zinc-300 hover:bg-zinc-400 text-zinc-800'}`}>
            1st Half
          </button>
          <button onClick={selectSecondHalf}
            className={`${btnBase} ${darkMode ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200' : 'bg-zinc-300 hover:bg-zinc-400 text-zinc-800'}`}>
            2nd Half
          </button>
          <button onClick={selectOdd}
            className={`${btnBase} ${darkMode ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200' : 'bg-zinc-300 hover:bg-zinc-400 text-zinc-800'}`}>
            Odd
          </button>
          <button onClick={selectEven}
            className={`${btnBase} ${darkMode ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200' : 'bg-zinc-300 hover:bg-zinc-400 text-zinc-800'}`}>
            Even
          </button>
          <button
            onClick={handleSave}
            disabled={liveImages.length === 0}
            className={`${btnBase} bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 disabled:cursor-not-allowed`}
            title="Save current changes (pages + folder name + filename) and stay in repack mode"
          >
            Save
          </button>
        </div>
        <div className="flex gap-2">
          <button onClick={onCancel} className={`${btnBase} ${darkMode ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200' : 'bg-zinc-300 hover:bg-zinc-400 text-zinc-800'}`}>
            Cancel
          </button>
          <button
            onClick={handleRepack}
            disabled={liveImages.length === 0}
            title="Save changes, write the CBZ to disk, and exit repack mode (Ctrl+S)"
            className={`${btnBase} bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            Repack & Save ({liveImages.length} pages)
          </button>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className={`fixed z-50 rounded shadow-lg border py-1 min-w-[140px] ${darkMode ? 'bg-zinc-800 border-zinc-700' : 'bg-white border-zinc-300'}`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => { setRenamingIndex(contextMenu.index); setContextMenu(null); }}
            className={`w-full text-left text-xs px-3 py-1.5 ${darkMode ? 'text-zinc-200 hover:bg-zinc-700' : 'text-zinc-800 hover:bg-zinc-100'}`}
          >
            Rename
          </button>
          <button
            onClick={() => {
              setDeletedIndices(prev => new Set(prev).add(contextMenu.index));
              setSelectedIndices(prev => { const n = new Set(prev); n.delete(contextMenu.index); return n; });
              setContextMenu(null);
            }}
            className={`w-full text-left text-xs px-3 py-1.5 text-red-400 ${darkMode ? 'hover:bg-zinc-700' : 'hover:bg-zinc-100'}`}
          >
            Delete
          </button>
          <div className={`my-1 border-t ${darkMode ? 'border-zinc-700' : 'border-zinc-200'}`} />
          <button
            onClick={() => {
              setSelectedIndices(new Set(liveImages.map(e => e.index)));
              setContextMenu(null);
            }}
            className={`w-full text-left text-xs px-3 py-1.5 ${darkMode ? 'text-zinc-200 hover:bg-zinc-700' : 'text-zinc-800 hover:bg-zinc-100'}`}
          >
            Select All
          </button>
        </div>
      )}
    </div>
  );
}
