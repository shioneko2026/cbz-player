import React, { useState, useEffect, useCallback } from 'react';

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

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: () => void;
  darkMode: boolean;
  onLiveBgChange?: (darkBrightness: number, lightBrightness: number) => void;
}

type Tab = 'categories' | 'folders' | 'viewer' | 'repack' | 'ui';

export default function SettingsModal({ isOpen, onClose, onSaved, darkMode, onLiveBgChange }: SettingsModalProps) {
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
  const [loading, setLoading] = useState(true);

  // Load settings on open
  useEffect(() => {
    if (!isOpen || !window.electronAPI) return;
    window.electronAPI.loadSettings().then((config: any) => {
      setCategories(config.categories || []);
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

  const handleSave = useCallback(async () => {
    if (!window.electronAPI) return;
    await window.electronAPI.saveSettings({
      categories,
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
    });
    onSaved?.();
    onClose();
  }, [categories, viewerMode, controlsHideDelay, controlBarMode, defaultDocked, defaultPanelWidth, startFullscreen, darkBgBrightness, lightBgBrightness, useSourceFolder, customOutputFolder, beepOnLastPage, beepVolume, beepPitch, repackColumns, repackThumbnailSize, repackPanelWidth, onClose, onSaved]);

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
          {([['categories', 'Sort Categories'], ['folders', 'Folders'], ['viewer', 'Viewer'], ['repack', 'Repack'], ['ui', 'UI Behavior']] as const).map(([t, label]) => (
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
                return (
                  <div key={cat.id} className={`p-3 rounded border ${border} space-y-2`}>
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
              <button onClick={resetUI} className="mt-2 text-xs text-red-400 hover:text-red-300">
                Reset UI settings to defaults
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`px-6 py-3 border-t ${border} flex justify-end gap-2`}>
          <button onClick={onClose} className={`px-4 py-1.5 rounded text-sm ${darkMode ? 'bg-zinc-700 hover:bg-zinc-600' : 'bg-zinc-200 hover:bg-zinc-300'}`}>
            Cancel
          </button>
          <button onClick={handleSave} className="px-4 py-1.5 rounded text-sm bg-blue-600 hover:bg-blue-500 text-white">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
