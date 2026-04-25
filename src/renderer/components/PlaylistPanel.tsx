import React, { useRef, useEffect, useState, useCallback } from 'react';
import { FileInfo } from '../lib/types';

// ─── Sub-components ────────────────────────────────────────────────────────────

function ThemedToggle({ label, checked, onChange, paneDark, disabled, title }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; paneDark: boolean; disabled?: boolean; title?: string;
}) {
  const labelColor = disabled
    ? 'text-zinc-600'
    : checked ? (paneDark ? 'text-zinc-200' : 'text-zinc-800') : 'text-zinc-500';
  const trackColor = disabled
    ? (paneDark ? 'bg-zinc-800' : 'bg-zinc-300')
    : checked ? 'bg-blue-600' : (paneDark ? 'bg-zinc-600' : 'bg-zinc-400');
  return (
    <label
      className={`flex items-center gap-1.5 text-xs select-none ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
      title={title}
    >
      <button
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled}
        disabled={disabled}
        onClick={() => { if (!disabled) onChange(!checked); }}
        className={`w-8 h-4 rounded-full relative transition-colors ${trackColor}`}
      >
        <div className={`w-3 h-3 bg-white rounded-full absolute top-0.5 transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </button>
      <span className={labelColor}>{label}</span>
    </label>
  );
}

function HighlightedKey({ label, hotkey }: { label: string; hotkey: string }) {
  const idx = label.toLowerCase().indexOf(hotkey.toLowerCase());
  if (idx < 0) return <>{label}</>;
  return (
    <>
      {label.slice(0, idx)}
      <span className="underline font-bold">{label[idx]}</span>
      {label.slice(idx + 1)}
    </>
  );
}

// Persist log height across component remounts
let persistedLogHeight = 0;

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Stats Bar with live timer ──────────────────────────────────────────────────

function StatsBar({ stats, sessionStartTime, fileCount, viewedCount, paneDark, t }: {
  stats?: any; sessionStartTime?: number; fileCount: number; viewedCount: number; paneDark: boolean; t: any;
}) {
  const [elapsed, setElapsed] = useState('00:00:00');

  useEffect(() => {
    if (!sessionStartTime) return;
    const tick = () => {
      const diff = Math.floor((Date.now() - sessionStartTime) / 1000);
      const h = String(Math.floor(diff / 3600)).padStart(2, '0');
      const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
      const s = String(diff % 60).padStart(2, '0');
      setElapsed(`${h}:${m}:${s}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [sessionStartTime]);

  const s = stats || {};

  return (
    <div className={`border-t ${t.statsBorder} ${t.statsBg} px-3 py-1.5 text-xs ${t.statsText} flex gap-2 flex-wrap`}>
      <span className="tabular-nums">{elapsed}</span>
      <span>Files: {fileCount}</span>
      {s.kept > 0 && <span className="text-emerald-500">✅{s.kept}</span>}
      {s.purged > 0 && <span className="text-red-500">❌{s.purged}</span>}
      {s.fixed > 0 && <span className="text-amber-500">🔧{s.fixed}</span>}
      {s.translated > 0 && <span className="text-sky-500">📖{s.translated}</span>}
      {s.inquired > 0 && <span className="text-purple-500">🔍{s.inquired}</span>}
      {s.unreadable > 0 && <span className="text-rose-500">⚠️{s.unreadable}</span>}
      <span>Viewed: {viewedCount}</span>
    </div>
  );
}

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface PlaylistPanelProps {
  // State
  files: FileInfo[];
  currentIndex: number;
  sortDestination: string | null;
  viewedPaths: Set<string>;
  // Toggles
  shuffleEnabled: boolean;
  skipViewedEnabled: boolean;
  writeLogsEnabled?: boolean;
  onSetWriteLogs?: (v: boolean) => void;
  globalHotkeys: boolean;
  paneDark: boolean;
  viewerDark: boolean;
  // Categories
  categories?: { id: string; label: string; hotkey: string; color: string; isPurge?: boolean }[];
  // Stats & Log
  stats?: { opened: number; skipped: number; kept: number; purged: number; fixed: number; translated: number; inquired: number; unreadable: number };
  logEntries?: { time: string; text: string; color: string; emoji: string }[];
  sessionStartTime?: number;
  // Layout
  isDocked: boolean;
  dragging?: boolean;
  dropRef?: React.Ref<HTMLDivElement>;
  // Callbacks
  onSetShuffle: (v: boolean) => void;
  onSetSkipViewed: (v: boolean) => void;
  onSetGlobalHotkeys: (v: boolean) => void;
  onSetPaneDark: (v: boolean) => void;
  onSetViewerDark: (v: boolean) => void;
  immerseEnabled?: boolean;
  onSetImmerse?: (v: boolean) => void;
  onToggleDocked: () => void;
  onNavigate: (action: 'next' | 'back' | 'random') => void;
  onJumpTo: (index: number) => void;
  onRename?: (oldPath: string, newName: string) => void;
  onDeleteFiles?: (paths: string[]) => void;
  onRemoveFromPlaylist?: (paths: string[]) => void;
  // Compare
  compareMode?: boolean;
  comparePickMode?: boolean;
  comparePickTwoMode?: boolean;
  compareLeftIndex?: number | null;
  compareFileIndex?: number | null;
  onCompareWithCurrent?: (index: number) => void;
  onCycleComparePick?: () => void;
  onCancelComparePick?: () => void;
  onOpenSettings?: () => void;
  onRepack?: () => void;
  renamingIndex?: number | null;
  onSetRenamingIndex?: (index: number | null) => void;
  onSort?: (categoryId: string) => void;
  initialLogHeight?: number;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export default function PlaylistPanel(props: PlaylistPanelProps) {
  const {
    files, currentIndex, sortDestination, viewedPaths,
    shuffleEnabled, skipViewedEnabled, globalHotkeys, paneDark, viewerDark, isDocked,
    dragging, dropRef,
    onSetShuffle, onSetSkipViewed, onSetGlobalHotkeys, onSetPaneDark, onSetViewerDark,
    onToggleDocked, onNavigate, onJumpTo, onRename, onDeleteFiles, onRemoveFromPlaylist,
    renamingIndex, onSetRenamingIndex,
    compareMode, comparePickMode, comparePickTwoMode, compareLeftIndex, compareFileIndex,
    onCompareWithCurrent, onCycleComparePick, onCancelComparePick,
  } = props;

  const renameInputRef = useRef<HTMLInputElement>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  // Selection mode
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  const handleContextMenu = useCallback((e: React.MouseEvent, idx: number) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, index: idx });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // Close context menu on any click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  const toggleSelection = useCallback((path: string) => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedPaths(new Set());
  }, []);

  // Escape exits selection mode
  useEffect(() => {
    if (!selectionMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { exitSelectionMode(); e.preventDefault(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectionMode, exitSelectionMode]);

  const playlistRef = useRef<HTMLDivElement>(null);
  const logPanelRef = useRef<HTMLDivElement>(null);

  // Auto-scroll log to bottom when new entries arrive
  useEffect(() => {
    if (logPanelRef.current) {
      logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight;
    }
  }, [props.logEntries?.length]);
  const [logHeight, _setLogHeight] = useState(persistedLogHeight || props.initialLogHeight || 112);
  const setLogHeight = (h: number | ((prev: number) => number)) => {
    _setLogHeight(prev => {
      const val = typeof h === 'function' ? h(prev) : h;
      persistedLogHeight = val;
      // Save to config so it persists across restarts
      (window as any).electronAPI?.saveUiState({ logHeight: val });
      return val;
    });
  };

  // Resizable log panel
  const handleLogResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = logHeight;
    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      setLogHeight(Math.max(40, Math.min(400, startH + delta)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [logHeight]);

  // Auto-scroll to current item
  useEffect(() => {
    if (!playlistRef.current) return;
    const currentEl = playlistRef.current.querySelector('[data-current="true"]');
    if (currentEl) {
      currentEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [currentIndex]);

  // Theme palette
  const t = paneDark ? {
    bg: 'bg-zinc-900', border: 'border-zinc-800', headerText: 'text-zinc-100',
    subtitle: 'text-zinc-500', empty: 'text-zinc-600', logBg: '',
    statsBg: 'bg-zinc-800', statsBorder: 'border-zinc-700', statsText: 'text-zinc-400',
    playlistHover: 'hover:bg-zinc-800',
    currentBg: 'bg-blue-900/40', currentText: 'text-blue-300', currentBorder: 'border-l-blue-400',
    fileText: 'text-zinc-400', fileSizeText: 'text-zinc-600',
  } : {
    bg: 'bg-white', border: 'border-zinc-300', headerText: 'text-zinc-900',
    subtitle: 'text-zinc-600', empty: 'text-zinc-400', logBg: 'bg-zinc-50',
    statsBg: 'bg-zinc-100', statsBorder: 'border-zinc-300', statsText: 'text-zinc-700',
    playlistHover: 'hover:bg-zinc-100',
    currentBg: 'bg-blue-100', currentText: 'text-blue-800', currentBorder: 'border-l-blue-500',
    fileText: 'text-zinc-700', fileSizeText: 'text-zinc-400',
  };

  // Color mapping for category colors
  const colorMap: Record<string, { dark: string; light: string }> = {
    emerald: { dark: 'bg-emerald-700 hover:bg-emerald-600', light: 'bg-emerald-600 hover:bg-emerald-500' },
    red: { dark: 'bg-red-700 hover:bg-red-600', light: 'bg-red-600 hover:bg-red-500' },
    amber: { dark: 'bg-amber-700 hover:bg-amber-600', light: 'bg-amber-600 hover:bg-amber-500' },
    sky: { dark: 'bg-sky-700 hover:bg-sky-600', light: 'bg-sky-600 hover:bg-sky-500' },
    purple: { dark: 'bg-purple-700 hover:bg-purple-600', light: 'bg-purple-600 hover:bg-purple-500' },
    rose: { dark: 'bg-rose-700 hover:bg-rose-600', light: 'bg-rose-600 hover:bg-rose-500' },
    zinc: { dark: 'bg-zinc-700 hover:bg-zinc-600', light: 'bg-zinc-600 hover:bg-zinc-500' },
    teal: { dark: 'bg-teal-700 hover:bg-teal-600', light: 'bg-teal-600 hover:bg-teal-500' },
    orange: { dark: 'bg-orange-700 hover:bg-orange-600', light: 'bg-orange-600 hover:bg-orange-500' },
    blue: { dark: 'bg-blue-700 hover:bg-blue-600', light: 'bg-blue-600 hover:bg-blue-500' },
  };

  const sortButtons = (props.categories || [])
    .filter(c => !c.isPurge ? true : true) // Include all categories
    .map(c => ({
      id: c.id,
      label: c.label,
      key: c.hotkey.toUpperCase(),
      color: (colorMap[c.color] || colorMap.zinc)[paneDark ? 'dark' : 'light'],
    }));

  const navButtons = [
    { label: 'Next', key: 'N', color: paneDark ? 'bg-indigo-700 hover:bg-indigo-600' : 'bg-indigo-600 hover:bg-indigo-500', action: () => onNavigate('next') },
    { label: 'Back', key: 'B', color: paneDark ? 'bg-zinc-600 hover:bg-zinc-500' : 'bg-zinc-500 hover:bg-zinc-400', action: () => onNavigate('back') },
    { label: 'Random', key: 'R', color: paneDark ? 'bg-yellow-700 hover:bg-yellow-600' : 'bg-yellow-600 hover:bg-yellow-500', action: () => onNavigate('random') },
  ];

  const currentFile = files[currentIndex];

  return (
    <div ref={dropRef} className={`h-full w-full ${t.bg} flex flex-col transition-colors relative ${isDocked ? 'border-l ' + t.border : ''}`} style={{ minWidth: 330 }}>
      {/* Drop overlay */}
      {dragging && (
        <div className="absolute inset-0 bg-green-500/20 border-2 border-dashed border-green-400 flex items-center justify-center z-50">
          <p className={`text-lg font-semibold ${paneDark ? 'text-green-300' : 'text-green-600'}`}>
            Drop to add to playlist
          </p>
        </div>
      )}
      {/* Header */}
      <div className={`px-4 py-3 border-b ${t.border} flex items-start justify-between gap-2`}>
        <div className="min-w-0 flex-1">
          {currentFile ? (
            <>
              <p className={`text-sm font-semibold ${t.headerText} truncate`} title={currentFile.name}>
                {currentFile.name}
              </p>
              <p className={`text-xs ${t.subtitle} truncate`} title={sortDestination ?? ''}>
                {sortDestination ?? 'No sort destination'} &middot; {currentIndex + 1}/{files.length}
              </p>
            </>
          ) : (
            <>
              <p className={`text-lg font-semibold ${t.headerText}`}>CBZ Sorter v5</p>
              <p className={`text-xs ${t.subtitle}`}>Drop files or folder to start</p>
            </>
          )}
        </div>
        {/* Dock/Undock button */}
        <button
          onClick={onToggleDocked}
          className={`flex-shrink-0 px-2 py-1 rounded text-xs transition-colors ${paneDark ? 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200' : 'text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800'}`}
          title={isDocked ? 'Detach to separate window' : 'Dock into viewer window'}
        >
          {isDocked ? '⧉ Detach' : '⧉ Dock'}
        </button>
        <button
          onClick={props.onOpenSettings}
          className={`flex-shrink-0 px-2 py-1 rounded text-xs transition-colors ${paneDark ? 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200' : 'text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800'}`}
          title="Settings (Ctrl+,)"
        >
          ⚙
        </button>
      </div>

      {/* Toggles */}
      <div className={`px-4 py-2 border-b ${t.border} flex flex-wrap gap-x-3 gap-y-1.5`}>
        <ThemedToggle label="Shuffle" checked={shuffleEnabled} onChange={onSetShuffle} paneDark={paneDark} />
        <ThemedToggle label="Skip Viewed" checked={skipViewedEnabled} onChange={onSetSkipViewed} paneDark={paneDark} />
        <ThemedToggle label="Write Logs" checked={props.writeLogsEnabled ?? false} onChange={(v) => props.onSetWriteLogs?.(v)} paneDark={paneDark} />
        <div className={`w-full border-t ${t.border} my-1`} />
        <ThemedToggle label="Pane Light" checked={!paneDark} onChange={(v) => onSetPaneDark(!v)} paneDark={paneDark} />
        <ThemedToggle label="Viewer Light" checked={!viewerDark} onChange={(v) => onSetViewerDark(!v)} paneDark={paneDark} />
        <ThemedToggle
          label="Immerse"
          checked={props.immerseEnabled ?? false}
          onChange={(v) => props.onSetImmerse?.(v)}
          paneDark={paneDark}
          disabled={!isDocked}
          title={isDocked ? 'Black out every monitor except the viewer' : 'Immerse requires docked playlist'}
        />
      </div>

      {/* Sort Buttons */}
      <div className={`px-4 py-2 border-b ${t.border} grid grid-cols-3 gap-2`}>
        {sortButtons.map(({ label, key, color, id }) => (
          <button key={label} onClick={() => props.onSort?.(id)} className={`${color} text-white text-sm font-medium py-2 px-2 rounded transition-colors whitespace-nowrap min-w-0`}>
            <HighlightedKey label={label} hotkey={key} />
          </button>
        ))}
      </div>

      {/* Navigation Buttons */}
      <div className={`px-4 py-2 border-b ${t.border} grid grid-cols-3 gap-2`}>
        {navButtons.map(({ label, key, color, action }) => (
          <button key={label} onClick={action} className={`${color} text-white text-sm font-medium py-2 px-2 rounded transition-colors whitespace-nowrap min-w-0`}>
            <HighlightedKey label={label} hotkey={key} />
          </button>
        ))}
      </div>

      {/* Tools */}
      <div className={`px-4 py-2 border-b ${t.border} grid grid-cols-2 gap-2`}>
        <button
          onClick={onCycleComparePick}
          className={`text-sm font-medium py-1.5 px-2 rounded transition-colors whitespace-nowrap min-w-0 ${
            comparePickMode
              ? 'bg-orange-500 hover:bg-orange-400 text-white ring-2 ring-orange-300'
              : comparePickTwoMode
                ? 'bg-purple-500 hover:bg-purple-400 text-white ring-2 ring-purple-300'
                : (paneDark ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200' : 'bg-zinc-300 hover:bg-zinc-400 text-zinc-800')
          }`}
        >
          {comparePickMode ? '🔍 Pick 1...' : comparePickTwoMode ? '🔍 Pick 2...' : '🔍 Compare'}
        </button>
        <button
          onClick={props.onRepack}
          className={`text-sm font-medium py-1.5 px-2 rounded transition-colors whitespace-nowrap min-w-0 ${
            paneDark ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200' : 'bg-zinc-300 hover:bg-zinc-400 text-zinc-800'
          }`}
        >
          📦 Repack
        </button>
      </div>

      {/* Compare pick mode banner */}
      {comparePickMode && (
        <div className={`px-4 py-2 text-xs border-b ${t.border} ${paneDark ? 'bg-orange-900/30 text-orange-300' : 'bg-orange-100 text-orange-700'}`}>
          Click a file to compare with the current file. Click Compare again to pick two files instead. Escape to cancel.
        </div>
      )}
      {comparePickTwoMode && (
        <div className={`px-4 py-2 text-xs border-b ${t.border} ${paneDark ? 'bg-purple-900/30 text-purple-300' : 'bg-purple-100 text-purple-700'}`}>
          {compareLeftIndex === null
            ? 'Click the first file to compare. Escape to cancel.'
            : 'Now click the second file. Escape to cancel.'}
        </div>
      )}

      {/* Playlist */}
      <div ref={playlistRef} className="flex-1 overflow-y-auto px-1 py-1 min-h-0">
        {files.length === 0 ? (
          <p className={`text-xs ${t.empty} text-center py-8`}>Drop CBZ files or a folder to start sorting</p>
        ) : (
          <div className="space-y-px">
            {files.map((file, idx) => {
              const isCurrent = idx === currentIndex;
              const isViewed = viewedPaths.has(file.fullPath);
              const isRenaming = renamingIndex === idx;
              const isSelected = selectedPaths.has(file.fullPath);
              const isCompareLeft = comparePickTwoMode && compareLeftIndex === idx;
              // In compare mode, "left" is compareLeftIndex (pick-two) or currentIndex (pick-one).
              const compareLeftIdx = compareLeftIndex ?? currentIndex;
              const isComparing = compareMode && (idx === compareLeftIdx || idx === compareFileIndex);
              return (
                <div
                  key={file.fullPath}
                  data-current={isCurrent}
                  onClick={() => {
                    if (isRenaming) return;
                    if (selectionMode) { toggleSelection(file.fullPath); return; }
                    if (comparePickMode || comparePickTwoMode) { onCompareWithCurrent?.(idx); return; }
                    if (compareMode) return; // Don't navigate during compare mode
                    onJumpTo(idx);
                  }}
                  onContextMenu={(e) => handleContextMenu(e, idx)}
                  className={`px-2 py-1.5 rounded cursor-pointer transition-colors flex items-start gap-2 border-l-2 ${
                    isComparing
                      ? (paneDark ? 'bg-teal-900/30 text-teal-300 border-l-teal-400' : 'bg-teal-100 text-teal-700 border-l-teal-500')
                      : isCompareLeft
                        ? (paneDark ? 'bg-purple-900/30 text-purple-300 border-l-purple-400' : 'bg-purple-100 text-purple-700 border-l-purple-500')
                        : isSelected
                          ? (paneDark ? 'bg-red-900/30 text-red-300 border-l-red-400' : 'bg-red-100 text-red-700 border-l-red-500')
                          : isCurrent
                            ? `${t.currentBg} ${t.currentText} ${t.currentBorder}`
                            : `border-l-transparent ${t.playlistHover} ${isViewed ? t.fileSizeText : t.fileText}`
                  }`}
                >
                  {/* Selection checkbox */}
                  {selectionMode && (
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelection(file.fullPath)}
                      className="flex-shrink-0 mt-0.5 accent-red-500"
                      onClick={(e) => e.stopPropagation()}
                    />
                  )}
                  <span className={`text-xs flex-shrink-0 w-6 text-right tabular-nums pt-0.5 ${isCurrent ? '' : t.fileSizeText}`}>
                    {idx + 1}
                  </span>
                  {isRenaming ? (
                    <textarea
                      ref={renameInputRef as any}
                      className={`text-xs flex-1 bg-transparent border rounded outline-none p-1 resize-none leading-relaxed ${
                        paneDark ? 'border-blue-400 text-zinc-100 bg-zinc-800' : 'border-blue-500 text-zinc-900 bg-zinc-100'
                      }`}
                      rows={5}
                      defaultValue={file.name}
                      autoFocus
                      onFocus={(e) => {
                        const name = file.name;
                        const dotIdx = name.lastIndexOf('.');
                        e.target.setSelectionRange(0, dotIdx > 0 ? dotIdx : name.length);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          const newName = (e.target as HTMLTextAreaElement).value.trim().replace(/\n/g, '');
                          if (newName && newName !== file.name) onRename?.(file.fullPath, newName);
                          onSetRenamingIndex?.(null);
                        } else if (e.key === 'Escape') {
                          onSetRenamingIndex?.(null);
                        }
                        e.stopPropagation();
                      }}
                      onBlur={() => onSetRenamingIndex?.(null)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="text-xs flex-1 break-words leading-relaxed">
                      {file.name}
                    </span>
                  )}
                  <span className={`text-xs flex-shrink-0 pt-0.5 ${t.fileSizeText}`}>
                    {formatSize(file.sizeBytes)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Selection mode action bar */}
      {selectionMode && (
        <div className={`px-3 py-2 border-t ${t.border} flex items-center gap-2 flex-wrap`}>
          <span className={`text-xs ${paneDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            {selectedPaths.size} selected
          </span>
          <div className="flex gap-1 ml-auto">
            <button
              onClick={() => { onDeleteFiles?.([...selectedPaths]); exitSelectionMode(); }}
              disabled={selectedPaths.size === 0}
              className="text-xs px-2 py-1 rounded bg-red-700 hover:bg-red-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Delete from Disk
            </button>
            <button
              onClick={() => { onRemoveFromPlaylist?.([...selectedPaths]); exitSelectionMode(); }}
              disabled={selectedPaths.size === 0}
              className={`text-xs px-2 py-1 rounded ${paneDark ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200' : 'bg-zinc-300 hover:bg-zinc-400 text-zinc-800'} disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              Remove from Playlist
            </button>
            <button
              onClick={exitSelectionMode}
              className={`text-xs px-2 py-1 rounded ${paneDark ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200' : 'bg-zinc-300 hover:bg-zinc-400 text-zinc-800'}`}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div
          className={`fixed z-50 rounded shadow-lg border py-1 min-w-[140px] ${
            paneDark ? 'bg-zinc-800 border-zinc-700' : 'bg-white border-zinc-300'
          }`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => { onSetRenamingIndex?.(contextMenu.index); closeContextMenu(); }}
            className={`w-full text-left text-xs px-3 py-1.5 ${paneDark ? 'text-zinc-200 hover:bg-zinc-700' : 'text-zinc-800 hover:bg-zinc-100'}`}
          >
            Rename (F2)
          </button>
          <button
            onClick={() => {
              onCompareWithCurrent?.(contextMenu.index);
              closeContextMenu();
            }}
            className={`w-full text-left text-xs px-3 py-1.5 ${paneDark ? 'text-zinc-200 hover:bg-zinc-700' : 'text-zinc-800 hover:bg-zinc-100'}`}
          >
            Compare with Current
          </button>
          <button
            onClick={() => {
              setSelectionMode(true);
              setSelectedPaths(new Set([files[contextMenu.index]?.fullPath].filter(Boolean)));
              closeContextMenu();
            }}
            className={`w-full text-left text-xs px-3 py-1.5 ${paneDark ? 'text-zinc-200 hover:bg-zinc-700' : 'text-zinc-800 hover:bg-zinc-100'}`}
          >
            Select
          </button>
          <div className={`my-1 border-t ${paneDark ? 'border-zinc-700' : 'border-zinc-200'}`} />
          <button
            onClick={() => {
              onRemoveFromPlaylist?.([files[contextMenu.index]?.fullPath].filter(Boolean));
              closeContextMenu();
            }}
            className={`w-full text-left text-xs px-3 py-1.5 ${paneDark ? 'text-zinc-200 hover:bg-zinc-700' : 'text-zinc-800 hover:bg-zinc-100'}`}
          >
            Remove from Playlist
          </button>
          <button
            onClick={() => {
              onDeleteFiles?.([files[contextMenu.index]?.fullPath].filter(Boolean));
              closeContextMenu();
            }}
            className={`w-full text-left text-xs px-3 py-1.5 text-red-400 ${paneDark ? 'hover:bg-zinc-700' : 'hover:bg-zinc-100'}`}
          >
            Delete from Disk
          </button>
        </div>
      )}

      {/* Log Panel — resizable vertically */}
      <div className="relative flex-shrink-0" style={{ height: logHeight }}>
        {/* Drag handle */}
        <div
          className={`absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize z-10 ${paneDark ? 'hover:bg-blue-500/30' : 'hover:bg-blue-400/30'}`}
          onMouseDown={handleLogResize}
        />
        <div ref={logPanelRef} className={`border-t ${t.border} ${t.logBg} h-full overflow-y-auto px-3 py-2`}>
          {(!props.logEntries || props.logEntries.length === 0) ? (
            <p className={`text-xs ${t.empty}`}>Log output will appear here</p>
          ) : (
            <div className="space-y-0.5">
              {props.logEntries.map((entry, i) => (
                <div key={i} className="flex gap-2 text-xs">
                  <span className={t.fileSizeText}>{entry.time}</span>
                  <span>{entry.emoji}</span>
                  <span className={entry.color}>{entry.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Stats Bar */}
      <StatsBar stats={props.stats} sessionStartTime={props.sessionStartTime} fileCount={files.length} viewedCount={viewedPaths.size} paneDark={paneDark} t={t} />
    </div>
  );
}
