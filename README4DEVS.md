# CBZ Player v5 — Developer Reference

> For the user-facing README, see [README.md](README.md).

---

## Tech stack & dependencies

| Layer | Tech |
|---|---|
| Runtime | Electron 41 (Chromium + Node.js) |
| Renderer | React 19, Tailwind CSS 4, TypeScript 6 |
| Main process | Node.js + TypeScript 6 |
| Build | Vite 8 (renderer), `tsc` (main process), electron-builder (packaging — Phase 11, untested) |
| Archive extraction | `7zip-bin` (bundled `7za.exe`, ZIP/7z), `node-unrar-js` (RAR via WASM), `yauzl` (in-memory ZIP) |
| Image serving | Custom Electron `cbz-image://` protocol |
| Config | Plain JSON via `app.getPath('userData')/cbz-player-config.json` (auto-migrates from the old `cbz-sorter-config.json` filename on first launch after rename) |

`adm-zip`, `extract-zip`, `node-7z` are in `package.json` but mostly superseded — left in as fallback options.

**Platform target:** Windows. The launchers are `.bat`, the recycle-bin fallback shells out to PowerShell, and Immerse mode's Windows-taskbar workaround uses `setFullScreen(true)` on each blackout window. macOS/Linux not tested.

---

## Project structure

```
CBZ Player/
  package.json
  tsconfig.json                # renderer TS config
  tsconfig.node.json           # main process TS config
  vite.config.ts
  install.bat                  # npm install wrapper
  [000-Run CBZ Player Main.bat # v5 launcher (typecheck + dev mode)
  [000-Run CBZ Player Here].bat# copy-anywhere folder launcher (sets CBZ_PLAYER_FOLDER env)
  Old CBZ Sorter/              # archived v4.1 PowerShell+AHK predecessor (reference only)
  src/
    main/                      # Electron main process
      index.ts                 # App entry, ~50 IPC handlers, menu, custom protocol
      window-manager.ts        # Two-window creation; Immerse blackout window manager
      preload.ts               # contextBridge API exposed to renderer
      file-operations.ts       # Scan, sort with dupe detection, retry, EXDEV fallback,
                               #   resolveCategoryBasePath
      cbz-extractor.ts         # In-memory ZIP/RAR; disk-fallback 7z; named-slot extraction
      config-store.ts          # JSON persistence for ~30 settings
      session-logger.ts        # End-of-session stats writer
    renderer/                  # React app
      index.html
      main.tsx
      App.tsx                  # ~1300 lines; ViewerWindow + PlaylistWindow + usePlaylistState
      components/
        CbzViewer.tsx          # 4 view modes; decode-before-swap; ±3 page preload
        CompareViewer.tsx      # Side-by-side w/ synced or independent navigation
        RepackViewer.tsx       # Thumbnail grid, page edit, in-place repack
        PlaylistPanel.tsx      # Sort buttons, toggles, context menu, Immerse toggle
        SettingsModal.tsx      # 6 tabs: Categories, Folders, Viewer, Repack, UI, Shortcuts
      hooks/
        useHotkeys.ts          # 40+ shortcuts; Ctrl+Shift / Ctrl+Alt / plain-Ctrl branches
        useNavigation.ts       # Playlist navigation logic
      lib/
        types.ts               # Shared TypeScript interfaces
  dist/                        # Compiled output (gitignored)
```

The Obsidian vault at `H:\[02-AHW Data]\[Obsidian]\Claude Code Vault\CBZ Player\` holds the long-form architecture, decision log, changelog, and flowcharts. There's no in-repo `docs/` or `SPEC.md` — the vault plus this file pair are the spec.

---

## How to run from source

```bash
npm install                              # one-time
npm run dev                              # Vite + Electron concurrently (preferred for dev)

npm run dev:renderer                     # Vite only (port 5173)
npm run dev:main                         # tsc + electron only (needs renderer running)

npm run build                            # full build (renderer + main process)
npm run start                            # electron from built dist
npm run pack                             # electron-builder --win portable (Phase 11, untested)

# Typecheck only (no compile output)
npx tsc -p tsconfig.node.json --noEmit
npx tsc -p tsconfig.json --noEmit --ignoreDeprecations 6.0
```

**Auto-load a folder on launch:** set the `CBZ_PLAYER_FOLDER` environment variable before starting (the legacy name `CBZ_SORTER_FOLDER` is also read for backward compatibility). The main process scans that folder and pushes the file list to the renderer once both windows finish loading. `[000-Run CBZ Player Here].bat` uses this pattern.

**Renderer typecheck has 4 known errors** in `App.tsx` (lines ~587, 1267) and `main.tsx:4` — all pre-date recent feature work and are not regressions from any current development. Don't try to "fix" them as drive-by changes.

---

## Config reference

JSON file at `app.getPath('userData')/cbz-player-config.json`. Loaded via shallow-merge over `DEFAULT_CONFIG` in `config-store.ts` — missing keys fall back to defaults, no schema migrations needed. On first launch after the rename from `cbz-sorter-config.json`, the loader auto-migrates: copies the old file to the new name and deletes the old.

| Key | Type | Default | Purpose |
|---|---|---|---|
| `categories` | `CategoryConfig[]` | 6 defaults (Keep/Purge/Fix/Translate/Inquire/Unreadable) | Sort categories — see schema below |
| `useSourceFolder` | `boolean` | `true` | Global default: create category folders next to source CBZ files |
| `customOutputFolder` | `string` | `''` | Global default when `useSourceFolder=false` |
| `viewerMode` | `'single' \| 'dual-rtl' \| 'dual-ltr' \| 'scroll'` | `'single'` | Default view mode |
| `controlBarMode` | `'auto-hide' \| 'hover-only' \| 'always-visible'` | `'auto-hide'` | Viewer controls bar behavior |
| `controlsHideDelay` | `number` | `1500` | ms before auto-hide controls vanish |
| `paneDark` | `boolean` | `true` | Playlist pane dark mode |
| `viewerDark` | `boolean` | `true` | Viewer dark mode |
| `viewerWindowBounds` | `{x,y,width,height}?` | undefined | Last viewer window position |
| `playlistWindowBounds` | `{x,y,width,height}?` | undefined | Last playlist window position |
| `playlistAlwaysOnTop` | `boolean` | `false` | (Reserved, not currently used) |
| `isDocked` | `boolean` | `false` | Start in docked vs detached mode |
| `dockedPanelWidth` | `number` | `320` | Docked playlist panel width in px |
| `playlistVisible` | `boolean` | `true` | Docked panel visibility (F6 toggles) |
| `centerPage` | `boolean` | `false` | Center page accounting for panel width |
| `logHeight` | `number` | `112` | Log panel height in px |
| `startFullscreen` | `boolean` | `false` | Launch viewer in fullscreen |
| `darkBgBrightness` | `number` | `26` | Dark mode bg gray (0-255) |
| `lightBgBrightness` | `number` | `232` | Light mode bg gray (0-255) |
| `writeLogsEnabled` | `boolean` | `false` | Write end-of-session log file |
| `repackColumns` | `number` | `3` | Default repack thumbnail grid column count |
| `repackThumbnailSize` | `number` | `150` | (Now derived from columns; legacy key) |
| `repackPanelWidth` | `number` | `40` | Repack panel width as percentage |
| `beepOnLastPage` | `boolean` | `true` | Audio cue on reaching last page |
| `beepVolume` | `number` | `0.15` | 0.05 - 1.0 |
| `beepPitch` | `number` | `600` | Hz |

**`CategoryConfig` schema:**
```ts
interface CategoryConfig {
  id: string;              // 'keep', 'purge', or 'custom_<timestamp>'
  label: string;           // Display name (button + log)
  folderName: string;      // Subfolder name; '' for Purge
  hotkey: string;          // Single char
  color: string;           // Tailwind palette ('emerald', 'red', ...)
  parentCategory?: string; // Nested under another category (e.g., Inquire under Keep)
  dupeFolderName?: string; // Where same-name conflicts go
  isPurge?: boolean;       // True only for the Purge category (sends to recycle bin)
  outputPath?: string;     // Per-category override — wins over global default when set
}
```

`Immerse` state is intentionally NOT persisted — always starts `false`.

---

## Architecture notes

**Two-window architecture.** Viewer is the single source of truth (state lives in `usePlaylistState` hook). Detached playlist window is a thin IPC client that mirrors viewer state. Docked mode embeds the playlist as a panel inside the viewer window. Coupled close: closing one window closes both.

**Hotkey dispatcher (`useHotkeys.ts`)** discriminates Ctrl combos into three early-returning branches: `Ctrl+Shift+X`, `Ctrl+Alt+X`, plain `Ctrl+X`. Necessary because `Ctrl+S` (repack save), `Ctrl+Shift+S` (toggle shuffle), and `Ctrl+Alt+S` (randomize playlist) all share the `s` key. Each branch returns early so combos can't double-fire across branches. Local component listeners (RepackViewer's Ctrl+S) live OUTSIDE the central dispatcher and use their own keydown listener with `preventDefault` + `stopPropagation`.

**Image extraction is in-memory for ZIP/RAR.** `extractCbz()` reads the archive bytes via `fs.promises.readFile(path.toNamespacedPath(cbzPath))` (long-path-safe), detects format from magic bytes, and dispatches:
- ZIP → `yauzl.fromBuffer` streams entries into Buffers
- RAR → `node-unrar-js` `createExtractorFromData` (WASM, in-memory)
- 7z → disk fallback only: writes archive bytes to short temp path, runs `7za.exe`, reads back

Each extraction gets a unique `extractionId` and lives in a named slot. `cbz-image://host/{id}/{filename}` protocol serves Buffers directly from memory (zero fs calls) for memory sources, or `fs.promises.readFile(toNamespacedPath(...))` for disk sources. Slot reuse for compare mode (`compare-left`, `compare-right`) — those responses include `Cache-Control: no-store` to prevent cross-session URL cache poisoning.

**Sort action pipeline:**
1. `resolveCategoryBasePath(category, useSourceFolder, customOutputFolder, sortDestination)` — precedence: per-category `outputPath` override > global `customOutputFolder` (when source-folder mode is off) > source file's parent dir
2. Drive-mount check via `fs.existsSync(path.parse(baseFolder).root)` — fail loud if missing. **Use plain path here, not `nsp()`** — the `\\?\` prefix makes `existsSync` return false even for mounted drives when the path is a drive root.
3. Auto-create destination subfolders via `fs.mkdirSync({recursive: true})` (already long-path-safe via `nsp()`)
4. Move via `fs.renameSync` with `EXDEV` fallback to `copyFileSync + unlinkSync` (cross-drive moves)
5. Override on a child category skips parent nesting (e.g., overridden Inquire goes straight to its override, not nested under `[00-Keep]`)

**Page rendering (CbzViewer)** has two states: `currentPage` (where the user navigated) and `displayedPage` (what's actually rendered). A decode-before-swap effect spins up an offscreen `Image()` for the target page (and dual-mode neighbor), calls `HTMLImageElement.decode()` (a Promise that resolves once the bitmap is fully decoded), and only then commits `setDisplayedPage`. A parallel preload effect calls `decode()` for ±3 pages around the current — decoded bitmaps land in Chromium's URL-keyed image cache. Combined: navigation is one render frame (~16ms), no flicker, no partial state. The `<img>` deliberately has no `key` prop — React keeps the same DOM node across page changes. `useImageRetry` is URL-aware (`if (img.src === failedSrc)` before retry) to prevent stale retries from clobbering a fresh src.

**Immerse mode (`window-manager.ts`)** maintains a `Map<displayId, BrowserWindow>` of frameless, focusable:false blackout windows on every display except the viewer's. Reconciles via `screen.on('display-added' | 'display-removed' | 'display-metrics-changed')` + viewer `move` event (200ms debounced). On Windows, blackout windows enter native fullscreen (`setFullScreen(true)`) — required to cover the taskbar, which has its own topmost z-order exception that defeats plain `setAlwaysOnTop('screen-saver')`. The viewer is briefly promoted to `setAlwaysOnTop('screen-saver')` for the duration so it stays visible above blackouts. Mutual exclusion with detached playlist: `layout:set-docked` IPC handler force-disables Immerse and broadcasts `immerse:changed=false` when transitioning to detached. `destroyAllBlackouts()` is called in every close/quit path (viewer closed, playlist closed, app:quit IPC, window-all-closed) — blackout windows have `closable: false` so they need explicit destroy.

**`ensureSortFolders()` is dead code** — imported by `index.ts` but never called. Folder creation now happens lazily inside `sortFile()` via the existing recursive mkdir. Left as-is for scope discipline; remove the function and its import together if you do clean it up.

---

## Known issues & technical debt

- **Phase 11 packaging not tested.** `npm run pack` runs `electron-builder --win portable`, but no portable `.exe` has been produced and tested yet. File association for `.cbz`, command-line argument support, and the auto-load env-var path under packaged mode all need verification.
- **Renderer typecheck has 4 pre-existing errors** in `App.tsx` (`progress.slot` access at ~line 587, `Set<unknown>` assignment at ~line 1267) and `main.tsx:4` (CSS side-effect import without type declaration). All pre-date current feature work. Functional, just type-noise.
- **`ensureSortFolders()` is dead code** (see Architecture Notes).
- **`repackThumbnailSize` config key is legacy** — thumbnail size is now derived from column count, not stored.
- **Memory pressure on very large CBZs.** In-memory extraction means ~400MB CBZ = 400MB heap during viewing; compare mode = up to 800MB. Worker thread or streaming-decode would address this; not blocking on modern hardware.
- **Cover image race during very rapid navigation** — counter-based stale-result discard is partial mitigation. Does not fully eliminate.
- **Repack center-offset is approximate** when both thumbnail and playlist panels are visible; exact calculation would require a layout observer.
- **Some CBZs fail all extractors** (RAR5, obscure 7z compression methods). Skipped with error log entry; no further fallback.
- **Per-monitor DPI quirks possible** on multi-monitor setups with mixed scale factors. The Immerse blackouts and the viewer's centering math both have explicit guards (`setBounds` re-assertion, content-width clamping), but new Electron versions occasionally regress display-bounds rounding behavior.

**Legacy v4.1 artifacts archived in `Old CBZ Sorter/`:** `[000-RunCBZ_Sorter Launcher].bat`, `[001-CBZ_Sorter].ps1`, `[002-CBZSorterGlobalHotKeys].ahk`, `[003-CBZ_Sorter_README].txt`, `[005-v4.1_IMPLEMENTATION_SUMMARY].txt`. Reference only — not part of the v5 build chain.
