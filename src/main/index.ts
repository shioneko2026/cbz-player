import { app, ipcMain, BrowserWindow, dialog, protocol, shell, Menu } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';
import sevenBin from '7zip-bin';
import { createViewerWindow, createPlaylistWindow, getViewerWindow, getPlaylistWindow, getWindowBounds, sendToAll, setImmerseEnabled, destroyAllBlackouts } from './window-manager';
import { scanForCbzFiles, getFileInfoFromPaths, detectSortDestination, ensureSortFolders, sortFile, renameFile, resolveCategoryBasePath, DEFAULT_CATEGORIES } from './file-operations';
import { loadConfig, saveConfig } from './config-store';
import { extractCbz, cleanupTemp, cleanupSlot, resolveImage, getSlotSources, getSlotNames, hasSlot, type ImageSource } from './cbz-extractor';
import { saveSessionLog } from './session-logger';

// Track which window type each webContents ID maps to
const windowTypeMap = new Map<number, 'viewer' | 'playlist'>();

/** Copy a Node Buffer into an ArrayBuffer so Response's BodyInit typing accepts it. */
function bufferToBody(buf: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

/**
 * Return the set of Windows-illegal filename characters present in `s`, or an
 * empty array if the string is safe. Control chars are rendered as \xNN so the
 * user sees something printable in error messages.
 */
const ILLEGAL_FS_CHAR = /[<>:"/\\|?*\x00-\x1f]/;
function findIllegalFsChars(s: string): string[] {
  const seen = new Set<string>();
  for (const ch of s) {
    if (ILLEGAL_FS_CHAR.test(ch)) {
      const code = ch.charCodeAt(0);
      seen.add(code < 0x20 ? `\\x${code.toString(16).padStart(2, '0')}` : ch);
    }
  }
  return [...seen];
}

/** Minimal MIME lookup for the image types the extractor recognises. */
function mimeForImageName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.bmp': return 'image/bmp';
    default: return 'application/octet-stream';
  }
}

// Register custom protocol for serving extracted CBZ images
protocol.registerSchemesAsPrivileged([
  { scheme: 'cbz-image', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

app.whenReady().then(() => {
  const config = loadConfig();

  // Register protocol handler for extracted images
  // URL format: cbz-image://host/{extractionId}/{filename}
  protocol.handle('cbz-image', async (request) => {
    const url = new URL(request.url);
    const parts = decodeURIComponent(url.pathname.replace(/^\/+/, '')).split('/');
    const extractionId = parts[0] ?? '';
    const filename = parts.slice(1).join('/');

    // Compare slots are reused across sessions ('compare-left' / 'compare-right'),
    // so the same URL can map to different files. Disable caching for those to
    // prevent a stale response from a prior session masking a fresh extraction.
    const isCompareSlot = extractionId.startsWith('compare-');
    const noCacheHeaders: Record<string, string> = isCompareSlot ? { 'Cache-Control': 'no-store' } : {};

    const source = resolveImage(extractionId, filename);
    if (!source) {
      // Return 404 (not a 1x1 pixel) so the renderer's onError/retry kicks in
      // for transient misses during extraction/cleanup races.
      return new Response(null, { status: 404, headers: noCacheHeaders });
    }

    const contentType = mimeForImageName(filename);

    const headers: Record<string, string> = { 'Content-Type': contentType, ...noCacheHeaders };

    if ('memory' in source) {
      // In-memory source — serve the buffer directly. MAX_PATH cannot bite
      // because nothing ever touched the filesystem for this image.
      // Wrap the Buffer in a Uint8Array view so TypeScript's Response typing
      // accepts it as BodyInit.
      return new Response(bufferToBody(source.memory), { status: 200, headers });
    }

    // Disk-backed source (7z fallback). Read with long-path-safe namespaced
    // prefix and serve as a buffered Response. We avoid net.fetch(file://...)
    // because Chromium's file:// handler on Windows has separate MAX_PATH
    // behaviour that Node's fs (with namespaced paths) does not.
    try {
      const safePath = path.toNamespacedPath(source.disk);
      const buffer = await fs.promises.readFile(safePath);
      return new Response(bufferToBody(buffer), { status: 200, headers });
    } catch {
      return new Response(null, { status: 404, headers: noCacheHeaders });
    }
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
  // Prefer the new CBZ_PLAYER_FOLDER name; fall back to CBZ_SORTER_FOLDER for
  // backward compatibility with any external scripts / shortcuts still setting
  // the old variable.
  const rawAutoLoad = process.env.CBZ_PLAYER_FOLDER ?? process.env.CBZ_SORTER_FOLDER;
  const autoLoadFolder = rawAutoLoad?.replace(/[\\/]+$/, '');
  if (autoLoadFolder) {
    // Wait for both windows to finish loading, then send the folder
    viewer.webContents.once('did-finish-load', () => {
      const files = scanForCbzFiles(autoLoadFolder);
      if (files.length > 0) {
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
        { label: 'About CBZ Player v5', click: () => dialog.showMessageBox({ title: 'CBZ Player v5', message: 'CBZ Player v5\nElectron + React + Tailwind', type: 'info' }) },
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

    return { files, sortDestination };
  });

  // ─── Validate a user-typed path (for Settings inline validation) ───────────
  // Returns shape the renderer can reason about without doing its own fs access.
  // - exists:     path itself is present on disk (directory OR file)
  // - isFile:     path exists AND is a plain file (i.e. picking it as a folder is wrong)
  // - rootExists: the drive letter / UNC root is currently mounted
  ipcMain.handle('files:validate-path', async (_event, p: string) => {
    const trimmed = (p ?? '').trim();
    if (!trimmed) return { exists: false, isFile: false, rootExists: false };
    const nspPath = path.toNamespacedPath(trimmed);
    let exists = false;
    let isFile = false;
    try {
      const stat = fs.statSync(nspPath);
      exists = true;
      isFile = stat.isFile();
    } catch {
      // path doesn't exist (or is unreadable) — leave exists=false
    }
    let rootExists = false;
    try {
      const root = path.parse(trimmed).root;
      // Drive roots are short (3 chars) and the \\?\ prefix actually BREAKS
      // existsSync for drive-root queries on Windows. Use plain path.
      rootExists = !!root && fs.existsSync(root);
    } catch {
      // malformed path — leave rootExists=false
    }
    return { exists, isFile, rootExists };
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
    const effectiveSlot = slot ?? 'main';
    try {
      const result = await extractCbz(cbzPath, effectiveSlot, (percent, status) => {
        const vw = getViewerWindow();
        if (vw && !vw.isDestroyed()) {
          vw.webContents.send('cbz:extract-progress', { percent, status, slot: effectiveSlot });
        }
      });
      return { images: result.images, imageNames: result.imageNames, extractionId: result.extractionId, topLevelFolder: result.topLevelFolder, error: null };
    } catch (err: any) {
      return { images: [], imageNames: [], extractionId: null, topLevelFolder: '', error: err.message ?? 'Extraction failed' };
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

    const effectiveDest = resolveCategoryBasePath(
      category, config.useSourceFolder, config.customOutputFolder, sortDestination,
    );

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
  ipcMain.handle('cbz:repack', async (_event, originalPath: string, slot: string, keepIndices: number[], renames: Record<string, string>, folderName?: string, newFileName?: string) => {
    try {
      if (!hasSlot(slot)) throw new Error('No extraction found for this file');

      const sources = getSlotSources(slot) ?? [];
      const names = getSlotNames(slot) ?? [];

      const imagesToWrite = keepIndices
        .filter(i => i >= 0 && i < sources.length)
        .map(i => ({
          source: sources[i],
          destName: renames[String(i)] ?? names[i] ?? `page-${String(i).padStart(4, '0')}.jpg`,
        }));

      if (imagesToWrite.length === 0) throw new Error('No pages to repack');

      // Validate folder name — reject loudly if it contains FS-illegal chars so
      // the user knows exactly what to fix, rather than silently stripping.
      // Empty string (after trim) is valid and means "no folder inside archive".
      const trimmedFolder = (folderName ?? '').trim();
      {
        const bad = findIllegalFsChars(trimmedFolder);
        if (bad.length > 0) {
          throw new Error(`Folder name can't contain ${bad.join(' ')} — Windows disallows these in filenames. Remove them and try again.`);
        }
      }
      const sanitizedFolder = trimmedFolder;

      // Validate per-page renames. Any illegal char here would fail the fs.write
      // further down with a cryptic error, so reject up front with the page number.
      for (const [key, destName] of Object.entries(renames ?? {})) {
        const bad = findIllegalFsChars(destName);
        if (bad.length > 0) {
          const pageNum = Number(key) + 1;
          throw new Error(`Page ${pageNum} rename "${destName}" contains ${bad.join(' ')} — Windows disallows these in filenames.`);
        }
      }

      // Validate CBZ filename. Empty/missing = keep current basename.
      // Check for illegal chars BEFORE enforcing the .cbz extension (so we
      // report the exact string the user typed, not a modified version).
      const trimmedName = (newFileName ?? '').trim();
      let finalFileName = trimmedName || path.basename(originalPath);
      {
        const bad = findIllegalFsChars(finalFileName);
        if (bad.length > 0) {
          throw new Error(`Filename can't contain ${bad.join(' ')} — Windows disallows these in filenames. Remove them and try again.`);
        }
      }
      // Auto-add .cbz extension if missing (non-destructive convenience so the
      // playlist scanner keeps finding the file).
      if (!/\.cbz$/i.test(finalFileName)) finalFileName = finalFileName + '.cbz';

      const originalDir = path.dirname(originalPath);
      const finalPath = path.join(originalDir, finalFileName);
      // Case-insensitive compare on Windows so "Foo.cbz" → "foo.cbz" (same file,
      // different case) doesn't trip the dupe check below.
      const isRename = process.platform === 'win32'
        ? finalPath.toLowerCase() !== originalPath.toLowerCase()
        : finalPath !== originalPath;

      // Dupe check: if the new name targets a different existing file, bail out.
      if (isRename && fs.existsSync(path.toNamespacedPath(finalPath))) {
        throw new Error(`A file named "${finalFileName}" already exists in this folder`);
      }

      // Create a short-path staging dir for the new CBZ contents. Kept short
      // on purpose so 7za's wildcard expansion doesn't trip MAX_PATH when the
      // user picks a long folder name.
      const repackDir = path.join(os.tmpdir(), `cbz-rep-${Date.now().toString(36)}`);
      fs.mkdirSync(repackDir, { recursive: true });
      const contentDir = sanitizedFolder ? path.join(repackDir, sanitizedFolder) : repackDir;
      if (sanitizedFolder) fs.mkdirSync(contentDir, { recursive: true });

      for (const { source, destName } of imagesToWrite) {
        const destPath = path.toNamespacedPath(path.join(contentDir, destName));
        if ('memory' in source) {
          fs.writeFileSync(destPath, source.memory);
        } else {
          fs.copyFileSync(path.toNamespacedPath(source.disk), destPath);
        }
      }

      // Create new CBZ using 7z at a SHORT temp location so 7za never sees
      // the user's possibly-long original path. We move it into place afterwards.
      const tempCbz = path.join(os.tmpdir(), `cbz-out-${Date.now().toString(36)}.cbz`);
      // If nested in a folder, zip the folder itself (preserves folder entry);
      // otherwise zip the staging contents flat.
      const sourceArg = sanitizedFolder
        ? path.join(repackDir, sanitizedFolder)
        : repackDir + path.sep + '*';
      await new Promise<void>((resolve, reject) => {
        execFile(sevenBin.path7za, ['a', '-tzip', tempCbz, sourceArg], {
          timeout: 60000, maxBuffer: 10 * 1024 * 1024,
        }, (err: any, _stdout: string, stderr: string) => {
          if (err) reject(new Error(stderr?.trim() || err.message));
          else resolve();
        });
      });

      // Verify the temp CBZ is valid (not empty). tempCbz is short, plain stat OK.
      const tempStat = fs.statSync(tempCbz);
      if (tempStat.size < 100) {
        try { fs.unlinkSync(tempCbz); } catch {}
        throw new Error('Repack produced an empty archive — files may not have been found');
      }

      // Backup original to [Repack Backup] folder before replacing. Every path
      // that touches the user's long filename goes through toNamespacedPath so
      // Node's fs bypasses MAX_PATH on Windows. (originalDir declared above.)
      const backupDir = path.join(originalDir, '[Repack Backup]');
      const backupDirNs = path.toNamespacedPath(backupDir);
      if (!fs.existsSync(backupDirNs)) fs.mkdirSync(backupDirNs, { recursive: true });
      const backupPath = path.join(backupDir, path.basename(originalPath));
      const backupPathNs = path.toNamespacedPath(backupPath);
      const finalBackupPath = fs.existsSync(backupPathNs)
        ? path.join(backupDir, `${path.basename(originalPath, path.extname(originalPath))}_${Date.now()}${path.extname(originalPath)}`)
        : backupPath;
      fs.copyFileSync(path.toNamespacedPath(originalPath), path.toNamespacedPath(finalBackupPath));

      // Replace. Use copy+unlink (not rename) because tempCbz lives on the
      // system tmpdir (likely C:\) while finalPath may be on a different drive
      // — rename across filesystems fails with EXDEV. Unlinking the original
      // first also lets case-only renames work on Windows (e.g. foo.cbz → Foo.cbz).
      fs.unlinkSync(path.toNamespacedPath(originalPath));
      fs.copyFileSync(tempCbz, path.toNamespacedPath(finalPath));
      try { fs.unlinkSync(tempCbz); } catch {}

      // Cleanup
      try { fs.rmSync(repackDir, { recursive: true, force: true }); } catch {}

      return { success: true, pagesKept: imagesToWrite.length, newPath: finalPath };
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
    // Immerse is incompatible with detached mode — it would black out the
    // playlist window sitting on another monitor. Turn it off before detaching
    // so the transition is clean; tell renderers to reset their toggle state.
    if (!docked) {
      setImmerseEnabled(false);
      sendToAll('immerse:changed', false);
    }
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

  // ─── Immerse Mode (black out non-viewer monitors) ──────────────────────────
  ipcMain.on('immerse:set-enabled', (_event, enabled: boolean) => {
    setImmerseEnabled(enabled);
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
    destroyAllBlackouts();
    cleanupTemp();
    app.quit();
  });

  // ─── Coupled windows: closing one closes both ─────────────────────────────
  viewer.on('closed', () => {
    destroyAllBlackouts();
    const pw = getPlaylistWindow();
    if (pw && !pw.isDestroyed()) pw.close();
  });
  playlist.on('closed', () => {
    destroyAllBlackouts();
    const vw = getViewerWindow();
    if (vw && !vw.isDestroyed()) vw.close();
  });
});

// Quit when all windows are closed
app.on('window-all-closed', () => {
  destroyAllBlackouts();
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
