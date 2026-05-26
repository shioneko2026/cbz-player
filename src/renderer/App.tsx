import React, { useEffect, useState, useCallback, useRef } from 'react';
import { FileInfo } from './lib/types';
import { useNavigation } from './hooks/useNavigation';
import { useHotkeys, HotkeyAction } from './hooks/useHotkeys';
import CbzViewer from './components/CbzViewer';
import CompareViewer from './components/CompareViewer';
import RepackViewer from './components/RepackViewer';
import PlaylistPanel from './components/PlaylistPanel';
import SettingsModal from './components/SettingsModal';

// ─── Electron API Type ─────────────────────────────────────────────────────────

declare global {
  interface Window {
    electronAPI: {
      getWindowType: () => Promise<'viewer' | 'playlist'>;
      onStateUpdate: (callback: (state: any) => void) => void;
      broadcastState: (state: any) => void;
      onHotkeyTriggered: (callback: (action: string) => void) => void;
      setViewerTheme: (dark: boolean) => void;
      onViewerThemeChanged: (callback: (dark: boolean) => void) => void;
      loadFolder: (folderPath: string) => Promise<{ files: FileInfo[]; sortDestination: string }>;
      loadPaths: (filePaths: string[]) => Promise<{ files: FileInfo[]; sortDestination: string | null }>;
      pickFolder: () => Promise<string | null>;
      getPathForFile: (file: File) => string;
      sortFile: (filePath: string, categoryId: string, sortDest: string) => Promise<{ success: boolean; isDupe?: boolean; destPath?: string; error?: string; action?: string }>;
      unsortFile: (currentPath: string, originalPath: string) => Promise<{ success: boolean; file?: FileInfo; error?: string }>;
      graduatePurge: (heldPath: string) => Promise<{ success: boolean; error?: string }>;
      renameFile: (oldPath: string, newName: string) => Promise<{ success: boolean; file: FileInfo | null; error: string | null }>;
      trashFiles: (paths: string[]) => Promise<{ path: string; success: boolean }[]>;
      extractCbz: (cbzPath: string, slot?: string) => Promise<{ images: string[]; imageNames?: string[]; extractionId: string | null; topLevelFolder?: string; error: string | null }>;
      cleanupCbz: (slot?: string) => Promise<void>;
      onExtractionProgress: (callback: (progress: { percent: number; status: string; slot?: string }) => void) => void;
      repackCbz: (originalPath: string, slot: string, keepIndices: number[], renames: Record<string, string>, folderName?: string, newFileName?: string) => Promise<{ success: boolean; error?: string; newPath?: string }>;
      loadSettings: () => Promise<any>;
      saveSettings: (settings: any) => Promise<{ success: boolean }>;
      onMenuAction: (callback: (action: string) => void) => void;
      quitApp: (uiState?: any) => void;
      loadConfig: () => Promise<any>;
      saveUiState: (state: any) => void;
      setDockedMode: (docked: boolean) => void;
      toggleFullscreen: () => void;
      exitFullscreen: () => void;
      onDockedModeChanged: (callback: (docked: boolean) => void) => void;
      broadcastPlaylistState: (state: any) => void;
      onPlaylistStateUpdate: (callback: (state: any) => void) => void;
      sendPlaylistAction: (action: any) => void;
      onPlaylistAction: (callback: (action: any) => void) => void;
      onExplorerOpen: (callback: (payload: { files: FileInfo[]; mode: 'replace' | 'append'; sortDestination: string | null }) => void) => void;
      onExplorerCompare: (callback: (payload: { left: FileInfo; right: FileInfo }) => void) => void;
      onExplorerRepack: (callback: (payload: { file: FileInfo }) => void) => void;
    };
  }
}

// ─── Drop Zone Hook ────────────────────────────────────────────────────────────

function useDropZone(onFilesLoaded: (files: FileInfo[], sortDest: string | null) => void) {
  const [dragging, setDragging] = useState(false);
  const [el, setEl] = useState<HTMLDivElement | null>(null);

  // Callback ref — re-runs when the DOM element attaches/detaches
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    setEl(node);
  }, []);

  useEffect(() => {
    if (!el) return;
    let dragCounter = 0;

    const handleDragEnter = (e: globalThis.DragEvent) => { e.preventDefault(); dragCounter++; setDragging(true); };
    const handleDragOver = (e: globalThis.DragEvent) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
    const handleDragLeave = (e: globalThis.DragEvent) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; setDragging(false); } };
    const handleDrop = async (e: globalThis.DragEvent) => {
      e.preventDefault(); dragCounter = 0; setDragging(false);
      if (!window.electronAPI || !e.dataTransfer) return;
      const items = e.dataTransfer.files;
      if (!items || items.length === 0) return;
      const paths: string[] = [];
      for (let i = 0; i < items.length; i++) { const p = window.electronAPI.getPathForFile(items[i]); if (p) paths.push(p); }
      if (paths.length === 0) return;
      const isSingleNonCbz = paths.length === 1 && !paths[0].toLowerCase().endsWith('.cbz');
      if (isSingleNonCbz) {
        try { const r = await window.electronAPI.loadFolder(paths[0]); if (r.files.length > 0) { onFilesLoaded(r.files, r.sortDestination); return; } } catch {}
      }
      const r = await window.electronAPI.loadPaths(paths);
      if (r.files.length > 0) onFilesLoaded(r.files, r.sortDestination);
    };

    el.addEventListener('dragenter', handleDragEnter);
    el.addEventListener('dragover', handleDragOver);
    el.addEventListener('dragleave', handleDragLeave);
    el.addEventListener('drop', handleDrop);
    return () => { el.removeEventListener('dragenter', handleDragEnter); el.removeEventListener('dragover', handleDragOver); el.removeEventListener('dragleave', handleDragLeave); el.removeEventListener('drop', handleDrop); };
  }, [el, onFilesLoaded]);

  return { dragging, containerRef };
}

// ─── Shared playlist state hook ────────────────────────────────────────────────

interface LogEntry {
  time: string;
  text: string;
  color: string;
  emoji: string;
}

interface SessionStats {
  opened: number;
  skipped: number;
  kept: number;
  purged: number;
  fixed: number;
  translated: number;
  inquired: number;
  unreadable: number;
}

// Snapshot of the most recent move-style sort, so Ctrl+Z (or the Undo button)
// can reverse it. Single-level — overwritten on each sort, cleared on undo,
// and cleared on purge (which is intentionally not undoable here).
interface UndoSnapshot {
  originalPath: string;
  destPath: string;
  originalIndex: number;
  originalFile: FileInfo;
  categoryId: string;
  statKey: keyof SessionStats;
  label: string;
}

interface CategoryConfig {
  id: string;
  label: string;
  folderName: string;
  hotkey: string;
  color: string;
  parentCategory?: string;
  dupeFolderName?: string;
  isPurge?: boolean;
}

const DEFAULT_CATEGORIES: CategoryConfig[] = [
  { id: 'keep', label: 'Keep', folderName: '[00-Keep]', hotkey: 'k', color: 'emerald', dupeFolderName: '[Keep Dupes]' },
  { id: 'purge', label: 'Purge', folderName: '', hotkey: 'p', color: 'red', isPurge: true },
  { id: 'fix', label: 'To Fix', folderName: '[Needs Fixing]', hotkey: 'f', color: 'amber', dupeFolderName: '[Fix Dupes]' },
  { id: 'translate', label: 'Translate', folderName: '[To Be Translated OG]', hotkey: 't', color: 'sky', dupeFolderName: '[To Be TL Dupes]' },
  { id: 'inquire', label: 'Inquire', folderName: '[00-Inquire]', hotkey: 'i', color: 'purple', parentCategory: 'keep' },
  { id: 'unreadable', label: 'Unreadable', folderName: '[File Name Too Long]', hotkey: 'u', color: 'rose' },
];

function usePlaylistState() {
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [sessionStartTime] = useState(() => Date.now());
  const [stats, setStats] = useState<SessionStats>({ opened: 0, skipped: 0, kept: 0, purged: 0, fixed: 0, translated: 0, inquired: 0, unreadable: 0 });
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [categories, setCategories] = useState<CategoryConfig[]>(DEFAULT_CATEGORIES);
  const [sortDestination, setSortDestination] = useState<string | null>(null);
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [skipViewedEnabled, setSkipViewedEnabled] = useState(false);
  const [writeLogsEnabled, setWriteLogsEnabled] = useState(false);
  const [minLogSessionMinutes, setMinLogSessionMinutes] = useState(5);
  const [globalHotkeys, setGlobalHotkeys] = useState(false);
  const [viewedPaths, setViewedPaths] = useState<Set<string>>(new Set());
  const [paneDark, setPaneDark] = useState(true);
  const [viewerDark, setViewerDark] = useState(true);
  const [isDocked, setIsDocked] = useState(false);
  // Immerse mode is per-session — never persisted, always initializes to false.
  // Toggle is grayed out when !isDocked; detaching auto-disables it (main
  // process both tears down blackouts and broadcasts immerse:changed=false).
  const [immerseEnabled, setImmerseEnabledState] = useState(false);
  const [renamingIndex, setRenamingIndex] = useState<number | null>(null);
  const currentIndexRef = useRef(0);
  useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);

  // Compare mode
  const [compareMode, setCompareMode] = useState(false);
  const [compareFileIndex, setCompareFileIndex] = useState<number | null>(null);
  const [compareLeftIndex, setCompareLeftIndex] = useState<number | null>(null); // For pick-two mode
  const [comparePickMode, setComparePickMode] = useState(false); // Pick one (compare with current)
  const [comparePickTwoMode, setComparePickTwoMode] = useState(false); // Pick two files
  // (Previously had `adhocCompareLeft/Right` state for Explorer-launched compare
  // that bypassed the playlist. Removed in Phase 11 follow-up — user wanted the
  // Compare-from-Explorer files to actually land in the playlist so rename and
  // repack are accessible. enterAdhocCompare now appends to the playlist first,
  // then uses the regular playlist-based compare path.)

  const startRenaming = useCallback(() => {
    setRenamingIndex(currentIndexRef.current);
  }, []);

  const [configLoaded, setConfigLoaded] = useState(false);

  // Load saved config on mount
  useEffect(() => {
    if (!window.electronAPI) { setConfigLoaded(true); return; }
    window.electronAPI.loadConfig().then((cfg: any) => {
      if (cfg.paneDark !== undefined) setPaneDark(cfg.paneDark);
      if (cfg.viewerDark !== undefined) setViewerDark(cfg.viewerDark);
      if (cfg.isDocked !== undefined) setIsDocked(cfg.isDocked);
      if (cfg.categories?.length > 0) setCategories(cfg.categories);
      if (cfg.writeLogsEnabled !== undefined) setWriteLogsEnabled(cfg.writeLogsEnabled);
      if (cfg.minLogSessionMinutes !== undefined) setMinLogSessionMinutes(cfg.minLogSessionMinutes);
      setConfigLoaded(true);
    });
  }, []);

  const broadcast = useCallback((idx: number) => {
    window.electronAPI?.broadcastState({ currentIndex: idx });
  }, []);
  const addViewed = useCallback((path: string) => { setViewedPaths(prev => new Set(prev).add(path)); }, []);
  const resetViewed = useCallback(() => { setViewedPaths(new Set()); }, []);

  const addLog = useCallback((text: string, color: string, emoji: string) => {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour12: false });
    setLogEntries(prev => [...prev, { time, text, color, emoji }].slice(-500));
  }, []);

  const incrementStat = useCallback((key: keyof SessionStats) => {
    setStats(prev => ({ ...prev, [key]: prev[key] + 1 }));
  }, []);

  const clearLog = useCallback(() => { setLogEntries([]); }, []);

  const { navigate, jumpTo } = useNavigation({
    files, currentIndex, shuffleEnabled, skipViewedEnabled, viewedPaths,
    setCurrentIndex, addViewed, resetViewed, broadcast,
  });

  const handleViewerTheme = useCallback((dark: boolean) => {
    setViewerDark(dark);
    window.electronAPI?.setViewerTheme(dark);
  }, []);

  const handleRename = useCallback(async (oldPath: string, newName: string) => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.renameFile(oldPath, newName);
    if (result.success && result.file) {
      setFiles(prev => {
        const updated = prev.map(f => f.fullPath === oldPath ? result.file! : f);
        return updated;
      });
      // Broadcast updated file list
      setFiles(prev => {
        window.electronAPI?.broadcastState({ files: prev });
        return prev;
      });
    } else if (result.error) {
      alert(`Rename failed: ${result.error}`);
    }
  }, []);

  // Sort action: move/purge current file, remove from playlist, advance to next
  const [isProcessing, setIsProcessing] = useState(false);
  // Single-level undo snapshot — populated after each successful move-style sort,
  // cleared after undo, cleared on purge (purges aren't undoable here).
  const [lastUndo, setLastUndo] = useState<UndoSnapshot | null>(null);

  const handleSort = useCallback(async (categoryId: string) => {
    if (!window.electronAPI || isProcessing) return;
    if (files.length === 0 || !sortDestination) return;

    const file = files[currentIndexRef.current];
    if (!file) return;

    setIsProcessing(true);

    try {
      const result = await window.electronAPI.sortFile(file.fullPath, categoryId, sortDestination);
      if (!result.success) {
        addLog(`Failed: ${file.name} — ${result.error}`, 'text-red-400', '❌');
        alert(`Sort failed: ${result.error}`);
        setIsProcessing(false);
        return;
      }

      // Log and update stats
      const logMap: Record<string, { color: string; emoji: string; stat: keyof SessionStats; label: string }> = {
        keep:       { color: 'text-emerald-400', emoji: '✅', stat: 'kept', label: 'Kept' },
        purge:      { color: 'text-red-400',     emoji: '❌', stat: 'purged', label: 'Purged' },
        fix:        { color: 'text-amber-400',   emoji: '🔧', stat: 'fixed', label: 'To Fix' },
        translate:  { color: 'text-sky-400',     emoji: '📖', stat: 'translated', label: 'To TL' },
        inquire:    { color: 'text-purple-400',  emoji: '🔍', stat: 'inquired', label: 'Inquire' },
        unreadable: { color: 'text-rose-400',    emoji: '⚠️', stat: 'unreadable', label: 'Unreadable' },
      };
      const info = logMap[categoryId];
      if (info) {
        const pos = `[${currentIndexRef.current + 1}/${files.length}]`;
        addLog(`${pos} ${info.label}: ${file.name}${result.isDupe ? ' (dupe)' : ''}`, info.color, info.emoji);
        incrementStat(info.stat);
      }

      // Single-level undo: setting a new snapshot loses the previous one.
      // If the previous one was a purge (file lives in the holding folder),
      // graduate it to the real Windows Recycle Bin first so the user can
      // still recover it via Windows even though it's no longer undoable
      // in-app. Fire-and-forget — graduation failure isn't worth blocking
      // the new sort; the next startup sweep will catch any stragglers.
      if (lastUndo && lastUndo.categoryId === 'purge') {
        window.electronAPI?.graduatePurge?.(lastUndo.destPath).catch(() => {});
      }

      // Capture undo snapshot for both move-style sorts AND purge. For purge
      // the destPath is inside our holding folder (see file:sort backend);
      // unsortFile handles either case transparently.
      if ((result.action === 'move' || result.action === 'purge') && result.destPath && info) {
        setLastUndo({
          originalPath: file.fullPath,
          destPath: result.destPath,
          originalIndex: currentIndexRef.current,
          originalFile: file,
          categoryId,
          statKey: info.stat,
          label: info.label,
        });
      } else {
        setLastUndo(null);
      }

      // Remove from playlist and advance
      const idx = currentIndexRef.current;
      setFiles(prev => {
        const updated = prev.filter(f => f.fullPath !== file.fullPath);
        let newIdx = idx;
        if (updated.length === 0) {
          newIdx = 0;
        } else if (idx >= updated.length) {
          newIdx = 0;
        }
        setCurrentIndex(newIdx);
        currentIndexRef.current = newIdx;
        // Broadcast so viewer extracts next file and detached playlist updates
        window.electronAPI?.broadcastState({ files: updated, currentIndex: newIdx });
        return updated;
      });
    } finally {
      setIsProcessing(false);
    }
  }, [files, sortDestination, isProcessing, lastUndo]);

  // Reverse the most recent move-style sort. Moves the file from its sort
  // destination back to its original folder, re-inserts it into the playlist
  // at its original index, and jumps the cursor to it so the user can
  // immediately act (rename, compare, etc.) — which is the whole point of
  // wanting it back. Fails loud on filesystem conflicts (something already at
  // the original path, file no longer at the destination) per the global
  // fail-loud principle: silent recovery here could lose user data.
  const handleUndo = useCallback(async () => {
    if (!window.electronAPI || !lastUndo || isProcessing) return;
    setIsProcessing(true);
    try {
      const result = await window.electronAPI.unsortFile(lastUndo.destPath, lastUndo.originalPath);
      if (!result.success || !result.file) {
        addLog(`Undo failed: ${lastUndo.originalFile.name} — ${result.error ?? 'unknown error'}`, 'text-red-400', '❌');
        alert(`Undo failed: ${result.error ?? 'unknown error'}`);
        return;
      }

      // Re-insert at original index, clamped to current list bounds (the
      // playlist may have shrunk via other actions since the sort).
      const restored = result.file;
      const snapshot = lastUndo;
      setFiles(prev => {
        const insertAt = Math.min(snapshot.originalIndex, prev.length);
        const updated = [...prev.slice(0, insertAt), restored, ...prev.slice(insertAt)];
        setCurrentIndex(insertAt);
        currentIndexRef.current = insertAt;
        window.electronAPI?.broadcastState({ files: updated, currentIndex: insertAt });
        return updated;
      });

      // Reverse the stat increment so totals stay honest.
      setStats(prev => ({ ...prev, [snapshot.statKey]: Math.max(0, prev[snapshot.statKey] - 1) }));
      addLog(`↩️ Undone ${snapshot.label}: ${restored.name}`, 'text-zinc-300', '↩️');
      setLastUndo(null);
    } finally {
      setIsProcessing(false);
    }
  }, [lastUndo, isProcessing, addLog]);

  // After a list mutation, keep currentIndex pointing at the same file (or clamp if it was removed).
  const reconcileCurrentIndex = useCallback((prev: FileInfo[], updated: FileInfo[]): number => {
    const oldIdx = currentIndexRef.current;
    const oldFile = prev[oldIdx];
    if (oldFile) {
      const found = updated.findIndex(f => f.fullPath === oldFile.fullPath);
      if (found >= 0) return found;
    }
    if (updated.length === 0) return 0;
    return Math.min(oldIdx, updated.length - 1);
  }, []);

  const handleDeleteFiles = useCallback(async (paths: string[]) => {
    if (!window.electronAPI || paths.length === 0) return;
    const results = await window.electronAPI.trashFiles(paths);
    const deleted = new Set(results.filter(r => r.success).map(r => r.path));
    if (deleted.size > 0) {
      setFiles(prev => {
        const updated = prev.filter(f => !deleted.has(f.fullPath));
        const newIdx = reconcileCurrentIndex(prev, updated);
        if (newIdx !== currentIndexRef.current) {
          setCurrentIndex(newIdx);
          currentIndexRef.current = newIdx;
        }
        window.electronAPI?.broadcastState({ files: updated, currentIndex: newIdx });
        return updated;
      });
    }
  }, [reconcileCurrentIndex]);

  const handleRemoveFromPlaylist = useCallback((paths: string[]) => {
    const toRemove = new Set(paths);
    setFiles(prev => {
      const updated = prev.filter(f => !toRemove.has(f.fullPath));
      const newIdx = reconcileCurrentIndex(prev, updated);
      if (newIdx !== currentIndexRef.current) {
        setCurrentIndex(newIdx);
        currentIndexRef.current = newIdx;
      }
      window.electronAPI?.broadcastState({ files: updated, currentIndex: newIdx });
      return updated;
    });
  }, [reconcileCurrentIndex]);

  // Compare mode: compare a file with the current file
  const startCompareWithFile = useCallback((fileIndex: number) => {
    if (comparePickTwoMode) {
      if (compareLeftIndex === null) {
        setCompareLeftIndex(fileIndex);
      } else {
        // Can't compare a file with itself
        if (fileIndex === compareLeftIndex) return;
        // Keep compareLeftIndex set — renderer uses it as the "left" file in pick-two.
        // Do NOT mutate currentIndex — user expects it to point to their original
        // viewing position after compare exits.
        setCompareFileIndex(fileIndex);
        setCompareMode(true);
        setComparePickMode(false);
        setComparePickTwoMode(false);
      }
      return;
    }
    // Normal pick mode: can't compare current file with itself
    if (fileIndex === currentIndexRef.current) return;
    setCompareFileIndex(fileIndex);
    setCompareMode(true);
    setComparePickMode(false);
  }, [comparePickTwoMode, compareLeftIndex]);

  // Hotkey entry: go straight to "Pick with current" state. No-op if already
  // in any compare state (pick-one, pick-two, or active compare) so a repeated
  // keypress doesn't reset progress.
  const enterComparePickMode = useCallback(() => {
    if (compareMode || comparePickMode || comparePickTwoMode) return;
    setComparePickMode(true);
    setComparePickTwoMode(false);
    setCompareLeftIndex(null);
  }, [compareMode, comparePickMode, comparePickTwoMode]);

  // Cycle: Off → Pick with current → Pick two → Off
  const cycleComparePick = useCallback(() => {
    if (!comparePickMode && !comparePickTwoMode) {
      // Off → Pick with current
      setComparePickMode(true);
      setComparePickTwoMode(false);
      setCompareLeftIndex(null);
    } else if (comparePickMode && !comparePickTwoMode) {
      // Pick with current → Pick two
      setComparePickMode(false);
      setComparePickTwoMode(true);
      setCompareLeftIndex(null);
    } else {
      // Pick two → Off
      setComparePickMode(false);
      setComparePickTwoMode(false);
      setCompareLeftIndex(null);
    }
  }, [comparePickMode, comparePickTwoMode]);

  const cancelComparePick = useCallback(() => {
    setComparePickMode(false);
    setComparePickTwoMode(false);
    setCompareLeftIndex(null);
  }, []);

  // Enter compare with two files invoked from Explorer's "Compare in CBZ Player"
  // verb. Per user request (Phase 11 follow-up): both files get APPENDED to the
  // current playlist (deduped) so they're available for rename, repack, and
  // other playlist-bound actions after the user exits compare. Then we enter
  // the regular playlist-based compare using their indices.
  const enterAdhocCompare = useCallback((left: FileInfo, right: FileInfo) => {
    // Build the updated playlist by appending left and right if not already present.
    setFiles(prev => {
      const existing = new Set(prev.map(f => f.fullPath));
      const toAppend: FileInfo[] = [];
      if (!existing.has(left.fullPath)) toAppend.push(left);
      if (!existing.has(right.fullPath) && right.fullPath !== left.fullPath) toAppend.push(right);
      const updated = toAppend.length > 0 ? [...prev, ...toAppend] : prev;

      // Find each file's index in the now-updated playlist.
      const leftIdx = updated.findIndex(f => f.fullPath === left.fullPath);
      const rightIdx = updated.findIndex(f => f.fullPath === right.fullPath);
      if (leftIdx === -1 || rightIdx === -1) return prev; // shouldn't happen

      // Set the playlist-based compare indices and enter compare mode. Using
      // compareLeftIndex (pick-two semantic) so the cursor doesn't jump to
      // the left file's index — the user's currentIndex stays where it was.
      setCompareLeftIndex(leftIdx);
      setCompareFileIndex(rightIdx);
      setCompareMode(true);

      // Broadcast the new playlist so the detached window updates too.
      window.electronAPI?.broadcastState({ files: updated });
      return updated;
    });
  }, []);

  const exitCompare = useCallback(() => {
    setCompareMode(false);
    setCompareFileIndex(null);
    setComparePickMode(false);
    setComparePickTwoMode(false);
    setCompareLeftIndex(null);
    window.electronAPI?.cleanupCbz('compare-left');
    window.electronAPI?.cleanupCbz('compare-right');
  }, []);

  // Ctrl+Alt+S: physically reshuffle the playlist. Current file becomes index 0,
  // everything else Fisher-Yates-shuffled into indices 1..N. Viewed state is
  // keyed by fullPath so dimming carries across. Broadcast so the detached
  // playlist window updates too.
  //
  // Reads `files` + `currentIndex` directly from state rather than refs —
  // useNavigation.jumpTo only calls setCurrentIndex (no immediate ref sync),
  // so currentIndexRef lags by one render after a playlist click, which made
  // this function always pin files[0] instead of the actually-viewed file.
  const randomizePlaylist = useCallback(() => {
    if (files.length <= 1) return;
    const idx = currentIndex;
    const current = files[idx];
    const rest = files.filter((_, i) => i !== idx);
    // Fisher-Yates on the rest
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const updated = current ? [current, ...rest] : rest;
    setFiles(updated);
    setCurrentIndex(0);
    currentIndexRef.current = 0;
    window.electronAPI?.broadcastState({ files: updated, currentIndex: 0 });
  }, [files, currentIndex]);

  const handleToggleDocked = useCallback(() => {
    const newDocked = !isDocked;
    setIsDocked(newDocked);
    window.electronAPI?.setDockedMode(newDocked);
  }, [isDocked]);

  // Immerse toggle setter — only effective while docked. Main process also
  // force-disables on detach (layout:set-docked handler calls setImmerseEnabled
  // false + broadcasts immerse:changed), so a stale `true` can't linger.
  const setImmerseEnabled = useCallback((enabled: boolean) => {
    if (enabled && !isDocked) return; // safety: don't enable while detached
    setImmerseEnabledState(enabled);
    (window.electronAPI as any)?.setImmerseEnabled?.(enabled);
  }, [isDocked]);

  // Listen for docked mode changes from other window
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.onDockedModeChanged((docked) => setIsDocked(docked));
  }, []);

  // Listen for immerse state broadcasts (fires when main force-disables on
  // detach so the renderer's toggle reflects reality).
  useEffect(() => {
    const api = window.electronAPI as any;
    if (!api?.onImmerseChanged) return;
    api.onImmerseChanged((enabled: boolean) => setImmerseEnabledState(enabled));
  }, []);

  return {
    files, setFiles, currentIndex, setCurrentIndex, sortDestination, setSortDestination,
    shuffleEnabled, setShuffleEnabled, skipViewedEnabled, setSkipViewedEnabled,
    globalHotkeys, setGlobalHotkeys, viewedPaths, setViewedPaths,
    paneDark, setPaneDark, viewerDark, setViewerDark, isDocked,
    immerseEnabled, setImmerseEnabled,
    renamingIndex, setRenamingIndex, startRenaming, handleRename,
    handleSort, isProcessing,
    lastUndo, handleUndo,
    handleDeleteFiles, handleRemoveFromPlaylist,
    compareMode, compareFileIndex, comparePickMode, comparePickTwoMode, compareLeftIndex,
    enterAdhocCompare,
    startCompareWithFile, cycleComparePick, cancelComparePick, exitCompare, enterComparePickMode,
    randomizePlaylist,
    categories, setCategories,
    writeLogsEnabled, setWriteLogsEnabled,
    minLogSessionMinutes, setMinLogSessionMinutes,
    stats, logEntries, sessionStartTime, addLog, incrementStat, clearLog,
    navigate, jumpTo, handleViewerTheme, handleToggleDocked,
  };
}

// ─── Viewer Window ─────────────────────────────────────────────────────────────

function ViewerWindow() {
  const [darkMode, setDarkMode] = useState(true);
  const [images, setImages] = useState<string[]>([]);
  const [imageNames, setImageNames] = useState<string[]>([]);
  const [topLevelFolder, setTopLevelFolder] = useState<string>('');
  const [extractionId, setExtractionId] = useState<string | null>(null);
  const [extractKey, setExtractKey] = useState(0);
  const [extracting, setExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState({ percent: 0, status: '' });
  const [error, setError] = useState<string | null>(null);
  const extractionCounterRef = useRef(0);
  const lastLoggedOpenRef = useRef<string | null>(null);
  const filesRef = useRef<FileInfo[]>([]);
  const indexRef = useRef<number>(0);

  const ps = usePlaylistState();

  // Compare mode extraction state
  const [compareLeftImages, setCompareLeftImages] = useState<string[]>([]);
  const [compareLeftId, setCompareLeftId] = useState('');
  const [compareRightImages, setCompareRightImages] = useState<string[]>([]);
  const [compareRightId, setCompareRightId] = useState('');
  const [compareSwapped, setCompareSwapped] = useState(false);

  // Start compare mode: extract both files from playlist indices. "Left" file
  // is compareLeftIndex when set (pick-two or Explorer-launched) or
  // currentIndex (pick-one). Reading from state, not refs — pick-two doesn't
  // sync ViewerWindow's indexRef.
  useEffect(() => {
    if (!ps.compareMode || ps.compareFileIndex === null || !window.electronAPI) return;

    const leftIdx = ps.compareLeftIndex ?? ps.currentIndex;
    const leftFile = ps.files[leftIdx] ?? null;
    const rightFile = ps.files[ps.compareFileIndex] ?? null;

    if (!leftFile || !rightFile) return;

    // Extract both sides sequentially to avoid race conditions
    setCompareLeftImages([]);
    setCompareRightImages([]);
    setCompareLeftId('');
    setCompareRightId('');
    setCompareSwapped(false);

    (async () => {
      try {
        const leftResult = await window.electronAPI.extractCbz(leftFile.fullPath, 'compare-left');
        if (!ps.compareMode) return;
        setCompareLeftImages(leftResult.images);
        setCompareLeftId(leftResult.extractionId ?? '');

        const rightResult = await window.electronAPI.extractCbz(rightFile.fullPath, 'compare-right');
        if (!ps.compareMode) return;
        setCompareRightImages(rightResult.images);
        setCompareRightId(rightResult.extractionId ?? '');
      } catch (err) {
        console.error('Compare extraction failed:', err);
      }
    })();
  }, [ps.compareMode, ps.compareFileIndex, ps.compareLeftIndex]);

  const doExtract = useCallback((filePath: string) => {
    if (!filePath || !window.electronAPI) return;

    const myCounter = ++extractionCounterRef.current;
    const slot = `main-${myCounter}`;

    setExtracting(true);
    setError(null);
    setImages([]);
    setExtractProgress({ percent: 0, status: 'Starting...' });

    // Clean up the previous extraction's slot asynchronously
    if (myCounter > 1) {
      window.electronAPI.cleanupCbz(`main-${myCounter - 1}`);
    }

    window.electronAPI.extractCbz(filePath, slot).then((result) => {
      if (extractionCounterRef.current !== myCounter) {
        window.electronAPI?.cleanupCbz(slot);
        return;
      }

      if (result.error) { setError(result.error); setImages([]); setImageNames([]); setTopLevelFolder(''); setExtractionId(null); }
      else {
        setImages(result.images);
        setImageNames(result.imageNames ?? []);
        setTopLevelFolder(result.topLevelFolder ?? '');
        setExtractionId(result.extractionId);
        setExtractKey(k => k + 1);
        // Log "Opened" — only once per file (prevent duplicates from broadcast echo)
        const file = filesRef.current[indexRef.current];
        if (file && lastLoggedOpenRef.current !== file.fullPath) {
          lastLoggedOpenRef.current = file.fullPath;
          const pos = `[${indexRef.current + 1}/${filesRef.current.length}]`;
          ps.addLog(`${pos} Opened: ${file.name}`, 'text-zinc-400', '📂');
          ps.incrementStat('opened');
        }
      }
      setExtracting(false);
    });
  }, []);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.onViewerThemeChanged((dark) => setDarkMode(dark));
    window.electronAPI.onExtractionProgress((progress) => {
      // Only show progress for the current extraction slot
      const currentSlot = `main-${extractionCounterRef.current}`;
      if (!progress.slot || progress.slot === currentSlot) {
        // Only go forward — never show a lower percentage (prevents flickering)
        setExtractProgress(prev => ({
          percent: Math.max(prev.percent, progress.percent),
          status: progress.status,
        }));
      }
    });
    window.electronAPI.onMenuAction?.((action) => {
      switch (action) {
        case 'open-settings': setSettingsOpen(true); break;
        case 'fullscreen':
          window.electronAPI?.toggleFullscreen();
          break;
        case 'toggle-playlist':
          // handled via hotkeys
          break;
      }
    });
    window.electronAPI.onStateUpdate((state) => {
      if (state.files) { filesRef.current = state.files; ps.setFiles(state.files); }
      if (state.currentIndex !== undefined) { indexRef.current = state.currentIndex; ps.setCurrentIndex(state.currentIndex); }
      if (state.sortDestination !== undefined) ps.setSortDestination(state.sortDestination);
      const f = state.files ?? filesRef.current;
      const idx = state.currentIndex ?? indexRef.current;
      const file = f[idx];
      if (file) {
        ps.setViewedPaths(prev => new Set(prev).add(file.fullPath));
        doExtract(file.fullPath);
      }
    });
  }, [doExtract]);

  /** After repack renames a CBZ on disk, swap its entry in the playlist so
   *  navigation, sort, and the viewer all keep pointing at the correct file. */
  const applyRepackRename = useCallback((oldPath: string, newPath: string) => {
    const basename = (p: string) => {
      const m = p.match(/[^\\/]+$/);
      return m ? m[0] : p;
    };
    const newName = basename(newPath);
    const patch = (list: FileInfo[]): FileInfo[] =>
      list.map(f => f.fullPath === oldPath ? { ...f, name: newName, fullPath: newPath } : f);
    ps.setFiles(prev => {
      const updated = patch(prev);
      window.electronAPI?.broadcastState({ files: updated });
      return updated;
    });
    filesRef.current = patch(filesRef.current);
  }, []);

  const navigateFile = useCallback((direction: 'next' | 'prev' | 'random') => {
    const f = filesRef.current;
    const idx = indexRef.current;
    if (f.length === 0) return;
    let newIdx: number;
    if (direction === 'random') newIdx = Math.floor(Math.random() * f.length);
    else if (direction === 'next') newIdx = idx + 1 < f.length ? idx + 1 : 0;
    else newIdx = idx > 0 ? idx - 1 : f.length - 1;
    ps.setCurrentIndex(newIdx);
    indexRef.current = newIdx;
    // Mark as viewed
    if (f[newIdx]) {
      ps.setViewedPaths(prev => new Set(prev).add(f[newIdx].fullPath));
    }
    doExtract(f[newIdx]?.fullPath);
    window.electronAPI?.broadcastState({ currentIndex: newIdx });
  }, [doExtract]);

  // Viewer drop = replace playlist
  const handleViewerDrop = useCallback((loadedFiles: FileInfo[], sortDest: string | null) => {
    ps.setFiles(loadedFiles);
    ps.setCurrentIndex(0);
    ps.setSortDestination(sortDest);
    ps.setViewedPaths(new Set([loadedFiles[0]?.fullPath].filter(Boolean)));
    filesRef.current = loadedFiles;
    indexRef.current = 0;
    if (loadedFiles[0]) doExtract(loadedFiles[0].fullPath);
    window.electronAPI?.broadcastState({ files: loadedFiles, currentIndex: 0, sortDestination: sortDest });
  }, [doExtract]);

  // Docked playlist drop = append to bottom of playlist
  const handlePlaylistDrop = useCallback((loadedFiles: FileInfo[], sortDest: string | null) => {
    const currentFiles = filesRef.current;
    const existingPaths = new Set(currentFiles.map(f => f.fullPath));
    const newFiles = loadedFiles.filter(f => !existingPaths.has(f.fullPath));
    if (newFiles.length === 0) return;
    const combined = [...currentFiles, ...newFiles];
    ps.setFiles(combined);
    filesRef.current = combined;
    if (sortDest) ps.setSortDestination(sortDest);
    window.electronAPI?.broadcastState({ files: combined, sortDestination: sortDest });
  }, []);

  const { dragging: viewerDragging, containerRef: viewerDropRef } = useDropZone(handleViewerDrop);
  const { dragging: playlistDragging, containerRef: playlistDropRef } = useDropZone(handlePlaylistDrop);

  // Docked panel state — load saved values
  const [panelWidth, setPanelWidth] = useState(320);
  const [playlistVisible, setPlaylistVisible] = useState(true);
  const [centerPage, setCenterPage] = useState(false);
  const [controlsHideDelay, setControlsHideDelay] = useState(1500);
  const [controlBarMode, setControlBarMode] = useState<'auto-hide' | 'hover-only' | 'always-visible'>('auto-hide');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [repackMode, setRepackMode] = useState(false);
  // Path of a file the user invoked Explorer's "Repack this CBZ" verb on,
  // waiting for its extraction to complete. Once `images.length > 0` and the
  // viewer's current file matches this path, we flip into repack mode and
  // clear this state.
  const [pendingRepackPath, setPendingRepackPath] = useState<string | null>(null);
  const [savedLogHeight, setSavedLogHeight] = useState(112);
  const [darkBgBrightness, setDarkBgBrightness] = useState(26);
  const [lightBgBrightness, setLightBgBrightness] = useState(232);
  const [repackColumns, setRepackColumns] = useState(3);
  const [repackThumbnailSize, setRepackThumbnailSize] = useState(150);
  const [repackPanelWidth, setRepackPanelWidth] = useState(40);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.loadConfig().then((cfg: any) => {
      if (cfg.dockedPanelWidth) setPanelWidth(cfg.dockedPanelWidth);
      if (cfg.playlistVisible !== undefined) setPlaylistVisible(cfg.playlistVisible);
      if (cfg.centerPage !== undefined) setCenterPage(cfg.centerPage);
      if (cfg.controlsHideDelay) setControlsHideDelay(cfg.controlsHideDelay);
      if (cfg.controlBarMode) setControlBarMode(cfg.controlBarMode);
      if (cfg.darkBgBrightness !== undefined) setDarkBgBrightness(cfg.darkBgBrightness);
      if (cfg.lightBgBrightness !== undefined) setLightBgBrightness(cfg.lightBgBrightness);
      if (cfg.repackColumns) setRepackColumns(cfg.repackColumns);
      if (cfg.repackThumbnailSize) setRepackThumbnailSize(cfg.repackThumbnailSize);
      if (cfg.repackPanelWidth) setRepackPanelWidth(cfg.repackPanelWidth);
      if (cfg.logHeight) setSavedLogHeight(cfg.logHeight);
      // Set beep settings for CbzViewer
      (window as any).__cbzSettings = {
        beepOnLastPage: cfg.beepOnLastPage ?? true,
        beepVolume: cfg.beepVolume ?? 0.15,
        beepPitch: cfg.beepPitch ?? 600,
      };
    });
  }, []);

  // Resizable docked panel — clamped by content width in center mode
  // Lock panel width when entering compare mode
  const comparePanelLock = useRef<number | null>(null);
  useEffect(() => {
    if (ps.compareMode) {
      comparePanelLock.current = panelWidth;
    } else {
      comparePanelLock.current = null;
    }
  }, [ps.compareMode]);

  const handlePanelResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      let maxW = 600;

      // In compare mode, lock panel to its width at compare start
      if (comparePanelLock.current !== null) {
        maxW = comparePanelLock.current;
      }

      // In center mode, limit panel width so images aren't covered
      if (centerPage && comparePanelLock.current === null) {
        const viewer = (window as any).__cbzViewer;
        if (viewer) {
          const cw = viewer.getContentWidth?.() ?? 0;
          if (cw > 0) {
            const windowWidth = window.innerWidth;
            const toggleW = 12;
            maxW = Math.min(maxW, windowWidth - cw - toggleW - 20);
          }
        }
      }

      setPanelWidth(Math.max(330, Math.min(maxW, startW + delta)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panelWidth, centerPage]);

  // Broadcast full playlist state to detached window whenever anything changes
  useEffect(() => {
    if (!window.electronAPI || ps.isDocked) return;
    window.electronAPI.broadcastPlaylistState({
      files: ps.files,
      currentIndex: ps.currentIndex,
      sortDestination: ps.sortDestination,
      viewedPaths: [...ps.viewedPaths], // Serialize Set to array
      shuffleEnabled: ps.shuffleEnabled,
      skipViewedEnabled: ps.skipViewedEnabled,
      writeLogsEnabled: ps.writeLogsEnabled,
      globalHotkeys: ps.globalHotkeys,
      paneDark: ps.paneDark,
      viewerDark: ps.viewerDark,
      isDocked: ps.isDocked,
      renamingIndex: ps.renamingIndex,
      compareMode: ps.compareMode,
      compareFileIndex: ps.compareFileIndex,
      comparePickMode: ps.comparePickMode,
      comparePickTwoMode: ps.comparePickTwoMode,
      compareLeftIndex: ps.compareLeftIndex,
      categories: ps.categories,
      stats: ps.stats,
      logEntries: ps.logEntries,
      sessionStartTime: ps.sessionStartTime,
      canUndo: !!ps.lastUndo,
      // So a quit from the detached playlist window can graduate any pending
      // held purge — the detached window doesn't otherwise know what's held.
      pendingPurgeHeldPath: (ps.lastUndo && ps.lastUndo.categoryId === 'purge')
        ? ps.lastUndo.destPath
        : undefined,
    });
  }, [ps.files, ps.currentIndex, ps.sortDestination, ps.viewedPaths, ps.shuffleEnabled,
      ps.skipViewedEnabled, ps.globalHotkeys, ps.paneDark, ps.viewerDark, ps.isDocked, ps.categories,
      ps.stats, ps.logEntries,
      ps.renamingIndex, ps.compareMode, ps.compareFileIndex, ps.comparePickMode,
      ps.comparePickTwoMode, ps.compareLeftIndex, ps.lastUndo]);

  // Listen for actions from detached playlist window
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.onPlaylistAction((action: any) => {
      switch (action.type) {
        case 'navigate': ps.navigate(action.direction); break;
        case 'jumpTo': {
          ps.jumpTo(action.index);
          // Also trigger extraction in viewer
          const file = filesRef.current[action.index];
          if (file) {
            indexRef.current = action.index;
            doExtract(file.fullPath);
          }
          break;
        }
        case 'setShuffle': ps.setShuffleEnabled(action.value); break;
        case 'setSkipViewed': ps.setSkipViewedEnabled(action.value); break;
        case 'setWriteLogs': ps.setWriteLogsEnabled(action.value); break;
        case 'setGlobalHotkeys': ps.setGlobalHotkeys(action.value); break;
        case 'setPaneDark': ps.setPaneDark(action.value); break;
        case 'setViewerDark': ps.handleViewerTheme(action.value); break;
        case 'toggleDocked': ps.handleToggleDocked(); break;
        case 'startRenaming': ps.startRenaming(); break;
        case 'setRenamingIndex': ps.setRenamingIndex(action.value); break;
        case 'rename': ps.handleRename(action.oldPath, action.newName); break;
        case 'deleteFiles': ps.handleDeleteFiles(action.paths); break;
        case 'removeFromPlaylist': ps.handleRemoveFromPlaylist(action.paths); break;
        case 'compareWithCurrent': ps.startCompareWithFile(action.index); break;
        case 'cycleComparePick': ps.cycleComparePick(); break;
        case 'cancelComparePick': ps.cancelComparePick(); break;
        case 'exitCompare': ps.exitCompare(); break;
        case 'filesLoaded': {
          ps.setFiles(action.files);
          ps.setCurrentIndex(0);
          ps.setSortDestination(action.sortDestination);
          ps.setViewedPaths(new Set([action.files[0]?.fullPath].filter(Boolean)));
          filesRef.current = action.files;
          indexRef.current = 0;
          if (action.files[0]) doExtract(action.files[0].fullPath);
          break;
        }
        case 'sort': ps.handleSort(action.categoryId); break;
        case 'undo': ps.handleUndo(); break;
        case 'openSettings': setSettingsOpen(true); break;
        case 'repack': if (images.length > 0 && !repackMode && !ps.compareMode) setRepackMode(true); break;
        case 'enterComparePickMode': ps.enterComparePickMode(); break;
        case 'randomizePlaylist': ps.randomizePlaylist(); break;
        case 'filesAppended': {
          const currentFiles = filesRef.current;
          const existingPaths = new Set(currentFiles.map((f: FileInfo) => f.fullPath));
          const newFiles = action.files.filter((f: FileInfo) => !existingPaths.has(f.fullPath));
          if (newFiles.length > 0) {
            const combined = [...currentFiles, ...newFiles];
            ps.setFiles(combined);
            filesRef.current = combined;
            if (action.sortDestination) ps.setSortDestination(action.sortDestination);
          }
          break;
        }
      }
    });
  }, [doExtract]);

  // Explorer launch dispatch (main → viewer): files arrive here after main has
  // batched a cold-start or second-instance argv via its debounce, parsed the
  // flags, and resolved paths to FileInfo. We route to the same semantics the
  // in-app drag-drop uses (single = replace, multi = append) or to ad-hoc
  // compare (appends to playlist + enters compare) or to repack (appends,
  // switches cursor, waits for extraction, enters repack mode).
  useEffect(() => {
    if (!window.electronAPI) return;
    if (typeof (window.electronAPI as any).onExplorerOpen !== 'function') return;
    window.electronAPI.onExplorerOpen(({ files, mode, sortDestination }) => {
      if (!files || files.length === 0) return;
      if (mode === 'replace') {
        handleViewerDrop(files, sortDestination);
      } else {
        handlePlaylistDrop(files, sortDestination);
      }
    });
    window.electronAPI.onExplorerCompare(({ left, right }) => {
      if (!left || !right) return;
      ps.enterAdhocCompare(left, right);
    });
    if (typeof (window.electronAPI as any).onExplorerRepack === 'function') {
      window.electronAPI.onExplorerRepack(({ file }) => {
        if (!file) return;
        // Append the file to the playlist (dedup), switch cursor to it,
        // kick off extraction. The pendingRepackPath state + the watcher
        // useEffect below will flip into repack mode once images arrive.
        const currentFiles = filesRef.current;
        const existingIdx = currentFiles.findIndex(f => f.fullPath === file.fullPath);
        if (existingIdx >= 0) {
          // Already in playlist — just jump to it and extract.
          ps.setCurrentIndex(existingIdx);
          indexRef.current = existingIdx;
          doExtract(file.fullPath);
        } else {
          const updated = [...currentFiles, file];
          ps.setFiles(updated);
          filesRef.current = updated;
          const newIdx = updated.length - 1;
          ps.setCurrentIndex(newIdx);
          indexRef.current = newIdx;
          window.electronAPI?.broadcastState({ files: updated, currentIndex: newIdx });
          doExtract(file.fullPath);
        }
        setPendingRepackPath(file.fullPath);
      });
    }
  }, [handleViewerDrop, handlePlaylistDrop, ps.enterAdhocCompare, doExtract]);

  // Watcher: when Explorer's "Repack this CBZ" verb fires we set
  // `pendingRepackPath` and kick off extraction. Repack mode requires
  // `images.length > 0` (Settings/state guard in the dispatcher and the
  // RepackViewer itself), so we can't enter repack until extraction
  // completes. This effect flips us in once that's true for the file we
  // asked about, then clears the pending flag.
  useEffect(() => {
    if (!pendingRepackPath) return;
    if (extracting) return;
    if (images.length === 0) return;
    const currentFile = ps.files[ps.currentIndex];
    if (!currentFile || currentFile.fullPath !== pendingRepackPath) return;
    // Avoid colliding with compare mode — don't auto-enter repack from
    // underneath a comparison. User can exit compare and re-invoke if needed.
    if (ps.compareMode || ps.comparePickMode || ps.comparePickTwoMode) {
      setPendingRepackPath(null);
      return;
    }
    setRepackMode(true);
    setPendingRepackPath(null);
  }, [pendingRepackPath, extracting, images.length, ps.files, ps.currentIndex, ps.compareMode, ps.comparePickMode, ps.comparePickTwoMode]);

  const handleAction = useCallback((action: HotkeyAction) => {
    const viewer = (window as any).__cbzViewer;
    switch (action) {
      case 'next-page': viewer?.nextPage(); break;
      case 'prev-page': viewer?.prevPage(); break;
      case 'first-page': viewer?.firstPage(); break;
      case 'last-page': viewer?.lastPage(); break;
      case 'fullscreen': window.electronAPI?.toggleFullscreen(); break;
      case 'toggle-playlist': if (ps.isDocked) setPlaylistVisible(v => !v); break;
      case 'toggle-center': if (showDockedPanel) setCenterPage(c => !c); break;
      case 'rename': ps.startRenaming(); break;
      case 'escape':
        if (ps.compareMode) ps.exitCompare();
        else if (ps.comparePickMode || ps.comparePickTwoMode) ps.cancelComparePick();
        else if (ps.renamingIndex !== null) ps.setRenamingIndex(null);
        break;
      case 'view-single': viewer?.setViewMode('single'); break;
      case 'view-dual-ltr': viewer?.setViewMode('dual-ltr'); break;
      case 'view-dual-rtl': viewer?.setViewMode('dual-rtl'); break;
      case 'view-scroll': viewer?.setViewMode('scroll'); break;
      case 'next-file': {
        const file = filesRef.current[indexRef.current];
        if (file) {
          const pos = `[${indexRef.current + 1}/${filesRef.current.length}]`;
          ps.addLog(`${pos} ⏭️ Skipped: ${file.name}`, 'text-zinc-500', '⏭️');
          ps.incrementStat('skipped');
        }
        navigateFile('next');
        break;
      }
      case 'prev-file': navigateFile('prev'); break;
      case 'random-file': navigateFile('random'); break;
      case 'clear-log': ps.clearLog(); break;
      case 'enter-compare': ps.enterComparePickMode(); break;
      case 'enter-repack':
        // Only enter repack if there's something extracted to repack, and
        // we're not already mid-compare. No-op if already in repack mode.
        if (!repackMode && !ps.compareMode && images.length > 0) setRepackMode(true);
        break;
      case 'toggle-shuffle': ps.setShuffleEnabled(!ps.shuffleEnabled); break;
      case 'randomize-playlist': ps.randomizePlaylist(); break;
      case 'keep': case 'purge': case 'fix': case 'translate':
      case 'inquire': case 'unreadable':
        ps.handleSort(action); break;
      case 'undo':
        // Allowed in any mode — mirrors sort, which also works in compare/repack.
        // handleUndo no-ops if there's no snapshot to undo, so this is safe.
        ps.handleUndo(); break;
      case 'quit': {
        // Gate session log: must have a destination, logs enabled, AND session
        // longer than minLogSessionMinutes. Sessions shorter than the threshold
        // (e.g. quick checks) deliberately leave no log entry.
        const elapsedMs = Date.now() - ps.sessionStartTime;
        const minMs = Math.max(0, ps.minLogSessionMinutes) * 60_000;
        const meetsMinDuration = elapsedMs >= minMs;
        // If a purge is currently sitting in the holding folder (most recent
        // action was a purge that hasn't been undone or overwritten), tell
        // main to graduate it to the real Recycle Bin before quitting. Main
        // awaits the graduation so the file lands cleanly instead of getting
        // stranded for the next startup sweep.
        const pendingPurgeHeldPath = (ps.lastUndo && ps.lastUndo.categoryId === 'purge')
          ? ps.lastUndo.destPath
          : undefined;
        window.electronAPI?.quitApp({
          paneDark: ps.paneDark, viewerDark: ps.viewerDark,
          isDocked: ps.isDocked, dockedPanelWidth: panelWidth,
          playlistVisible, centerPage,
          writeLogsEnabled: ps.writeLogsEnabled,
          sessionLog: (ps.sortDestination && ps.writeLogsEnabled && meetsMinDuration) ? {
            sortDestination: ps.sortDestination,
            startTime: ps.sessionStartTime,
            endTime: Date.now(),
            stats: ps.stats,
          } : undefined,
          pendingPurgeHeldPath,
        });
        break;
      }
    }
  }, [navigateFile, ps.handleSort, ps.isDocked, ps.paneDark, ps.viewerDark, ps.compareMode, ps.comparePickMode, ps.comparePickTwoMode, panelWidth, playlistVisible, centerPage, repackMode, images.length, ps.shuffleEnabled, ps.enterComparePickMode, ps.randomizePlaylist, ps.minLogSessionMinutes, ps.lastUndo, ps.handleUndo]);

  useHotkeys({ onAction: handleAction, includePageNav: true, disabled: settingsOpen });

  const currentFile = ps.files[ps.currentIndex] ?? null;
  // "Left"/"right" files in compare mode. Pick-two and Explorer-launched compare
  // both use compareLeftIndex; pick-one uses currentIndex. Right is always
  // compareFileIndex.
  const compareLeftFileIdx = ps.compareLeftIndex ?? ps.currentIndex;
  const compareLeftFile = ps.files[compareLeftFileIdx] ?? null;
  const compareRightFile = ps.compareFileIndex !== null ? (ps.files[ps.compareFileIndex] ?? null) : null;
  const showDockedPanel = ps.isDocked && playlistVisible;
  // Center-page offset: shift viewer content left by half the panel width
  const toggleWidth = ps.isDocked ? 12 : 0;
  const totalPanelWidth = showDockedPanel ? panelWidth + toggleWidth : (ps.isDocked ? toggleWidth : 0);
  const centerOffset = centerPage && totalPanelWidth > 0 ? totalPanelWidth / 2 : 0;

  return (
    <div className="h-full w-full flex transition-colors relative" style={{ backgroundColor: darkMode ? `rgb(${darkBgBrightness},${darkBgBrightness},${darkBgBrightness})` : `rgb(${lightBgBrightness},${lightBgBrightness},${lightBgBrightness})` }}>
      {/* Viewer area (drop = replace) */}
      <div ref={viewerDropRef} className="flex-1 min-w-0 relative overflow-hidden">
        {viewerDragging && (
          <div className="absolute inset-0 bg-blue-500/20 border-2 border-dashed border-blue-400 flex items-center justify-center z-50">
            <p className="text-blue-300 text-xl font-semibold">Drop to replace playlist</p>
          </div>
        )}
        {/* Compare Mode */}
        {ps.compareMode && (compareLeftImages.length === 0 || compareRightImages.length === 0) && (
          <div className={`h-full flex items-center justify-center ${darkMode ? 'text-zinc-500' : 'text-zinc-600'}`}>
            <p className="text-sm">Loading files for comparison...</p>
          </div>
        )}
        {ps.compareMode && compareLeftImages.length > 0 && compareRightImages.length > 0 && (
          <CompareViewer
            leftImages={compareSwapped ? compareRightImages : compareLeftImages}
            leftExtractionId={compareSwapped ? compareRightId : compareLeftId}
            leftName={compareSwapped ? (compareRightFile?.name ?? '') : (compareLeftFile?.name ?? '')}
            leftFileSize={compareSwapped ? compareRightFile?.sizeBytes : compareLeftFile?.sizeBytes}
            leftCreatedDate={compareSwapped ? compareRightFile?.createdDate : compareLeftFile?.createdDate}
            rightImages={compareSwapped ? compareLeftImages : compareRightImages}
            rightExtractionId={compareSwapped ? compareLeftId : compareRightId}
            rightName={compareSwapped ? (compareLeftFile?.name ?? '') : (compareRightFile?.name ?? '')}
            rightFileSize={compareSwapped ? compareLeftFile?.sizeBytes : compareRightFile?.sizeBytes}
            rightCreatedDate={compareSwapped ? compareLeftFile?.createdDate : compareRightFile?.createdDate}
            darkMode={darkMode}
            onSwap={() => setCompareSwapped(s => !s)}
            onDeleteLeft={() => {
              const fileToDelete = compareSwapped ? compareRightFile : compareLeftFile;
              if (fileToDelete) {
                ps.handleDeleteFiles([fileToDelete.fullPath]);
                ps.exitCompare();
              }
            }}
            onDeleteRight={() => {
              const fileToDelete = compareSwapped ? compareLeftFile : compareRightFile;
              if (fileToDelete) {
                ps.handleDeleteFiles([fileToDelete.fullPath]);
                ps.exitCompare();
              }
            }}
            onExit={ps.exitCompare}
          />
        )}

        {/* Repack Mode */}
        {repackMode && images.length === 0 && (
          <div className={`h-full flex items-center justify-center ${darkMode ? 'text-zinc-500' : 'text-zinc-600'}`}>
            <p className="text-sm">Loading file for repack...</p>
          </div>
        )}
        {repackMode && images.length > 0 && currentFile && (
          <RepackViewer
            images={images}
            imageNames={imageNames}
            extractionId={extractionId ?? ''}
            fileName={currentFile.name}
            initialFolderName={topLevelFolder}
            darkMode={darkMode}
            centerPage={centerPage}
            dockedPanelWidth={showDockedPanel ? panelWidth : 0}
            initialColumns={repackColumns}
            initialPanelWidthPercent={repackPanelWidth}
            onRepack={async (keepIndices, renames, folderName, newFileName) => {
              if (!currentFile || !extractionId) return;
              const oldPath = currentFile.fullPath;
              const result = await window.electronAPI?.repackCbz(oldPath, extractionId, keepIndices, renames as Record<string, string>, folderName, newFileName);
              if (result?.success) {
                const newPath = result.newPath ?? oldPath;
                if (newPath !== oldPath) applyRepackRename(oldPath, newPath);
                setRepackMode(false);
                doExtract(newPath);
              } else {
                alert(`Repack failed: ${result?.error}`);
              }
            }}
            onSave={async (keepIndices, renames, folderName, newFileName) => {
              if (!currentFile || !extractionId) return;
              const oldPath = currentFile.fullPath;
              const result = await window.electronAPI?.repackCbz(oldPath, extractionId, keepIndices, renames as Record<string, string>, folderName, newFileName);
              if (result?.success) {
                const newPath = result.newPath ?? oldPath;
                if (newPath !== oldPath) applyRepackRename(oldPath, newPath);
                // Stay in repack mode; re-extract so the viewer reflects the saved state.
                doExtract(newPath);
              } else {
                alert(`Save failed: ${result?.error}`);
              }
            }}
            onCancel={() => setRepackMode(false)}
          />
        )}

        {/* Normal viewer (hidden during compare/repack) */}
        {!ps.compareMode && !repackMode && (
          <>
            {ps.files.length === 0 && (
              <div className={`h-full flex items-center justify-center text-center ${darkMode ? 'text-zinc-500' : 'text-zinc-600'}`}>
                <div>
                  <p className="text-2xl mb-2">CBZ Player v5</p>
                  <p className="text-sm">Viewer Window</p>
                  <p className={`text-xs mt-4 ${darkMode ? 'text-zinc-600' : 'text-zinc-500'}`}>
                    Drop CBZ files or a folder here to start
                  </p>
                </div>
              </div>
            )}
            {extracting && (
              <div className={`h-full flex flex-col items-center justify-center gap-3 ${darkMode ? 'text-zinc-500' : 'text-zinc-600'}`}>
                <p className="text-sm truncate max-w-md px-4">{extractProgress.status || `Extracting ${currentFile?.name}...`}</p>
                <div className={`w-64 h-1.5 rounded-full overflow-hidden ${darkMode ? 'bg-zinc-800' : 'bg-zinc-300'}`}>
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all duration-200"
                    style={{ width: `${extractProgress.percent}%` }}
                  />
                </div>
                <p className="text-xs tabular-nums">{extractProgress.percent}%</p>
              </div>
            )}
            {error && !extracting && (
              <div className="h-full flex items-center justify-center text-red-400">
                <div className="text-center">
                  <p className="text-sm mb-1">Failed to open</p>
                  <p className="text-xs max-w-md">{error}</p>
                </div>
              </div>
            )}
            {!extracting && !error && images.length > 0 && (
              <CbzViewer
                key={extractKey}
                images={images}
                extractionId={extractionId ?? '0'}
                darkMode={darkMode}
                onNextFile={() => navigateFile('next')}
                onPrevFile={() => navigateFile('prev')}
                centerPage={centerPage}
                centerOffset={centerOffset}
                onToggleCenter={showDockedPanel ? () => setCenterPage(c => !c) : undefined}
                controlsHideDelay={controlsHideDelay}
                controlBarMode={controlBarMode}
                bgColor={darkMode ? `rgb(${darkBgBrightness},${darkBgBrightness},${darkBgBrightness})` : `rgb(${lightBgBrightness},${lightBgBrightness},${lightBgBrightness})`}
              />
            )}
          </>
        )}
      </div>

      {/* Playlist toggle button (visible when docked, thin subtle strip) */}
      {ps.isDocked && (
        <button
          onClick={() => setPlaylistVisible(v => !v)}
          className={`flex-shrink-0 w-3 h-full flex items-center justify-center transition-all opacity-30 hover:opacity-100 ${darkMode ? 'hover:bg-zinc-700 text-zinc-600 hover:text-zinc-300' : 'hover:bg-zinc-300 text-zinc-400 hover:text-zinc-600'}`}
          title={`${playlistVisible ? 'Hide' : 'Show'} playlist (F6)`}
        >
          <span className="text-[8px]">{playlistVisible ? '▶' : '◀'}</span>
        </button>
      )}

      {/* Docked playlist panel (drop = append) */}
      {showDockedPanel && (
        <div className="flex-shrink-0 h-full flex" style={{ width: panelWidth }}>
          {/* Resize handle */}
          <div
            className={`w-1 h-full cursor-ew-resize flex-shrink-0 ${darkMode ? 'hover:bg-blue-500/40' : 'hover:bg-blue-400/40'}`}
            onMouseDown={handlePanelResize}
          />
          <div className="flex-1 min-w-0 h-full overflow-hidden">
            <PlaylistPanel
              dragging={playlistDragging}
              dropRef={playlistDropRef}
              files={ps.files}
              currentIndex={ps.currentIndex}
              sortDestination={ps.sortDestination}
              viewedPaths={ps.viewedPaths}
              shuffleEnabled={ps.shuffleEnabled}
              skipViewedEnabled={ps.skipViewedEnabled}
              globalHotkeys={ps.globalHotkeys}
              paneDark={ps.paneDark}
              viewerDark={ps.viewerDark}
              isDocked={ps.isDocked}
              categories={ps.categories}
              stats={ps.stats}
              logEntries={ps.logEntries}
              sessionStartTime={ps.sessionStartTime}
              onSetShuffle={ps.setShuffleEnabled}
              onSetSkipViewed={ps.setSkipViewedEnabled}
              writeLogsEnabled={ps.writeLogsEnabled}
              onSetWriteLogs={ps.setWriteLogsEnabled}
              onSetGlobalHotkeys={ps.setGlobalHotkeys}
              onSetPaneDark={ps.setPaneDark}
              onSetViewerDark={(dark) => ps.handleViewerTheme(dark)}
              immerseEnabled={ps.immerseEnabled}
              onSetImmerse={ps.setImmerseEnabled}
              onToggleDocked={ps.handleToggleDocked}
              onNavigate={(action) => {
                if (action === 'next') navigateFile('next');
                else if (action === 'back') navigateFile('prev');
                else navigateFile('random');
              }}
              onJumpTo={(idx) => {
                ps.setCurrentIndex(idx);
                indexRef.current = idx;
                ps.setViewedPaths(prev => new Set(prev).add(filesRef.current[idx]?.fullPath));
                doExtract(filesRef.current[idx]?.fullPath);
                window.electronAPI?.broadcastState({ currentIndex: idx });
              }}
              renamingIndex={ps.renamingIndex}
              onSetRenamingIndex={ps.setRenamingIndex}
              onRename={ps.handleRename}
              onSort={ps.handleSort}
              onUndo={ps.handleUndo}
              canUndo={!!ps.lastUndo}
              onDeleteFiles={ps.handleDeleteFiles}
              onRemoveFromPlaylist={ps.handleRemoveFromPlaylist}
              compareMode={ps.compareMode}
              comparePickMode={ps.comparePickMode}
              comparePickTwoMode={ps.comparePickTwoMode}
              compareLeftIndex={ps.compareLeftIndex}
              compareFileIndex={ps.compareFileIndex}
              onCompareWithCurrent={ps.startCompareWithFile}
              onCycleComparePick={ps.cycleComparePick}
              onCancelComparePick={ps.cancelComparePick}
              onOpenSettings={() => setSettingsOpen(true)}
              initialLogHeight={savedLogHeight}
              onRepack={() => { if (images.length > 0) setRepackMode(true); }}
            />
          </div>
        </div>
      )}

      {/* Settings Modal */}
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => {
          // Reload settings from saved config
          window.electronAPI?.loadConfig().then((cfg: any) => {
            if (cfg.categories?.length > 0) ps.setCategories(cfg.categories);
            if (cfg.controlsHideDelay) setControlsHideDelay(cfg.controlsHideDelay);
            if (cfg.controlBarMode) setControlBarMode(cfg.controlBarMode);
            if (cfg.darkBgBrightness !== undefined) setDarkBgBrightness(cfg.darkBgBrightness);
            if (cfg.lightBgBrightness !== undefined) setLightBgBrightness(cfg.lightBgBrightness);
            if (cfg.repackColumns) setRepackColumns(cfg.repackColumns);
            if (cfg.repackThumbnailSize) setRepackThumbnailSize(cfg.repackThumbnailSize);
            if (cfg.repackPanelWidth) setRepackPanelWidth(cfg.repackPanelWidth);
            if (cfg.minLogSessionMinutes !== undefined) ps.setMinLogSessionMinutes(cfg.minLogSessionMinutes);
            (window as any).__cbzSettings = {
              beepOnLastPage: cfg.beepOnLastPage ?? true,
              beepVolume: cfg.beepVolume ?? 0.15,
              beepPitch: cfg.beepPitch ?? 600,
            };
          });
        }}
        darkMode={darkMode}
        onLiveBgChange={(dark, light) => {
          setDarkBgBrightness(dark);
          setLightBgBrightness(light);
        }}
      />
    </div>
  );
}

// ─── Playlist Window (thin IPC client — mirrors viewer state) ──────────────────

function PlaylistWindow() {
  // All state received from the viewer window via IPC
  const [state, setState] = useState<any>({
    files: [], currentIndex: 0, sortDestination: null, viewedPaths: [],
    shuffleEnabled: false, skipViewedEnabled: false, globalHotkeys: false,
    paneDark: true, viewerDark: true, isDocked: false,
    renamingIndex: null, compareMode: false, compareFileIndex: null,
    comparePickMode: false, comparePickTwoMode: false, compareLeftIndex: null,
  });

  // Receive state updates from viewer
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.onPlaylistStateUpdate((newState: any) => {
      setState(newState);
    });
    // Also handle legacy broadcasts for file loading
    window.electronAPI.onStateUpdate((s: any) => {
      // If viewer sends file updates, merge them
      if (s.files) setState((prev: any) => ({ ...prev, files: s.files, currentIndex: s.currentIndex ?? prev.currentIndex }));
    });
  }, []);

  // Helper: send action to viewer
  const send = useCallback((action: any) => {
    window.electronAPI?.sendPlaylistAction(action);
  }, []);

  // Drop on playlist = append (send to viewer to handle)
  const handleFilesLoaded = useCallback((loadedFiles: FileInfo[], sortDest: string | null) => {
    send({ type: 'filesAppended', files: loadedFiles, sortDestination: sortDest });
  }, [send]);

  const { dragging, containerRef } = useDropZone(handleFilesLoaded);

  const handleAction = useCallback((action: HotkeyAction) => {
    switch (action) {
      case 'next-file': send({ type: 'navigate', direction: 'next' }); break;
      case 'prev-file': send({ type: 'navigate', direction: 'back' }); break;
      case 'random-file': send({ type: 'navigate', direction: 'random' }); break;
      case 'rename': send({ type: 'startRenaming' }); break;
      case 'escape':
        if (state.compareMode) send({ type: 'exitCompare' });
        else if (state.comparePickMode || state.comparePickTwoMode) send({ type: 'cancelComparePick' });
        break;
      case 'enter-compare': send({ type: 'enterComparePickMode' }); break;
      case 'enter-repack': send({ type: 'repack' }); break;
      case 'toggle-shuffle': send({ type: 'setShuffle', value: !state.shuffleEnabled }); break;
      case 'randomize-playlist': send({ type: 'randomizePlaylist' }); break;
      case 'undo': send({ type: 'undo' }); break;
      case 'quit': window.electronAPI?.quitApp({
        paneDark: state.paneDark,
        viewerDark: state.viewerDark,
        isDocked: state.isDocked,
        pendingPurgeHeldPath: state.pendingPurgeHeldPath,
      }); break;
    }
  }, [send, state.compareMode, state.comparePickMode, state.comparePickTwoMode, state.paneDark, state.viewerDark, state.isDocked, state.shuffleEnabled]);

  useHotkeys({ onAction: handleAction });

  const viewedPathsSet = React.useMemo(() => new Set<string>(state.viewedPaths || []), [state.viewedPaths]);

  return (
    <div className="h-full w-full">
      <PlaylistPanel
        dragging={dragging}
        dropRef={containerRef}
        files={state.files}
        currentIndex={state.currentIndex}
        sortDestination={state.sortDestination}
        viewedPaths={viewedPathsSet}
        shuffleEnabled={state.shuffleEnabled}
        skipViewedEnabled={state.skipViewedEnabled}
        globalHotkeys={state.globalHotkeys}
        paneDark={state.paneDark}
        viewerDark={state.viewerDark}
        categories={state.categories}
        stats={state.stats}
        logEntries={state.logEntries}
        sessionStartTime={state.sessionStartTime}
        isDocked={state.isDocked}
        onSetShuffle={(v) => send({ type: 'setShuffle', value: v })}
        onSetSkipViewed={(v) => send({ type: 'setSkipViewed', value: v })}
        writeLogsEnabled={state.writeLogsEnabled}
        onSetWriteLogs={(v) => send({ type: 'setWriteLogs', value: v })}
        onSetGlobalHotkeys={(v) => send({ type: 'setGlobalHotkeys', value: v })}
        onSetPaneDark={(v) => send({ type: 'setPaneDark', value: v })}
        onSetViewerDark={(v) => send({ type: 'setViewerDark', value: v })}
        onToggleDocked={() => send({ type: 'toggleDocked' })}
        onNavigate={(dir) => send({ type: 'navigate', direction: dir })}
        onJumpTo={(idx) => send({ type: 'jumpTo', index: idx })}
        renamingIndex={state.renamingIndex}
        onSetRenamingIndex={(idx) => send({ type: 'setRenamingIndex', value: idx })}
        onRename={(oldPath, newName) => send({ type: 'rename', oldPath, newName })}
        onSort={(categoryId) => send({ type: 'sort', categoryId })}
        onUndo={() => send({ type: 'undo' })}
        canUndo={!!state.canUndo}
        onDeleteFiles={(paths) => send({ type: 'deleteFiles', paths })}
        onRemoveFromPlaylist={(paths) => send({ type: 'removeFromPlaylist', paths })}
        compareMode={state.compareMode}
        comparePickMode={state.comparePickMode}
        comparePickTwoMode={state.comparePickTwoMode}
        compareLeftIndex={state.compareLeftIndex}
        compareFileIndex={state.compareFileIndex}
        onCompareWithCurrent={(idx) => send({ type: 'compareWithCurrent', index: idx })}
        onCycleComparePick={() => send({ type: 'cycleComparePick' })}
        onCancelComparePick={() => send({ type: 'cancelComparePick' })}
        onOpenSettings={() => send({ type: 'openSettings' })}
        onRepack={() => send({ type: 'repack' })}
      />
    </div>
  );
}

// ─── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [windowType, setWindowType] = useState<'viewer' | 'playlist' | null>(null);

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.getWindowType().then(setWindowType);
    } else {
      const hash = window.location.hash;
      setWindowType(hash === '#playlist' ? 'playlist' : 'viewer');
    }
  }, []);

  if (!windowType) return null;
  return windowType === 'viewer' ? <ViewerWindow /> : <PlaylistWindow />;
}
