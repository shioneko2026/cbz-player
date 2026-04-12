import { app, ipcMain, BrowserWindow, dialog, protocol, net, shell, Menu } from 'electron';
import { pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import sevenBin from '7zip-bin';
import { createViewerWindow, createPlaylistWindow, getViewerWindow, getPlaylistWindow, getWindowBounds, sendToAll } from './window-manager';
import { scanForCbzFiles, getFileInfoFromPaths, detectSortDestination, ensureSortFolders, sortFile, renameFile, DEFAULT_CATEGORIES } from './file-operations';
import { loadConfig, saveConfig } from './config-store';
import { extractCbz, cleanupTemp, cleanupSlot, resolveImagePath, getSlotDir } from './cbz-extractor';
import { saveSessionLog } from './session-logger';

// Track which window type each webContents ID maps to
const windowTypeMap = new Map<number, 'viewer' | 'playlist'>();

// Register custom protocol for serving extracted CBZ images
protocol.registerSchemesAsPrivileged([
  { scheme: 'cbz-image', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

app.whenReady().then(() => {
  const config = loadConfig();

  // Register protocol handler for extracted images
  // URL format: cbz-image://host/{extractionId}/{filename}
  protocol.handle('cbz-image', (request) => {
    const url = new URL(request.url);
    const parts = decodeURIComponent(url.pathname.replace(/^\/+/, '')).split('/');
    const extractionId = parts[0] ?? '';
    const filename = parts.slice(1).join('/');

    const filePath = resolveImagePath(extractionId, filename);
    if (!filePath) {
      // Return a 1x1 transparent pixel instead of 404 to avoid console errors
      const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      return new Response(pixel, { headers: { 'Content-Type': 'image/gif' } });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });

  const viewer = createViewerWindow(config.viewerWindowBounds);
  const playlist = createPlaylistWindow(config.playlistWindowBounds, config.isDocked);

  windowTypeMap.set(viewer.webContents.id, 'viewer');
  windowTypeMap.set(playlist.webContents.id, 'playlist');

  // ─── Start in fullscreen if configured ──────────────────────────────────────
  if (config.startFullscreen) {
    viewer.setFullScreen(true);
  }

  // ─── Auto-load folder from environment variable ────────────────────────────
  const autoLoadFolder = process.env.CBZ_SORTER_FOLDER?.replace(/[\\/]+$/, '');
  if (autoLoadFolder) {
    // Wait for both windows to finish loading, then send the folder
    viewer.webContents.once('did-finish-load', () => {
      const files = scanForCbzFiles(autoLoadFolder);
      if (files.length > 0) {
        ensureSortFolders(autoLoadFolder, config.categories ?? DEFAULT_CATEGORIES);
        // Small delay to let React mount
        setTimeout(() => {
          sendToAll('state:update', { files, currentIndex: 0, sortDestination: autoLoadFolder });
        }, 500);
      }
    });
  }

  // ─── Menu Bar ───────────────────────────────────────────────────────────────
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Single Page', accelerator: 'CmdOrCtrl+1', click: () => sendToAll('menu:action', 'view-single') },
        { label: 'Dual LTR', accelerator: 'CmdOrCtrl+2', click: () => sendToAll('menu:action', 'view-dual-ltr') },
        { label: 'Dual RTL', accelerator: 'CmdOrCtrl+3', click: () => sendToAll('menu:action', 'view-dual-rtl') },
        { label: 'Scroll', accelerator: 'CmdOrCtrl+4', click: () => sendToAll('menu:action', 'view-scroll') },
        { type: 'separator' },
        { label: 'Fullscreen', accelerator: 'F11', click: () => {
          const vw = getViewerWindow();
          if (vw && !vw.isDestroyed()) vw.setFullScreen(!vw.isFullScreen());
        }},
        { label: 'Toggle Playlist', accelerator: 'F6', click: () => sendToAll('menu:action', 'toggle-playlist') },
        { label: 'Center Page', accelerator: 'CmdOrCtrl+E', click: () => sendToAll('menu:action', 'toggle-center') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Settings',
      submenu: [
        { label: 'Preferences...', accelerator: 'CmdOrCtrl+,', click: () => sendToAll('menu:action', 'open-settings') },
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        { label: 'About CBZ Sorter v5', click: () => dialog.showMessageBox({ title: 'CBZ Sorter v5', message: 'CBZ Sorter v5\nElectron + React + Tailwind', type: 'info' }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  // ─── Settings IPC ──────────────────────────────────────────────────────────
  ipcMain.handle('settings:load', () => loadConfig());
  ipcMain.handle('settings:save', async (_event, settings: any) => {
    saveConfig(settings);
    // Reload config reference
    Object.assign(config, loadConfig());
    return { success: true };
  });

  // ─── Window Type ───────────────────────────────────────────────────────────
  ipcMain.handle('window:get-type', (event) => {
    return windowTypeMap.get(event.sender.id) ?? 'viewer';
  });

  // ─── Viewer Theme ──────────────────────────────────────────────────────────
  ipcMain.on('viewer:set-theme', (_event, dark: boolean) => {
    const vw = getViewerWindow();
    if (vw && !vw.isDestroyed()) {
      vw.webContents.send('viewer:theme-changed', dark);
    }
  });

  // ─── Load Files: from folder ───────────────────────────────────────────────
  ipcMain.handle('files:load-folder', async (_event, folderPath: string) => {
    const files = scanForCbzFiles(folderPath);
    ensureSortFolders(folderPath, config.categories ?? DEFAULT_CATEGORIES);
    return { files, sortDestination: folderPath };
  });

  // ─── Load Files: from dropped file paths ───────────────────────────────────
  ipcMain.handle('files:load-paths', async (event, filePaths: string[]) => {
    const files = getFileInfoFromPaths(filePaths);
    if (files.length === 0) return { files: [], sortDestination: null };

    let sortDestination = detectSortDestination(filePaths);

    if (!sortDestination) {
      const pw = getPlaylistWindow();
      const parentWindow = pw && !pw.isDestroyed() ? pw : undefined;
      const result = await dialog.showOpenDialog({
        ...(parentWindow ? { browserWindow: parentWindow } : {}),
        title: 'Choose sort destination folder',
        message: 'Files come from multiple folders. Where should sort folders be created?',
        properties: ['openDirectory'],
      } as any);

      if (result.canceled || result.filePaths.length === 0) {
        return { files, sortDestination: null };
      }
      sortDestination = result.filePaths[0];
    }

    ensureSortFolders(sortDestination, config.categories ?? DEFAULT_CATEGORIES);
    return { files, sortDestination };
  });

  // ─── Pick folder via dialog ────────────────────────────────────────────────
  ipcMain.handle('files:pick-folder', async () => {
    const pw = getPlaylistWindow();
    const parentWindow = pw && !pw.isDestroyed() ? pw : undefined;
    const result = await dialog.showOpenDialog({
      ...(parentWindow ? { browserWindow: parentWindow } : {}),
      title: 'Select folder with CBZ files',
      properties: ['openDirectory'],
    } as any);

    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // ─── CBZ Extraction ────────────────────────────────────────────────────────
  ipcMain.handle('cbz:extract', async (_event, cbzPath: string, slot?: string) => {
    try {
      const result = await extractCbz(cbzPath, slot ?? 'main', (percent, status) => {
        // Send progress to viewer window
        const vw = getViewerWindow();
        if (vw && !vw.isDestroyed()) {
          vw.webContents.send('cbz:extract-progress', { percent, status });
        }
      });
      return { images: result.images, extractionId: result.extractionId, error: null };
    } catch (err: any) {
      return { images: [], extractionId: null, error: err.message ?? 'Extraction failed' };
    }
  });

  ipcMain.handle('cbz:cleanup', async (_event, slot?: string) => {
    if (slot) cleanupSlot(slot);
    else cleanupTemp();
  });

  // ─── Delete Files (to recycle bin) ──────────────────────────────────────────
  ipcMain.handle('file:trash', async (_event, filePaths: string[]) => {
    const results: { path: string; success: boolean }[] = [];
    for (const fp of filePaths) {
      try {
        await retryOperation(() => trashWithFallback(fp));
        results.push({ path: fp, success: true });
      } catch {
        results.push({ path: fp, success: false });
      }
    }
    return results;
  });

  // ─── Sort File (move to category folder) ────────────────────────────────────
  // Helper: retry an async operation with delays (handles file locks from extraction)
  async function retryOperation<T>(fn: () => Promise<T>, maxRetries = 3, delayMs = 300): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i === maxRetries - 1) throw err;
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    throw new Error('Retry exhausted');
  }

  async function trashWithFallback(filePath: string): Promise<void> {
    try {
      await shell.trashItem(filePath);
    } catch {
      await new Promise<void>((resolve, reject) => {
        const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${filePath.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10000 }, (err: any, _stdout: string, stderr: string) => {
          if (err) reject(new Error(stderr || err.message)); else resolve();
        });
      });
    }
  }

  ipcMain.handle('file:sort', async (_event, filePath: string, categoryId: string, sortDestination: string) => {
    const categories = config.categories ?? DEFAULT_CATEGORIES;
    const category = categories.find(c => c.id === categoryId);
    if (!category) return { success: false, error: `Unknown category: ${categoryId}` };

    const effectiveDest = (!config.useSourceFolder && config.customOutputFolder)
      ? config.customOutputFolder
      : sortDestination;

    // Don't clean up extraction slots — let them finish in background.
    // The renderer already ignores stale results via extractionCounterRef.

    if (category.isPurge) {
      try {
        await retryOperation(() => trashWithFallback(filePath));
        return { success: true, isDupe: false, action: 'purge' };
      } catch (err: any) {
        return { success: false, error: err.message ?? 'Failed to delete' };
      }
    }

    try {
      // Retry move in case 7z/unrar has a temporary read lock on the source file
      const result = await retryOperation(async () => sortFile(filePath, effectiveDest, category, categories));
      return { success: true, isDupe: result.isDupe, destPath: result.destPath, action: 'move' };
    } catch (err: any) {
      return { success: false, error: err.message ?? 'Failed to move' };
    }
  });

  // ─── Repack CBZ ─────────────────────────────────────────────────────────────
  ipcMain.handle('cbz:repack', async (_event, originalPath: string, slot: string, keepIndices: number[], renames: Record<string, string>) => {
    try {
      const slotDir = getSlotDir(slot);
      if (!slotDir) throw new Error('No extraction found for this file');

      // Collect the image files to keep, in order
      const allImages = fs.readdirSync(slotDir)
        .filter((f: string) => !f.startsWith('_') && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(f))
        .sort((a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

      const imagesToKeep = keepIndices
        .filter(i => i >= 0 && i < allImages.length)
        .map(i => ({
          sourcePath: path.join(slotDir, allImages[i]),
          destName: renames[String(i)] ?? allImages[i],
        }));

      if (imagesToKeep.length === 0) throw new Error('No pages to repack');

      // Create a staging dir for the new CBZ contents
      const repackDir = path.join(slotDir, '_repack');
      fs.mkdirSync(repackDir, { recursive: true });

      for (const { sourcePath, destName } of imagesToKeep) {
        fs.copyFileSync(sourcePath, path.join(repackDir, destName));
      }

      // Create new CBZ using 7z — NO -spd flag here so * wildcard works
      const tempCbz = originalPath + '.tmp';
      await new Promise<void>((resolve, reject) => {
        execFile(sevenBin.path7za, ['a', '-tzip', tempCbz, repackDir + path.sep + '*'], {
          timeout: 60000, maxBuffer: 10 * 1024 * 1024,
        }, (err: any, stdout: string, stderr: string) => {
          // 7z returns exit code 0 on success, check if files were actually added
          if (err) reject(new Error(stderr?.trim() || err.message));
          else resolve();
        });
      });

      // Verify the temp CBZ is valid (not empty)
      const tempStat = fs.statSync(tempCbz);
      if (tempStat.size < 100) {
        fs.unlinkSync(tempCbz);
        throw new Error('Repack produced an empty archive — files may not have been found');
      }

      // Backup original to [Repack Backup] folder before replacing
      const originalDir = path.dirname(originalPath);
      const backupDir = path.join(originalDir, '[Repack Backup]');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, path.basename(originalPath));
      // If backup already exists, add timestamp
      const finalBackupPath = fs.existsSync(backupPath)
        ? path.join(backupDir, `${path.basename(originalPath, path.extname(originalPath))}_${Date.now()}${path.extname(originalPath)}`)
        : backupPath;
      fs.copyFileSync(originalPath, finalBackupPath);

      // Replace original
      fs.unlinkSync(originalPath);
      fs.renameSync(tempCbz, originalPath);

      // Cleanup
      try { fs.rmSync(repackDir, { recursive: true, force: true }); } catch {}

      return { success: true, pagesKept: imagesToKeep.length };
    } catch (err: any) {
      return { success: false, error: err.message ?? 'Repack failed' };
    }
  });

  // ─── Rename File ────────────────────────────────────────────────────────────
  ipcMain.handle('file:rename', async (_event, oldPath: string, newName: string) => {
    try {
      const newFile = renameFile(oldPath, newName);
      return { success: true, file: newFile, error: null };
    } catch (err: any) {
      return { success: false, file: null, error: err.message ?? 'Rename failed' };
    }
  });

  // ─── Broadcast state to both windows ───────────────────────────────────────
  ipcMain.on('state:broadcast', (_event, state: any) => {
    sendToAll('state:update', state);
  });

  // ─── Playlist state sync: viewer → detached playlist ────────────────────────
  ipcMain.on('playlist:state-push', (_event, state: any) => {
    const pw = getPlaylistWindow();
    if (pw && !pw.isDestroyed()) {
      pw.webContents.send('playlist:state-update', state);
    }
  });

  // ─── Playlist actions: detached playlist → viewer ───────────────────────────
  ipcMain.on('playlist:action', (_event, action: any) => {
    const vw = getViewerWindow();
    if (vw && !vw.isDestroyed()) {
      vw.webContents.send('playlist:action-received', action);
    }
  });

  // ─── Layout: Docked/Detached Mode ──────────────────────────────────────────
  ipcMain.on('layout:set-docked', (_event, docked: boolean) => {
    const pw = getPlaylistWindow();
    const vw = getViewerWindow();
    if (docked) {
      // Hide playlist window, viewer shows docked panel
      if (pw && !pw.isDestroyed()) pw.hide();
    } else {
      // Show playlist window, viewer hides docked panel
      if (pw && !pw.isDestroyed()) pw.show();
    }
    // Notify both windows of the mode change
    sendToAll('layout:docked-changed', docked);
  });

  // ─── Save/Load UI State ─────────────────────────────────────────────────────
  ipcMain.handle('config:load', () => {
    return loadConfig();
  });

  ipcMain.on('config:save-ui', (_event, uiState: any) => {
    saveConfig(uiState);
  });

  // Save window bounds before quitting
  function saveWindowState(extraState?: any) {
    saveConfig({
      viewerWindowBounds: getWindowBounds(getViewerWindow()),
      playlistWindowBounds: getWindowBounds(getPlaylistWindow()),
      ...extraState,
    });
  }

  // ─── Fullscreen Controls ────────────────────────────────────────────────────
  ipcMain.on('window:toggle-fullscreen', () => {
    const vw = getViewerWindow();
    if (vw && !vw.isDestroyed()) {
      vw.setFullScreen(!vw.isFullScreen());
    }
  });

  ipcMain.on('window:exit-fullscreen', () => {
    const vw = getViewerWindow();
    if (vw && !vw.isDestroyed() && vw.isFullScreen()) {
      vw.setFullScreen(false);
    }
  });

  ipcMain.handle('window:is-fullscreen', () => {
    const vw = getViewerWindow();
    return vw && !vw.isDestroyed() ? vw.isFullScreen() : false;
  });

  // ─── App Quit ──────────────────────────────────────────────────────────────
  ipcMain.on('app:quit', (_event, uiState?: any) => {
    saveWindowState(uiState);
    // Save session log if stats were provided
    if (uiState?.sessionLog) {
      saveSessionLog(uiState.sessionLog);
    }
    cleanupTemp();
    app.quit();
  });

  // ─── Coupled windows: closing one closes both ─────────────────────────────
  viewer.on('closed', () => {
    const pw = getPlaylistWindow();
    if (pw && !pw.isDestroyed()) pw.close();
  });
  playlist.on('closed', () => {
    const vw = getViewerWindow();
    if (vw && !vw.isDestroyed()) vw.close();
  });
});

// Quit when all windows are closed
app.on('window-all-closed', () => {
  cleanupTemp();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const viewer = createViewerWindow();
    const playlist = createPlaylistWindow();
    windowTypeMap.set(viewer.webContents.id, 'viewer');
    windowTypeMap.set(playlist.webContents.id, 'playlist');
  }
});
