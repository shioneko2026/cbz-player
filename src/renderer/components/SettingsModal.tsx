import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getShortcutGroups } from '../lib/shortcuts';

interface CategoryConfig {
  id: string;
  label: string;
  folderName: string;
  hotkey: string;
  color: string;
  parentCategory?: string;
  dupeFolderName?: string;
  isPurge?: boolean;
  outputPath?: string;
}

// Matches the backend regex (src/main/index.ts) — any Windows-illegal
// filename char (including control chars). Forward slash is legal inside
// a path though, so we test per-segment and allow the path separator.
const ILLEGAL_FS_CHAR_IN_SEGMENT = /[<>:"|?*\x00-\x1f]/;

function validateOverrideSync(raw: string): string[] {
  const errors: string[] = [];
  const p = (raw ?? '').trim();
  if (!p) return errors; // empty = no override, no errors

  // Absolute-path check: reject relative inputs like ".\foo" or "../bar"
  // Accept Windows drive-letter paths (C:\…) and UNC paths (\\server\share).
  const isAbsoluteWin = /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p);
  if (!isAbsoluteWin) {
    errors.push('Must be an absolute path (e.g. D:\\Archive or \\\\server\\share)');
  }

  // Illegal-char check per segment (skip the drive letter's colon).
  const stripped = /^[a-zA-Z]:[\\/]?/.test(p) ? p.slice(p.indexOf(':') + 1) : p;
  const segments = stripped.split(/[\\/]/).filter(Boolean);
  const badChars = new Set<string>();
  for (const seg of segments) {
    for (const ch of seg) {
      if (ILLEGAL_FS_CHAR_IN_SEGMENT.test(ch)) {
        const code = ch.charCodeAt(0);
        badChars.add(code < 0x20 ? `\\x${code.toString(16).padStart(2, '0')}` : ch);
      }
    }
  }
  if (badChars.size > 0) {
    errors.push(`Remove illegal characters: ${[...badChars].join(' ')}`);
  }

  return errors;
}

function normalizeOverride(raw: string): string {
  return (raw ?? '').trim().replace(/[\\/]+$/, '');
}

function buildResolvedPath(outputPath: string, category: CategoryConfig, categories: CategoryConfig[]): string {
  const base = outputPath.replace(/[\\/]+$/, '');
  // Override skips parent nesting (matches backend sortFile logic)
  return `${base}\\${category.folderName}`;
}

function findFinalPathCollisions(categories: CategoryConfig[]): Set<string> {
  // Returns the set of category ids whose resolved final path matches another's.
  const counts = new Map<string, string[]>();
  for (const c of categories) {
    if (c.isPurge || !c.outputPath?.trim() || !c.folderName) continue;
    const key = buildResolvedPath(c.outputPath, c, categories).toLowerCase();
    const ids = counts.get(key) ?? [];
    ids.push(c.id);
    counts.set(key, ids);
  }
  const colliding = new Set<string>();
  for (const ids of counts.values()) {
    if (ids.length > 1) ids.forEach(id => colliding.add(id));
  }
  return colliding;
}

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: () => void;
  darkMode: boolean;
  onLiveBgChange?: (darkBrightness: number, lightBrightness: number) => void;
  // Thumb List layout is applied and persisted live by App, NOT through this
  // modal's save payload. Keeping it out of the snapshot is what stops a
  // Settings save from clobbering a value the playlist panel owns.
  thumbLayout?: 'small' | 'large' | 'cover';
  onSetThumbLayout?: (v: 'small' | 'large' | 'cover') => void;
}

type Tab = 'categories' | 'folders' | 'viewer' | 'repack' | 'ui' | 'logging' | 'shortcuts';

export default function SettingsModal({ isOpen, onClose, onSaved, darkMode, onLiveBgChange, thumbLayout, onSetThumbLayout }: SettingsModalProps) {
  const [thumbCache, setThumbCache] = useState<{ fileCount: number; totalBytes: number } | null>(null);
  const [clearingThumbs, setClearingThumbs] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    window.electronAPI?.getThumbCacheStats?.().then(setThumbCache).catch(() => setThumbCache(null));
  }, [isOpen]);
  const [tab, setTab] = useState<Tab>('categories');
  const [categories, setCategories] = useState<CategoryConfig[]>([]);
  const [viewerMode, setViewerMode] = useState('single');
  const [controlsHideDelay, setControlsHideDelay] = useState(1500);
  const [controlBarMode, setControlBarMode] = useState<'auto-hide' | 'hover-only' | 'always-visible'>('auto-hide');
  const [defaultDocked, setDefaultDocked] = useState(false);
  const [defaultPanelWidth, setDefaultPanelWidth] = useState(320);
  const [startFullscreen, setStartFullscreen] = useState(false);
  const [darkBgBrightness, setDarkBgBrightness] = useState(26); // 0x1A = 26
  const [lightBgBrightness, setLightBgBrightness] = useState(232); // 0xE8 = 232
  const [useSourceFolder, setUseSourceFolder] = useState(true);
  const [customOutputFolder, setCustomOutputFolder] = useState('');
  const [beepOnLastPage, setBeepOnLastPage] = useState(true);
  const [beepVolume, setBeepVolume] = useState(0.15);
  const [beepPitch, setBeepPitch] = useState(600);
  const [repackColumns, setRepackColumns] = useState(3);
  const [repackThumbnailSize, setRepackThumbnailSize] = useState(150);
  const [repackPanelWidth, setRepackPanelWidth] = useState(40);
  const [minLogSessionMinutes, setMinLogSessionMinutes] = useState(5);
  const [loading, setLoading] = useState(true);
  // Async fs validation results for each category's outputPath, keyed by category id.
  // Updated on load, on blur of the override input, and when Browse picks a folder.
  // Sync validation (illegal chars, relative paths) is derived from `categories` via useMemo.
  const [pathValidation, setPathValidation] = useState<Record<string, { exists: boolean; isFile: boolean; rootExists: boolean }>>({});

  const runAsyncValidation = useCallback(async (catId: string, p: string) => {
    if (!window.electronAPI || !p.trim()) {
      setPathValidation(prev => {
        const next = { ...prev };
        delete next[catId];
        return next;
      });
      return;
    }
    const api = window.electronAPI as any;
    if (typeof api.validatePath !== 'function') return;
    try {
      const result = await api.validatePath(p);
      setPathValidation(prev => ({ ...prev, [catId]: result }));
    } catch {
      // IPC failure — leave previous state, the sort itself will surface the real error
    }
  }, []);

  // Load settings on open
  useEffect(() => {
    if (!isOpen || !window.electronAPI) return;
    window.electronAPI.loadSettings().then((config: any) => {
      const loadedCats: CategoryConfig[] = config.categories || [];
      setCategories(loadedCats);
      // Pre-validate any existing overrides so warnings (e.g. drive missing) show immediately.
      for (const c of loadedCats) {
        if (c.outputPath?.trim()) runAsyncValidation(c.id, c.outputPath);
      }
      setUseSourceFolder(config.useSourceFolder ?? true);
      setCustomOutputFolder(config.customOutputFolder ?? '');
      setViewerMode(config.viewerMode || 'single');
      setControlsHideDelay(config.controlsHideDelay ?? 1500);
      setControlBarMode(config.controlBarMode ?? 'auto-hide');
      setDefaultDocked(config.isDocked ?? false);
      setDefaultPanelWidth(config.dockedPanelWidth ?? 320);
      setStartFullscreen(config.startFullscreen ?? false);
      setDarkBgBrightness(config.darkBgBrightness ?? 26);
      setLightBgBrightness(config.lightBgBrightness ?? 232);
      setBeepOnLastPage(config.beepOnLastPage ?? true);
      setBeepVolume(config.beepVolume ?? 0.15);
      setBeepPitch(config.beepPitch ?? 600);
      setRepackColumns(config.repackColumns ?? 3);
      setRepackThumbnailSize(config.repackThumbnailSize ?? 150);
      setRepackPanelWidth(config.repackPanelWidth ?? 40);
      setMinLogSessionMinutes(config.minLogSessionMinutes ?? 5);
      setLoading(false);
    });
  }, [isOpen]);

  const DEFAULT_CATEGORIES: CategoryConfig[] = [
    { id: 'keep', label: 'Keep', folderName: '[00-Keep]', hotkey: 'k', color: 'emerald', dupeFolderName: '[Keep Dupes]' },
    { id: 'purge', label: 'Purge', folderName: '', hotkey: 'p', color: 'red', isPurge: true },
    { id: 'fix', label: 'To Fix', folderName: '[Needs Fixing]', hotkey: 'f', color: 'amber', dupeFolderName: '[Fix Dupes]' },
    { id: 'translate', label: 'Translate', folderName: '[To Be Translated OG]', hotkey: 't', color: 'sky', dupeFolderName: '[To Be TL Dupes]' },
    { id: 'inquire', label: 'Inquire', folderName: '[00-Inquire]', hotkey: 'i', color: 'purple', parentCategory: 'keep' },
    { id: 'unreadable', label: 'Unreadable', folderName: '[File Name Too Long]', hotkey: 'u', color: 'rose' },
  ];

  const resetCategories = () => setCategories([...DEFAULT_CATEGORIES]);
  const resetFolders = () => { setUseSourceFolder(true); setCustomOutputFolder(''); };
  const resetViewer = () => { setViewerMode('single'); setControlsHideDelay(1500); setControlBarMode('auto-hide'); setBeepOnLastPage(true); setBeepVolume(0.15); setBeepPitch(600); };
  const resetRepack = () => { setRepackColumns(3); setRepackThumbnailSize(150); setRepackPanelWidth(40); };
  const resetUI = () => { setDefaultDocked(false); setDefaultPanelWidth(320); setStartFullscreen(false); setDarkBgBrightness(26); setLightBgBrightness(232); };
  const resetLogging = () => { setMinLogSessionMinutes(5); };

  // Per-category sync errors (illegal chars, relative path) — pure derivation, recomputes on every render.
  const syncErrorsByCat = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const c of categories) {
      out[c.id] = c.outputPath ? validateOverrideSync(c.outputPath) : [];
    }
    return out;
  }, [categories]);

  const collidingIds = useMemo(() => findFinalPathCollisions(categories), [categories]);

  // Save is blocked when any override has sync errors or points at a file (not a directory).
  const hasBlockingErrors = useMemo(() => {
    return categories.some(c => {
      if (syncErrorsByCat[c.id]?.length > 0) return true;
      const v = pathValidation[c.id];
      if (v && v.exists && v.isFile) return true;
      return false;
    });
  }, [categories, syncErrorsByCat, pathValidation]);

  const handleSave = useCallback(async () => {
    if (!window.electronAPI || hasBlockingErrors) return;
    // Normalize outputPaths: trim + strip trailing separators. Empty → field removed.
    const normalizedCategories = categories.map(c => {
      if (!('outputPath' in c)) return c;
      const cleaned = normalizeOverride(c.outputPath ?? '');
      const { outputPath, ...rest } = c;
      return cleaned ? { ...rest, outputPath: cleaned } : rest;
    });
    await window.electronAPI.saveSettings({
      categories: normalizedCategories,
      viewerMode,
      controlsHideDelay,
      controlBarMode,
      isDocked: defaultDocked,
      dockedPanelWidth: defaultPanelWidth,
      startFullscreen,
      darkBgBrightness,
      lightBgBrightness,
      useSourceFolder,
      customOutputFolder,
      beepOnLastPage,
      beepVolume,
      beepPitch,
      repackColumns,
      repackThumbnailSize,
      repackPanelWidth,
      minLogSessionMinutes,
    });
    onSaved?.();
    onClose();
  }, [categories, hasBlockingErrors, viewerMode, controlsHideDelay, controlBarMode, defaultDocked, defaultPanelWidth, startFullscreen, darkBgBrightness, lightBgBrightness, useSourceFolder, customOutputFolder, beepOnLastPage, beepVolume, beepPitch, repackColumns, repackThumbnailSize, repackPanelWidth, minLogSessionMinutes, onClose, onSaved]);

  const updateCategory = (index: number, field: string, value: string) => {
    setCategories(prev => prev.map((c, i) => i === index ? { ...c, [field]: value } : c));
  };

  const addCategory = () => {
    const id = `custom_${Date.now()}`;
    setCategories(prev => [...prev, {
      id, label: 'New Category', folderName: '[New Category]', hotkey: '',
      color: 'zinc', dupeFolderName: '',
    }]);
  };

  const removeCategory = (index: number) => {
    const cat = categories[index];
    if (cat.id === 'keep' || cat.id === 'purge') return; // Can't remove these
    setCategories(prev => prev.filter((_, i) => i !== index));
    // Drop any cached async validation for the removed category
    setPathValidation(prev => {
      const next = { ...prev };
      delete next[cat.id];
      return next;
    });
  };

  const handleOverrideBrowse = async (index: number) => {
    const folder = await window.electronAPI?.pickFolder();
    if (!folder) return;
    const cat = categories[index];
    updateCategory(index, 'outputPath', folder);
    runAsyncValidation(cat.id, folder);
  };

  const handleOverrideClear = (index: number) => {
    const cat = categories[index];
    updateCategory(index, 'outputPath', '');
    setPathValidation(prev => {
      const next = { ...prev };
      delete next[cat.id];
      return next;
    });
  };

  if (!isOpen) return null;

  const bg = darkMode ? 'bg-zinc-900' : 'bg-white';
  const border = darkMode ? 'border-zinc-700' : 'border-zinc-300';
  const text = darkMode ? 'text-zinc-100' : 'text-zinc-900';
  const subtext = darkMode ? 'text-zinc-400' : 'text-zinc-600';
  const inputBg = darkMode ? 'bg-zinc-800 border-zinc-700 text-zinc-100' : 'bg-zinc-100 border-zinc-300 text-zinc-900';
  const tabActive = darkMode ? 'bg-zinc-700 text-white' : 'bg-zinc-200 text-zinc-900';
  const tabInactive = darkMode ? 'text-zinc-400 hover:bg-zinc-800' : 'text-zinc-600 hover:bg-zinc-100';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`${bg} ${text} rounded-lg shadow-2xl border ${border} w-[600px] max-h-[80vh] flex flex-col`} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
        {/* Header */}
        <div className={`px-6 py-4 border-b ${border} flex justify-between items-center`}>
          <h2 className="text-lg font-semibold">Settings</h2>
          <button onClick={onClose} className={`${subtext} hover:${text} text-xl`}>✕</button>
        </div>

        {/* Tabs */}
        <div className={`px-6 py-2 border-b ${border} flex gap-1`}>
          {([['categories', 'Sort Categories'], ['folders', 'Folders'], ['viewer', 'Viewer'], ['repack', 'Repack'], ['ui', 'UI Behavior'], ['logging', 'Logging'], ['shortcuts', 'Shortcuts']] as const).map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 rounded text-sm ${tab === t ? tabActive : tabInactive}`}>
              {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
          {loading ? (
            <p className={subtext}>Loading...</p>
          ) : tab === 'categories' ? (
            <div className="space-y-3">
              {categories.map((cat, i) => {
                const locked = cat.id === 'keep' || cat.id === 'purge';
                const overrideRaw = cat.outputPath ?? '';
                const hasOverride = !!overrideRaw.trim();
                const syncErrors = syncErrorsByCat[cat.id] ?? [];
                const asyncCheck = pathValidation[cat.id];
                const isFileError = !!(hasOverride && asyncCheck?.exists && asyncCheck.isFile);
                const driveMissingWarning = !!(hasOverride && asyncCheck && !asyncCheck.rootExists);
                const collisionWarning = collidingIds.has(cat.id);
                return (
                  <div key={cat.id} className={`p-3 rounded border ${border} space-y-2 transition-shadow ${hasOverride ? 'ring-2 ring-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.45)]' : ''}`}>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs ${subtext} w-16`}>Label</span>
                      <input value={cat.label} onChange={e => updateCategory(i, 'label', e.target.value)}
                        className={`flex-1 text-sm px-2 py-1 rounded border ${inputBg}`} />
                      {!locked && (
                        <button onClick={() => removeCategory(i)} className="text-red-400 text-xs hover:text-red-300">Remove</button>
                      )}
                      {locked && <span className="text-xs text-zinc-500">Locked</span>}
                    </div>
                    {!cat.isPurge && (
                      <div className="flex items-center gap-2">
                        <span className={`text-xs ${subtext} w-16`}>Folder</span>
                        <input value={cat.folderName} onChange={e => updateCategory(i, 'folderName', e.target.value)}
                          className={`flex-1 text-sm px-2 py-1 rounded border ${inputBg}`} />
                      </div>
                    )}
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs ${subtext} w-16`}>Hotkey</span>
                        <input value={cat.hotkey} maxLength={1} onChange={e => updateCategory(i, 'hotkey', e.target.value.toLowerCase())}
                          className={`w-12 text-sm text-center px-2 py-1 rounded border ${inputBg}`} />
                      </div>
                      {cat.dupeFolderName !== undefined && !cat.isPurge && (
                        <div className="flex items-center gap-2">
                          <span className={`text-xs ${subtext}`}>Dupe Folder</span>
                          <input value={cat.dupeFolderName || ''} onChange={e => updateCategory(i, 'dupeFolderName', e.target.value)}
                            className={`flex-1 text-sm px-2 py-1 rounded border ${inputBg}`} />
                        </div>
                      )}
                    </div>
                    {!cat.isPurge && (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs ${subtext} w-16`} title="Optional. When set, this category's files go here instead of the default from the Folders tab.">
                            Override
                          </span>
                          <input
                            value={overrideRaw}
                            onChange={e => updateCategory(i, 'outputPath', e.target.value)}
                            onBlur={() => runAsyncValidation(cat.id, overrideRaw)}
                            placeholder="Leave blank to use default from Folders tab"
                            className={`flex-1 text-sm px-2 py-1 rounded border ${inputBg}`}
                          />
                          <button
                            onClick={() => handleOverrideBrowse(i)}
                            className={`px-2 py-1 rounded text-xs ${darkMode ? 'bg-zinc-700 hover:bg-zinc-600' : 'bg-zinc-200 hover:bg-zinc-300'}`}
                            title="Pick a folder"
                          >
                            Browse...
                          </button>
                          {hasOverride && (
                            <button
                              onClick={() => handleOverrideClear(i)}
                              className={`px-2 py-1 rounded text-xs ${darkMode ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300' : 'bg-zinc-200 hover:bg-zinc-300 text-zinc-700'}`}
                              title="Clear override (revert to default)"
                            >
                              ×
                            </button>
                          )}
                        </div>
                        {hasOverride && cat.folderName && syncErrors.length === 0 && !isFileError && (
                          <p className={`text-xs ${subtext} pl-[4.5rem] break-all`}>
                            → {buildResolvedPath(overrideRaw, cat, categories)}
                          </p>
                        )}
                        {syncErrors.map((msg, idx) => (
                          <p key={`err-${idx}`} className="text-xs text-red-400 pl-[4.5rem]">{msg}</p>
                        ))}
                        {isFileError && (
                          <p className="text-xs text-red-400 pl-[4.5rem]">Path points to a file, not a folder</p>
                        )}
                        {driveMissingWarning && (
                          <p className="text-xs text-amber-400 pl-[4.5rem]">
                            Drive isn't mounted — sorts to this category will fail until the drive comes online
                          </p>
                        )}
                        {collisionWarning && (
                          <p className="text-xs text-amber-400 pl-[4.5rem]">
                            Another category resolves to the same final path — sorts may overwrite each other
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              <button onClick={addCategory} className={`w-full py-2 rounded border border-dashed ${border} text-sm ${subtext} hover:${text}`}>
                + Add Category
              </button>
              <button onClick={resetCategories} className="mt-2 text-xs text-red-400 hover:text-red-300">
                Reset categories to defaults
              </button>
            </div>
          ) : tab === 'folders' ? (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <label className={`text-sm font-medium ${text}`}>Put categories in source folder</label>
                  <p className={`text-xs mt-1 ${subtext}`}>
                    When enabled, sort folders (Keep, Needs Fixing, etc.) are created next to the source CBZ files — wherever they came from. Each source folder gets its own set of category subfolders.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={useSourceFolder}
                  onChange={e => setUseSourceFolder(e.target.checked)}
                  className="accent-blue-500 mt-1 flex-shrink-0"
                />
              </div>

              {!useSourceFolder && (
                <div className={`p-3 rounded border ${border} space-y-2`}>
                  <label className={`text-sm ${subtext} block`}>Custom output folder</label>
                  <p className={`text-xs ${subtext}`}>
                    All sorted files will be moved into category subfolders within this folder, regardless of where the source CBZ files are located.
                  </p>
                  <div className="flex gap-2">
                    <input
                      value={customOutputFolder}
                      onChange={e => setCustomOutputFolder(e.target.value)}
                      placeholder="Select a folder..."
                      readOnly
                      className={`flex-1 text-sm px-2 py-1.5 rounded border ${inputBg} cursor-pointer`}
                      onClick={async () => {
                        const folder = await window.electronAPI?.pickFolder();
                        if (folder) setCustomOutputFolder(folder);
                      }}
                    />
                    <button
                      onClick={async () => {
                        const folder = await window.electronAPI?.pickFolder();
                        if (folder) setCustomOutputFolder(folder);
                      }}
                      className={`px-3 py-1.5 rounded text-sm ${darkMode ? 'bg-zinc-700 hover:bg-zinc-600' : 'bg-zinc-200 hover:bg-zinc-300'}`}
                    >
                      Browse...
                    </button>
                  </div>
                  {customOutputFolder && (
                    <p className={`text-xs ${subtext} break-all`}>Selected: {customOutputFolder}</p>
                  )}
                </div>
              )}
              <button onClick={resetFolders} className="mt-2 text-xs text-red-400 hover:text-red-300">
                Reset folder settings to defaults
              </button>
            </div>
          ) : tab === 'viewer' ? (
            <div className="space-y-4">
              <div>
                <label className={`text-sm ${subtext} block mb-1`}>Default View Mode</label>
                <select value={viewerMode} onChange={e => setViewerMode(e.target.value)}
                  className={`w-full text-sm px-2 py-1.5 rounded border ${inputBg}`}>
                  <option value="single">Single Page</option>
                  <option value="dual-ltr">Dual LTR</option>
                  <option value="dual-rtl">Dual RTL</option>
                  <option value="scroll">Vertical Scroll</option>
                </select>
              </div>
              <div>
                <label className={`text-sm ${subtext} block mb-1`}>Controls Bar Mode</label>
                <select value={controlBarMode} onChange={e => setControlBarMode(e.target.value as any)}
                  className={`w-full text-sm px-2 py-1.5 rounded border ${inputBg}`}>
                  <option value="auto-hide">Auto-hide — shows on mouse move, fades after delay</option>
                  <option value="hover-only">Hover only — hidden until you hover near the bottom</option>
                  <option value="always-visible">Always visible — docked at bottom, not overlapping</option>
                </select>
              </div>
              {controlBarMode === 'auto-hide' && (
                <div>
                  <label className={`text-sm ${subtext} block mb-1`}>Controls Bar Auto-Hide Delay (ms)</label>
                  <input type="number" value={controlsHideDelay} onChange={e => setControlsHideDelay(Number(e.target.value))}
                    min={500} max={10000} step={100}
                    className={`w-full text-sm px-2 py-1.5 rounded border ${inputBg}`} />
                </div>
              )}
              <div className={`p-3 rounded border ${border} space-y-3`}>
                <div className="flex items-center justify-between">
                  <label className={`text-sm ${subtext}`}>Beep on Last Page</label>
                  <input type="checkbox" checked={beepOnLastPage} onChange={e => setBeepOnLastPage(e.target.checked)} className="accent-blue-500" />
                </div>
                {beepOnLastPage && (
                  <>
                    <div>
                      <label className={`text-sm ${subtext} block mb-1`}>Volume ({Math.round(beepVolume * 100)}%)</label>
                      <input type="range" value={beepVolume} onChange={e => setBeepVolume(Number(e.target.value))}
                        min={0.05} max={1} step={0.05}
                        className="w-full accent-blue-500" />
                    </div>
                    <div>
                      <label className={`text-sm ${subtext} block mb-1`}>Pitch ({beepPitch} Hz)</label>
                      <input type="range" value={beepPitch} onChange={e => setBeepPitch(Number(e.target.value))}
                        min={200} max={2000} step={50}
                        className="w-full accent-blue-500" />
                    </div>
                    <button
                      onClick={() => {
                        try {
                          const ctx = new AudioContext();
                          const osc = ctx.createOscillator();
                          const gain = ctx.createGain();
                          osc.type = 'sine';
                          osc.frequency.value = beepPitch;
                          gain.gain.value = beepVolume;
                          osc.connect(gain);
                          gain.connect(ctx.destination);
                          osc.start();
                          osc.stop(ctx.currentTime + 0.15);
                          setTimeout(() => ctx.close(), 300);
                        } catch {}
                      }}
                      className={`text-xs px-3 py-1 rounded ${darkMode ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200' : 'bg-zinc-200 hover:bg-zinc-300 text-zinc-800'}`}
                    >
                      Test Beep
                    </button>
                  </>
                )}
              </div>
              <button onClick={resetViewer} className="mt-2 text-xs text-red-400 hover:text-red-300">
                Reset viewer settings to defaults
              </button>
            </div>
          ) : tab === 'repack' ? (
            <div className="space-y-4">
              <p className={`text-sm ${subtext}`}>
                Repack settings are controlled directly in the repack view. Drag the panel border to resize, and use the column control in the action bar.
              </p>
              <button onClick={resetRepack} className="mt-2 text-xs text-red-400 hover:text-red-300">
                Reset repack settings to defaults
              </button>
            </div>
          ) : tab === 'logging' ? (
            <div className="space-y-4">
              <div>
                <label className={`text-sm ${subtext} block mb-1`}>Minimum session length to write log (minutes)</label>
                <p className={`text-xs ${subtext} mb-2`}>
                  Sessions shorter than this won't be written to the session log on Ctrl+Q. Useful for skipping quick checks where you opened the app, looked at something, then exited. Set to 0 to log every session.
                </p>
                <input type="number" value={minLogSessionMinutes} onChange={e => setMinLogSessionMinutes(Math.max(0, Number(e.target.value)))}
                  min={0} max={120} step={1}
                  className={`w-full text-sm px-2 py-1.5 rounded border ${inputBg}`} />
              </div>
              <div className={`p-3 rounded border ${border}`}>
                <p className={`text-xs ${subtext}`}>
                  The <strong className={text}>Write Logs</strong> toggle (in the playlist panel header) controls whether logging is on at all. The minimum length here only matters when that toggle is enabled and a sort destination is set.
                </p>
              </div>
              <button onClick={resetLogging} className="mt-2 text-xs text-red-400 hover:text-red-300">
                Reset logging settings to defaults
              </button>
            </div>
          ) : tab === 'shortcuts' ? (
            <div className="space-y-4 text-sm">
              <p className={`${subtext}`}>
                Reference for all keyboard shortcuts (press <strong>F1</strong> anywhere for this same
                list as a quick overlay). These are defined in code — this tab doesn't edit them.
              </p>
              {getShortcutGroups(categories).map(([group, rows]) => (
                <div key={group} className={`p-3 rounded border ${border}`}>
                  <h4 className={`text-xs font-semibold uppercase tracking-wide ${subtext} mb-2`}>{group}</h4>
                  {rows.length === 0 ? (
                    <p className={`text-xs italic ${subtext}`}>No shortcuts configured.</p>
                  ) : (
                    <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                      {rows.map(([key, label]) => (
                        <React.Fragment key={`${group}-${key}-${label}`}>
                          <kbd className={`text-xs font-mono px-1.5 py-0.5 rounded border ${darkMode ? 'bg-zinc-800 border-zinc-700 text-zinc-200' : 'bg-zinc-100 border-zinc-300 text-zinc-800'} whitespace-nowrap`}>
                            {key}
                          </kbd>
                          <span className={`text-xs ${text}`}>{label}</span>
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <label className={`text-sm ${subtext}`}>Start in Docked Mode</label>
                <input type="checkbox" checked={defaultDocked} onChange={e => setDefaultDocked(e.target.checked)} className="accent-blue-500" />
              </div>
              <div className="flex items-center justify-between">
                <label className={`text-sm ${subtext}`}>Start in Fullscreen Mode</label>
                <input type="checkbox" checked={startFullscreen} onChange={e => setStartFullscreen(e.target.checked)} className="accent-blue-500" />
              </div>
              <div>
                <label className={`text-sm ${subtext} block mb-1`}>Default Panel Width (px)</label>
                <input type="number" value={defaultPanelWidth} onChange={e => setDefaultPanelWidth(Number(e.target.value))}
                  min={280} max={600} step={10}
                  className={`w-full text-sm px-2 py-1.5 rounded border ${inputBg}`} />
              </div>
              <div>
                <label className={`text-sm ${subtext} block mb-1`}>Dark Mode Background</label>
                <div className="flex items-center gap-3">
                  <input type="range" value={darkBgBrightness} onChange={e => {
                    const v = Number(e.target.value);
                    setDarkBgBrightness(v);
                    onLiveBgChange?.(v, lightBgBrightness);
                  }} min={26} max={45} step={1} className="flex-1 accent-blue-500" />
                  <div className="w-8 h-8 rounded border border-zinc-600" style={{ backgroundColor: `rgb(${darkBgBrightness},${darkBgBrightness},${darkBgBrightness})` }} />
                  <span className={`text-xs tabular-nums ${subtext}`}>#{darkBgBrightness.toString(16).padStart(2,'0').repeat(3).toUpperCase()}</span>
                </div>
              </div>
              <div>
                <label className={`text-sm ${subtext} block mb-1`}>Light Mode Background</label>
                <div className="flex items-center gap-3">
                  <input type="range" value={lightBgBrightness} onChange={e => {
                    const v = Number(e.target.value);
                    setLightBgBrightness(v);
                    onLiveBgChange?.(darkBgBrightness, v);
                  }} min={216} max={232} step={1} className="flex-1 accent-blue-500" />
                  <div className="w-8 h-8 rounded border border-zinc-300" style={{ backgroundColor: `rgb(${lightBgBrightness},${lightBgBrightness},${lightBgBrightness})` }} />
                  <span className={`text-xs tabular-nums ${subtext}`}>#{lightBgBrightness.toString(16).padStart(2,'0').repeat(3).toUpperCase()}</span>
                </div>
              </div>
              <div className={`p-3 rounded border ${border} space-y-3`}>
                <div>
                  <label className={`text-sm ${text} block mb-1`}>Thumb List cover size</label>
                  <p className={`text-xs ${subtext} mb-2`}>
                    How big each cover is when <strong className={text}>Thumb List</strong> is on (toggle lives in the playlist panel).
                    All three sizes use the same stored cover, so switching is instant and nothing is regenerated.
                  </p>
                  <div className="flex gap-2">
                    {([
                      ['small', 'Small', 'Cover beside the name — most files per screen'],
                      ['large', 'Large', 'Bigger cover beside the name'],
                      ['cover', 'Cover above', 'Full-width cover with the name underneath'],
                    ] as const).map(([value, label, hint]) => (
                      <button
                        key={value}
                        onClick={() => onSetThumbLayout?.(value)}
                        title={hint}
                        className={`flex-1 text-xs px-2 py-1.5 rounded border transition-colors ${
                          (thumbLayout ?? 'small') === value
                            ? 'border-blue-500 text-blue-400'
                            : `${border} ${subtext} hover:text-zinc-300`
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className={`text-sm ${text}`}>Stored covers</p>
                    <p className={`text-xs ${subtext}`}>
                      {thumbCache
                        ? `${thumbCache.fileCount.toLocaleString('en-GB')} covers · ${(thumbCache.totalBytes / 1048576).toFixed(1)} MB (capped at 500 MB)`
                        : 'Reading…'}
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      setClearingThumbs(true);
                      try {
                        const stats = await window.electronAPI?.clearThumbCache?.();
                        setThumbCache(stats ?? { fileCount: 0, totalBytes: 0 });
                      } finally {
                        setClearingThumbs(false);
                      }
                    }}
                    disabled={clearingThumbs}
                    className={`text-xs px-2 py-1.5 rounded border ${border} ${subtext} hover:text-zinc-300 disabled:opacity-50`}
                  >
                    {clearingThumbs ? 'Clearing…' : 'Clear cover cache'}
                  </button>
                </div>
              </div>
              <button onClick={resetUI} className="mt-2 text-xs text-red-400 hover:text-red-300">
                Reset UI settings to defaults
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`px-6 py-3 border-t ${border} flex justify-end items-center gap-3`}>
          {hasBlockingErrors && (
            <span className="text-xs text-red-400 mr-auto">Fix override errors before saving</span>
          )}
          <button onClick={onClose} className={`px-4 py-1.5 rounded text-sm ${darkMode ? 'bg-zinc-700 hover:bg-zinc-600' : 'bg-zinc-200 hover:bg-zinc-300'}`}>
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={hasBlockingErrors}
            className={`px-4 py-1.5 rounded text-sm text-white ${hasBlockingErrors ? 'bg-blue-600/40 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500'}`}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
