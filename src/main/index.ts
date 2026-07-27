import { app, ipcMain, BrowserWindow, dialog, protocol, shell, Menu } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';
import sevenBin from '7zip-bin';
import { createViewerWindow, createPlaylistWindow, getViewerWindow, getPlaylistWindow, getWindowBounds, sendToAll, setImmerseEnabled, destroyAllBlackouts } from './window-manager';
import { scanForCbzFiles, getFileInfoFromPaths, detectSortDestination, ensureSortFolders, sortFile, unsortFile, moveToHolding, cleanupHoldingSubfolder, listStrandedHoldingFiles, renameFile, resolveCategoryBasePath, DEFAULT_CATEGORIES, SUPPORTED_ARCHIVE_EXTS } from './file-operations';
import { loadConfig, saveConfig } from './config-store';
import { extractCbz, cleanupTemp, cleanupSlot, resolveImage, getSlotSources, getSlotNames, hasSlot, getSlotDebugInfo, type ImageSource } from './cbz-extractor';
import { saveSessionLog } from './session-logger';

// Track which window type each webContents ID maps to
const windowTypeMap = new Map<number, 'viewer' | 'playlist'>();

// Inline C# that calls Windows' IFileOperation directly to send a file to the
// Recycle Bin. Used as the long-path fallback in trashWithFallback because:
//   - shell.trashItem (Electron's wrapper) fails for some long paths because of
//     internal GetFullPathName limits inside the Chromium wrapper.
//   - Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile (the previous fallback)
//     is fundamentally incompatible with long paths: throws PathTooLongException
//     for paths >MAX_PATH (260 chars) unprefixed, and NotSupportedException
//     ("format not supported") for the same paths with a \\?\ namespace prefix.
//   - IFileOperation uses Unicode shell APIs throughout and natively supports
//     long paths. SHCreateItemFromParsingName accepts the Unicode path directly
//     without needing a \\?\ prefix (and rejects \\?\-prefixed paths).
// Flags: FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI |
// FOFX_RECYCLEONDELETE — send to Recycle Bin only (no permanent-delete
// fallback), no UI, no error dialogs (errors come back as exceptions).
const LONG_PATH_TRASH_CSHARP = `
using System;
using System.Runtime.InteropServices;
public class LongPathTrash {
    [ComImport, Guid("3AD05575-8857-4850-9277-11B85BDB8E09"), ClassInterface(ClassInterfaceType.None)]
    private class CFileOperation {}
    [ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOperation {
        void Advise(IntPtr p, out uint c);
        void Unadvise(uint c);
        void SetOperationFlags(uint flags);
        void SetProgressMessage(string m);
        void SetProgressDialog(IntPtr p);
        void SetProperties(IntPtr p);
        void SetOwnerWindow(IntPtr h);
        void ApplyPropertiesToItem(IShellItem item);
        void ApplyPropertiesToItems([MarshalAs(UnmanagedType.IUnknown)] object items);
        void RenameItem(IShellItem item, string newName, IntPtr cb);
        void RenameItems([MarshalAs(UnmanagedType.IUnknown)] object items, string newName);
        void MoveItem(IShellItem item, IShellItem dest, string newName, IntPtr cb);
        void MoveItems([MarshalAs(UnmanagedType.IUnknown)] object items, IShellItem dest);
        void CopyItem(IShellItem item, IShellItem dest, string copyName, IntPtr cb);
        void CopyItems([MarshalAs(UnmanagedType.IUnknown)] object items, IShellItem dest);
        void DeleteItem(IShellItem item, IntPtr cb);
        void DeleteItems([MarshalAs(UnmanagedType.IUnknown)] object items);
        void NewItem(IShellItem dest, uint attrs, string name, string templateName, IntPtr cb);
        void PerformOperations();
        void GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
    }
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {
        void BindToHandler(IntPtr p, ref Guid b, ref Guid r, out IntPtr v);
        void GetParent(out IShellItem p);
        void GetDisplayName(uint s, [MarshalAs(UnmanagedType.LPWStr)] out string n);
        void GetAttributes(uint m, out uint a);
        void Compare(IShellItem p, uint h, out int o);
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
        IntPtr pbc, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);
    public static void SendToRecycleBin(string path) {
        var op = (IFileOperation)new CFileOperation();
        try {
            op.SetOperationFlags(0x0004u | 0x0010u | 0x0040u | 0x0400u | 0x00080000u);
            var g = typeof(IShellItem).GUID;
            IShellItem item;
            SHCreateItemFromParsingName(path, IntPtr.Zero, ref g, out item);
            try {
                op.DeleteItem(item, IntPtr.Zero);
                op.PerformOperations();
            } finally { Marshal.ReleaseComObject(item); }
        } finally { Marshal.ReleaseComObject(op); }
    }
}
`;

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

// ─── Single-instance lock ───────────────────────────────────────────────────
// First launch acquires the lock and becomes the long-running app. Subsequent
// launches (e.g. user double-clicks a .cbz in Explorer, or invokes the right-
// click "Open / Compare in CBZ Player" verbs with multiple files selected —
// Windows fires the verb command once per file) fail to acquire the lock,
// send their argv into the running app via the auto-handed-off
// 'second-instance' event, then immediately exit via app.exit(0). We use
// app.exit (not app.quit) because quit is async and lets module init keep
// running — Electron occasionally flashes a brief window before the quit
// processes. exit is immediate and silent.
const singleInstanceGotLock = app.requestSingleInstanceLock();
if (!singleInstanceGotLock) {
  app.exit(0);
}

// Buffer for explorer-launched arguments. Windows fires the verb command
// once per file when multi-selected, so we get a flurry of `second-instance`
// events (or argv tokens from our cold start). The debounce flushes after a
// quiet period so we batch them into one "what did the user want?" decision.
// 400ms tested empirically: short enough to feel responsive on single-file
// double-click, long enough to catch the spread-out second-instance arrivals
// on 10+ multi-selects.
type PendingArg = { path: string; isCompare: boolean; isAppend: boolean; isFolder: boolean; isRepack: boolean };
let pendingArgs: PendingArg[] = [];
let pendingFlushTimer: NodeJS.Timeout | null = null;
const PENDING_FLUSH_DEBOUNCE_MS = 400;

// Stragger-grouping: any flush that fires within this window after the previous
// one is treated as the same multi-select operation, forced to APPEND mode
// (because Windows split the multi-select across spawns and some second-
// instance events arrived after the first flush had already dispatched).
// Without this, a 10-file multi-select where stragglers spread over 500ms+
// would dispatch the first batch as "replace" and each straggler as "replace"
// again — leaving only the last file in the playlist.
const STRAGGER_GROUPING_WINDOW_MS = 2500;
let lastFlushTime = 0;

/** Parse an argv array (from cold start or a second-instance event) for file
 *  paths and our custom flag tokens. Each returned PendingArg carries the
 *  flag state seen in the SAME argv batch — different verbs invoke with
 *  different flag sets, and the dispatch logic uses these to decide what
 *  kind of action to take.
 *
 *  We explicitly skip the executable's own path (always at argv[0] in both
 *  packaged and dev modes) and the dev-mode `.` token — without that filter
 *  the --folder path would erroneously include the .exe (triggering
 *  scanForCbzFiles to ENOTDIR on the binary). */
function parseExplorerArgv(argv: string[]): PendingArg[] {
  const isCompare = argv.includes('--compare');
  const isAppend = argv.includes('--append');
  const isFolder = argv.includes('--folder');
  const isRepack = argv.includes('--repack');
  // "--folder-of" backs the .cbz-FILE verb "Open this folder in CBZ Player":
  // %1 is the clicked file, and we open its CONTAINING folder.
  const isFolderOf = argv.includes('--folder-of');
  const myExePathLower = process.execPath.toLowerCase();
  const paths: PendingArg[] = [];
  for (const token of argv) {
    if (!token || token.startsWith('--')) continue;
    // Skip our own executable (always argv[0]; also defensive against
    // odd shells that pass it twice) and the dev-mode "." sentinel.
    if (token.toLowerCase() === myExePathLower) continue;
    if (token === '.') continue;
    if (isFolderOf) {
      // %1 is the clicked file; resolve its parent dir and queue it as a folder
      // load (isFolder:true) so it reuses the normal folder-open pipeline below.
      try {
        if (fs.existsSync(token)) {
          const parent = path.dirname(token);
          if (fs.statSync(parent).isDirectory()) {
            paths.push({ path: parent, isCompare, isAppend, isFolder: true, isRepack });
          }
        }
      } catch {}
    } else if (isFolder) {
      // Folder verb: %1 is a directory path, not a file. Confirm by stat
      // before queueing — protects against weird argv structure (e.g. a
      // file passed instead of a folder; falls through to "no usable path"
      // rather than crashing on scandir later).
      try {
        if (fs.existsSync(token) && fs.statSync(token).isDirectory()) {
          paths.push({ path: token, isCompare, isAppend, isFolder, isRepack });
        }
      } catch {}
    } else {
      const lower = token.toLowerCase();
      if (SUPPORTED_ARCHIVE_EXTS.some(ext => lower.endsWith(ext))) {
        paths.push({ path: token, isCompare, isAppend, isFolder, isRepack });
      }
    }
  }
  return paths;
}

/** Add a batch of args (from one argv parse) to the pending buffer and
 *  schedule a debounced flush. */
function enqueueExplorerArgs(args: PendingArg[]) {
  if (args.length === 0) return;
  pendingArgs.push(...args);
  if (pendingFlushTimer) clearTimeout(pendingFlushTimer);
  pendingFlushTimer = setTimeout(flushExplorerArgs, PENDING_FLUSH_DEBOUNCE_MS);
}

/** Flush the buffered explorer args: figure out what kind of invocation this
 *  was (Compare with exactly 2 files / folder Open / regular Open / append)
 *  and route to the appropriate IPC event on the viewer renderer. Graceful
 *  fallback when invariants don't hold (Compare with !=2 files, folder
 *  contains no .cbz, etc.). */
function flushExplorerArgs() {
  pendingFlushTimer = null;
  const batch = pendingArgs;
  pendingArgs = [];
  if (batch.length === 0) return;

  const vw = getViewerWindow();
  if (!vw || vw.isDestroyed()) {
    // Window not created yet (cold start, very early). Re-queue and try
    // again shortly.
    pendingArgs.push(...batch);
    pendingFlushTimer = setTimeout(flushExplorerArgs, 250);
    return;
  }
  if (vw.webContents.isLoading()) {
    // Window exists but the renderer is still loading the HTML / mounting
    // React. If we send IPC now, the onExplorerOpen / onExplorerCompare
    // listeners (registered in a useEffect after first mount) aren't there
    // yet and the messages get dropped silently. Wait for did-finish-load
    // + a small buffer to let React's useEffect commit (matches the existing
    // env-var auto-load pattern in this file).
    pendingArgs.push(...batch);
    vw.webContents.once('did-finish-load', () => {
      setTimeout(flushExplorerArgs, 500);
    });
    return;
  }

  // Bring window forward (matters for second-instance — user clicked something
  // in Explorer, they probably want to see the app).
  if (vw.isMinimized()) vw.restore();
  vw.focus();

  const compareFlagged = batch.some(a => a.isCompare);
  const appendFlagged = batch.some(a => a.isAppend);
  const folderFlagged = batch.some(a => a.isFolder);
  const repackFlagged = batch.some(a => a.isRepack);
  const allPaths = batch.map(a => a.path);
  // Dedupe while preserving order — Explorer can fire the same path twice
  // under certain shell extensions.
  const seen = new Set<string>();
  const paths = allPaths.filter(p => {
    const k = p.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Folder verb: each path is a directory. Scan all of them, combine, treat
  // as a single Open (replace) — the user picked a folder to "go look at."
  if (folderFlagged) {
    const collected: ReturnType<typeof getFileInfoFromPaths> = [];
    const sortDest = paths[0] ?? null;
    for (const folder of paths) {
      const found = scanForCbzFiles(folder);
      for (const f of found) collected.push(f);
    }
    lastFlushTime = Date.now();
    if (collected.length > 0) {
      vw.webContents.send('explorer:open', { files: collected, mode: 'replace', sortDestination: sortDest });
    }
    return;
  }

  if (compareFlagged && paths.length === 2) {
    // The intended Compare invocation: hand the 2 files to the renderer for
    // ad-hoc compare (preserves existing playlist per Phase 11 design).
    const files = getFileInfoFromPaths(paths);
    if (files.length === 2) {
      lastFlushTime = Date.now();
      vw.webContents.send('explorer:compare', { left: files[0], right: files[1] });
      return;
    }
    // Files couldn't be statted (deleted between right-click and dispatch).
    // Fall through to the open path so at least something happens.
  }

  if (repackFlagged && paths.length >= 1) {
    // Repack verb: single-file edit operation. If user multi-selected, we
    // only take the first — repacking N files in one shot isn't a thing.
    // Renderer appends the file to the playlist, switches cursor to it,
    // extracts, and enters repack mode once extraction completes.
    const files = getFileInfoFromPaths([paths[0]]);
    if (files.length === 1) {
      lastFlushTime = Date.now();
      vw.webContents.send('explorer:repack', { file: files[0] });
      return;
    }
  }

  // Default Open path. Mode selection:
  //   - --append flag: always APPEND (the "Add to CBZ Player Playlist" verb)
  //   - Stragger: a second batch arriving within STRAGGER_GROUPING_WINDOW_MS
  //     after the previous flush is treated as the same multi-select op. The
  //     first batch may have been "single file replace"; the stragglers must
  //     APPEND to it or we'd lose all the earlier loads. This is the fix for
  //     "select 10 .cbz files, only the last one ends up in the playlist."
  //   - Single file (no special flag, no stragger): REPLACE the playlist,
  //     matching the in-app drop semantics for dropping on the viewer.
  //   - Multi-file (no special flag, no stragger): APPEND, matching the
  //     in-app drop semantics for dropping on the playlist panel.
  const now = Date.now();
  const isStragger = lastFlushTime > 0 && (now - lastFlushTime) < STRAGGER_GROUPING_WINDOW_MS;
  const mode: 'replace' | 'append' =
    appendFlagged || isStragger || paths.length > 1 ? 'append' : 'replace';
  const files = getFileInfoFromPaths(paths);
  if (files.length > 0) {
    const sortDestination = detectSortDestination(paths);
    lastFlushTime = now;
    vw.webContents.send('explorer:open', { files, mode, sortDestination });
  }
}

// Undo-trash holding folder. Purges go here first (instead of straight to
// the Recycle Bin) so they can be undone via Ctrl+Z. On the next purge, on
// app quit, or on next startup (sweep), held files graduate to the actual
// Windows Recycle Bin via shell.trashItem.
const holdingFolder = path.join(app.getPath('userData'), 'cbz-player-undo-trash');

// Subsequent launches (Explorer right-click → Open / Compare with multi-select,
// or any other second invocation) hand their argv to this instance via Electron's
// second-instance event. Parse + enqueue; the debounce in flushExplorerArgs
// batches the per-file invocations Windows fires.
app.on('second-instance', (_event, argv, _workingDirectory) => {
  enqueueExplorerArgs(parseExplorerArgv(argv));
});

app.whenReady().then(() => {
  const config = loadConfig();

  // Cold-start argv from Explorer (.cbz files passed by Windows when the user
  // double-clicks / Open With / Compare from a fresh state). Same parser as
  // second-instance; debounce ensures cold-start argv and any rapid follow-up
  // second-instance events get batched together.
  enqueueExplorerArgs(parseExplorerArgv(process.argv));

  // Ensure the holding folder exists, and sweep anything stranded by a
  // previous crashed/force-closed session into the real Recycle Bin.
  try {
    if (!fs.existsSync(holdingFolder)) fs.mkdirSync(holdingFolder, { recursive: true });
    const stranded = listStrandedHoldingFiles(holdingFolder);
    for (const p of stranded) {
      shell.trashItem(p).then(() => cleanupHoldingSubfolder(p)).catch(() => {
        // Best-effort sweep — if it fails we leave it; next startup tries again.
      });
    }
  } catch {}

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

  // ─── Memory diagnostics (monitoring only — NO behavior change) ───────────────
  // Added after a one-off freeze→whole-app-vanish on a long browsing session
  // (session 13). Appends per-process memory + extraction/slot counts to a debug
  // log that SURVIVES a crash, and logs the exact reason any process dies
  // (Electron reports 'oom', 'crashed', etc.). If the crash recurs, this file
  // tells us whether it's a memory leak and which process. Safe to delete.
  const memDebugPath = path.join(app.getPath('userData'), 'cbz-mem-debug.log');
  const appendMemLine = (line: string) => {
    try { fs.appendFileSync(memDebugPath, line + '\n'); } catch {}
  };
  try {
    // Rotate if it grew large across sessions (keep one previous file).
    if (fs.existsSync(memDebugPath) && fs.statSync(memDebugPath).size > 2 * 1024 * 1024) {
      try { fs.unlinkSync(memDebugPath + '.old'); } catch {}
      try { fs.renameSync(memDebugPath, memDebugPath + '.old'); } catch {}
    }
  } catch {}
  appendMemLine(`\n=== session start ${new Date().toISOString()} ===`);
  const sampleMemory = (tag = '') => {
    try {
      const metrics = app.getAppMetrics();
      const totalMB = Math.round(metrics.reduce((s, m) => s + (m.memory.workingSetSize || 0), 0) / 1024);
      const breakdown = metrics
        .map(m => `${m.type}:${Math.round((m.memory.workingSetSize || 0) / 1024)}MB`)
        .join(' ');
      const { slotCount, extractionCounter } = getSlotDebugInfo();
      appendMemLine(`${new Date().toISOString()} | ext=${extractionCounter} slots=${slotCount} | totalMB=${totalMB} | ${breakdown}${tag ? ' | ' + tag : ''}`);
    } catch {}
  };
  sampleMemory('startup');
  const memDebugTimer = setInterval(() => sampleMemory(), 10000);
  app.on('before-quit', () => clearInterval(memDebugTimer));
  // Log the exact reason any process dies — 'oom' here would confirm the leak theory.
  app.on('child-process-gone', (_e, details) => {
    sampleMemory(`CHILD-GONE type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
  });
  viewer.webContents.on('render-process-gone', (_e, details) => {
    sampleMemory(`RENDER-GONE(viewer) reason=${details.reason} exitCode=${details.exitCode}`);
  });
  playlist.webContents.on('render-process-gone', (_e, details) => {
    sampleMemory(`RENDER-GONE(playlist) reason=${details.reason} exitCode=${details.exitCode}`);
  });

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
    const results: { path: string; success: boolean; error?: string }[] = [];
    for (const fp of filePaths) {
      try {
        await retryOperation(() => trashWithFallback(fp));
        results.push({ path: fp, success: true });
      } catch (err: any) {
        results.push({ path: fp, success: false, error: err?.message ?? 'unknown error' });
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
    // Try Electron's shell.trashItem first. It's fast and well-tested for
    // typical paths. Do NOT add a \\?\ prefix here — its underlying
    // SHCreateItemFromParsingName backend doesn't accept that path format
    // (the session-11 first fix tried that; it just changed the failure mode).
    let primaryErr: any = null;
    try {
      await shell.trashItem(filePath);
      return;
    } catch (err: any) {
      primaryErr = err;
    }

    // shell.trashItem failed. Fall back to direct IFileOperation via inline C#
    // in PowerShell. The previous fallback used Microsoft.VisualBasic.FileIO
    // .FileSystem.DeleteFile, which is fundamentally incompatible with long
    // paths (PathTooLongException without prefix; NotSupportedException with
    // \\?\ prefix). IFileOperation uses Unicode shell APIs throughout and
    // handles long paths natively. See LONG_PATH_TRASH_CSHARP at the top of
    // this file for the full background and flag rationale.
    await new Promise<void>((resolve, reject) => {
      const escaped = filePath.replace(/'/g, "''");
      const script = `Add-Type -TypeDefinition @'\n${LONG_PATH_TRASH_CSHARP}\n'@\n[LongPathTrash]::SendToRecycleBin('${escaped}')`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000 }, (err: any, _stdout: string, stderr: string) => {
        if (err) {
          const reason = (stderr?.trim()) || err.message || 'unknown';
          const primary = primaryErr?.message || primaryErr || 'unknown';
          reject(new Error(`Trash failed. shell.trashItem: ${primary}. IFileOperation: ${reason}`));
        } else {
          resolve();
        }
      });
    });
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
        // Purge into the holding folder instead of straight to Recycle Bin so
        // it can be undone (Ctrl+Z) within the session. The renderer's undo
        // bookkeeping will call `file:graduate-purge` to push the previously
        // held file into the real Recycle Bin when a new sort overwrites the
        // undo snapshot, and on app quit.
        const heldPath = await retryOperation(async () => moveToHolding(filePath, holdingFolder));
        return { success: true, isDupe: false, destPath: heldPath, action: 'purge' };
      } catch (err: any) {
        return { success: false, error: err.message ?? 'Failed to purge' };
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

  // Reverse a previous sort. Works for both move-style sorts (file lives in
  // its category folder) and purge (file lives in our holding folder). For
  // the purge case we also remove the now-empty UUID subfolder inside the
  // holding folder once the file has been moved back out.
  ipcMain.handle('file:unsort', async (_event, currentPath: string, originalPath: string) => {
    try {
      const file = await retryOperation(async () => unsortFile(currentPath, originalPath));
      // If the file lived in our holding folder, its UUID subfolder is now
      // empty — tidy up so the holding folder doesn't accumulate empties.
      const parentDir = path.dirname(currentPath);
      if (path.dirname(parentDir) === holdingFolder) {
        cleanupHoldingSubfolder(currentPath);
      }
      return { success: true, file };
    } catch (err: any) {
      return { success: false, error: err.message ?? 'Failed to undo sort' };
    }
  });

  // Push a held purge file from the holding folder into the actual Windows
  // Recycle Bin. Called by the renderer when a new sort/purge overwrites the
  // undo snapshot (so the user can still recover the file via Windows even
  // though it's no longer undoable in-app), and also from app:quit below.
  ipcMain.handle('file:graduate-purge', async (_event, heldPath: string) => {
    try {
      await retryOperation(() => trashWithFallback(heldPath));
      cleanupHoldingSubfolder(heldPath);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message ?? 'Failed to graduate held file' };
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
  ipcMain.on('app:quit', async (_event, uiState?: any) => {
    saveWindowState(uiState);
    // Save session log if stats were provided
    if (uiState?.sessionLog) {
      saveSessionLog(uiState.sessionLog);
    }
    // Graduate any held purge file into the real Recycle Bin before quitting
    // so the user can still recover it from Windows after the app exits. We
    // await this — if we fire-and-forget, app.quit() can kill the process
    // before shell.trashItem completes and the file gets stranded for the
    // next startup sweep to handle. A few hundred ms of extra quit time is
    // worth the consistent state.
    if (uiState?.pendingPurgeHeldPath) {
      try {
        await trashWithFallback(uiState.pendingPurgeHeldPath);
        cleanupHoldingSubfolder(uiState.pendingPurgeHeldPath);
      } catch {
        // If graduation fails, the startup sweep on next launch will retry.
      }
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
