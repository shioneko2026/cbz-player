import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Window identity
  getWindowType: () => ipcRenderer.invoke('window:get-type'),

  // State sync
  onStateUpdate: (callback: (state: any) => void) => {
    ipcRenderer.on('state:update', (_event, state) => callback(state));
  },
  broadcastState: (state: any) => ipcRenderer.send('state:broadcast', state),

  // Hotkeys
  onHotkeyTriggered: (callback: (action: string) => void) => {
    ipcRenderer.on('hotkey:triggered', (_event, action) => callback(action));
  },

  // Theme
  setViewerTheme: (dark: boolean) => ipcRenderer.send('viewer:set-theme', dark),
  onViewerThemeChanged: (callback: (dark: boolean) => void) => {
    ipcRenderer.on('viewer:theme-changed', (_event, dark) => callback(dark));
  },

  // File loading
  loadFolder: (folderPath: string) => ipcRenderer.invoke('files:load-folder', folderPath),
  loadPaths: (filePaths: string[]) => ipcRenderer.invoke('files:load-paths', filePaths),
  pickFolder: () => ipcRenderer.invoke('files:pick-folder'),
  validatePath: (p: string) => ipcRenderer.invoke('files:validate-path', p) as Promise<{ exists: boolean; isFile: boolean; rootExists: boolean }>,
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // File operations
  sortFile: (filePath: string, categoryId: string, sortDest: string) => ipcRenderer.invoke('file:sort', filePath, categoryId, sortDest),
  renameFile: (oldPath: string, newName: string) => ipcRenderer.invoke('file:rename', oldPath, newName),
  trashFiles: (paths: string[]) => ipcRenderer.invoke('file:trash', paths),

  // CBZ extraction (slot defaults to 'main', compare mode uses 'compare-left'/'compare-right')
  extractCbz: (cbzPath: string, slot?: string) => ipcRenderer.invoke('cbz:extract', cbzPath, slot),
  cleanupCbz: (slot?: string) => ipcRenderer.invoke('cbz:cleanup', slot),
  repackCbz: (originalPath: string, slot: string, keepIndices: number[], renames: Record<string, string>, folderName?: string, newFileName?: string) =>
    ipcRenderer.invoke('cbz:repack', originalPath, slot, keepIndices, renames, folderName, newFileName),
  onExtractionProgress: (callback: (progress: { percent: number; status: string }) => void) => {
    ipcRenderer.on('cbz:extract-progress', (_event, progress) => callback(progress));
  },

  // Config
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveUiState: (state: any) => ipcRenderer.send('config:save-ui', state),

  // Settings
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings: any) => ipcRenderer.invoke('settings:save', settings),

  // Menu actions
  onMenuAction: (callback: (action: string) => void) => {
    ipcRenderer.on('menu:action', (_event, action) => callback(action));
  },

  // Window controls
  toggleFullscreen: () => ipcRenderer.send('window:toggle-fullscreen'),
  exitFullscreen: () => ipcRenderer.send('window:exit-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),

  // App lifecycle
  quitApp: (uiState?: any) => ipcRenderer.send('app:quit', uiState),

  // Layout mode
  setDockedMode: (docked: boolean) => ipcRenderer.send('layout:set-docked', docked),
  onDockedModeChanged: (callback: (docked: boolean) => void) => {
    ipcRenderer.on('layout:docked-changed', (_event, docked) => callback(docked));
  },

  // Immerse mode (black out non-viewer monitors)
  setImmerseEnabled: (enabled: boolean) => ipcRenderer.send('immerse:set-enabled', enabled),
  onImmerseChanged: (callback: (enabled: boolean) => void) => {
    ipcRenderer.on('immerse:changed', (_event, enabled) => callback(enabled));
  },

  // Playlist state sync (viewer → detached playlist)
  broadcastPlaylistState: (state: any) => ipcRenderer.send('playlist:state-push', state),
  onPlaylistStateUpdate: (callback: (state: any) => void) => {
    ipcRenderer.on('playlist:state-update', (_event, state) => callback(state));
  },

  // Playlist actions (detached playlist → viewer)
  sendPlaylistAction: (action: any) => ipcRenderer.send('playlist:action', action),
  onPlaylistAction: (callback: (action: any) => void) => {
    ipcRenderer.on('playlist:action-received', (_event, action) => callback(action));
  },
});
