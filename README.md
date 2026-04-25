# CBZ Player v5

A built-in CBZ reader with a sorting playlist on the side — read, sort, compare, and repack thousands of comics from one keyboard-driven window, without breaking your reading flow.

![Hero — CBZ Player v5 in docked mode, viewer on the left and playlist panel with sort buttons on the right](assets/screenshot-main-view.png)
<!-- Replace with actual screenshot before publishing -->

---

## The problem

If you've got thousands of CBZs sitting in a single folder — especially oneshots, where each file is its own self-contained read — the act of going through them is brutal.

The default workflow is: open a reader, read a file, decide if you want to keep it, exit the reader, find the file in your file manager, drag it somewhere or delete it, then go back to the reader and open the next one. Every decision breaks the reading flow. By the end of a session you've spent more time alt-tabbing than reading.

Then there are the files that need fixing. Some doujins ship with duplicate pages — page 1, page 1, page 2, page 2 — or with multiple language versions stuffed into one archive (10 pages EN, 10 pages JP, all in the same `.cbz`). The only way to fix those is to extract, delete the bad pages, re-zip, rename. Repeat for every offender.

Then there are the duplicates and misnamed companions. You spot `a doujin 2.cbz` sitting alphabetically before `a doujin.cbz` and realize the unnumbered one is actually part 1 — but renaming it means leaving the reader, navigating in your file manager, renaming, going back. By the time you're back you've lost your place.

CBZ Player v5 collapses all of that into one window. Sort hotkeys move files to category folders without ever leaving the page you're on. Built-in repack mode lets you delete duplicate pages and re-archive in place. Compare mode opens two CBZs side by side so you can tell which version to keep. F2 renames the current file inline. The reader, the file manager, and the page editor are the same app — and they all listen to the keyboard while you're reading.

---

## What you get

- **One window for the whole job.** Reader, file manager, page editor, and renamer are the same app. No more alt-tabbing between a viewer and Explorer.
- **Sort without context-switching.** Sort hotkeys (`K` for Keep, `T` for Translate, `F` for To Fix, plus any custom categories you set up) move the current CBZ into a category folder you've configured. `P` for Purge sends it to the recycle bin instead. The CBZ itself is never modified — these are filesystem moves only. After each sort, the next file auto-loads. You can also set a custom output folder per category, so different categories can land on different drives.
- **A real playlist, not just a file list.** The side panel works like a video player playlist — shuffle on/off, jump to a random file, skip-viewed mode, drag a folder onto the viewer to load a fresh queue, drag more files onto the playlist to append. Click any file to jump to it. Files you've already opened get dimmed in the list so you can see at a glance how far you've gotten. Most CBZ readers don't have this; they just hand you a thumbnail grid and call it a day.
- **Built-in compare mode.** Pick any two CBZs and view them side-by-side with synced page navigation. Decide which version to keep, delete the loser inline, exit back to where you were.
- **Built-in repack mode.** See every page as a thumbnail grid. Delete duplicates, rename pages, edit the archive's internal folder name, even rename the CBZ itself — then save. Original gets backed up to `[Repack Backup]` automatically before the new archive replaces it.
- **Inline rename.** Press `F2` while reading to rename the file you're looking at. No leaving the reader.
- **Immerse mode for multi-monitor setups.** One toggle blacks out every monitor except the one the viewer is on, so a busy multi-monitor desk doesn't pull your eye while reading.
- **Handles archives that fight back.** ZIPs disguised as CBZs, RAR archives renamed to `.cbz`, 7z too. Long internal folder names (the kind that normally break Windows' 260-char path limit) work because extraction happens in memory. Cross-drive moves work too.

---

## Install

1. Install **Node.js** from [nodejs.org](https://nodejs.org). The LTS version is fine. ⚠ When the installer asks, make sure "Add to PATH" is checked — otherwise the launcher won't find `npm`.
2. Download or clone this project to a folder on your machine.
3. Double-click **`install.bat`** in the project folder. This runs `npm install` and pulls in Electron, React, and the archive extractors. First run takes a few minutes.
4. Done. Launch the app with **`[000-Run CBZ Player Main.bat`**.

> The legacy v4.1 PowerShell launcher, AutoHotKey global-hotkey daemon, and original v4.1 README live in the `Old CBZ Sorter/` subfolder for reference. They're not part of the v5 app — you only need the launcher above.

**Optional — copy-anywhere folder launcher:** `[000-Run CBZ Player Here].bat` can be copied into any folder containing CBZ files. Double-clicking it launches the app and auto-loads every CBZ in that folder, with the same folder set as the sort destination. Edit the `APP_DIR=` line at the top of the file to match where you installed the app.

---

## How to use

**First time:**
1. Launch via `[000-Run CBZ Player Main.bat`. Two windows open: the viewer (your main monitor) and the playlist (your secondary monitor — vertical works best). If you only have one monitor, you can dock the playlist into the viewer's right side via the Detach/Dock button in the playlist header.
2. Drag a folder containing `.cbz` files onto the viewer. Or drag a single `.cbz`. The playlist fills with everything found, the first file opens, and that folder becomes your sort destination.
3. Read the file using arrow keys, space, or the on-screen Next button.
4. When you've decided what to do with the file, press a sort hotkey:
   - `K` — Keep (moves to `[00-Keep]`)
   - `P` — Purge (sends to recycle bin)
   - `F` — To Fix (moves to `[Needs Fixing]`)
   - `T` — Translate (moves to `[To Be Translated OG]`)
   - `I` — Inquire (moves to `[00-Keep]/[00-Inquire]`)
   - `U` — Unreadable (moves to `[File Name Too Long]`)

   The file moves to the matching folder (or to the recycle bin for Purge), and the next file auto-loads. By default these folders are created next to your source CBZs — you can change this per category in Settings.

5. To customize categories, hotkeys, folder destinations, and more: open **Settings** with `Ctrl+,` or the gear icon in the playlist header.

![Inline — Settings modal showing the six tabs (Sort Categories, Folders, Viewer, Repack, UI Behavior, Shortcuts)](assets/screenshot-settings.png)
<!-- Replace with actual screenshot before publishing -->

**Compare two CBZs side-by-side:**
1. Click the Compare button in the playlist (cycles: Off → Pick with current → Pick two → Off), or right-click a file and choose "Compare with current."
2. Click the second file. The split view opens.
3. Page navigation is synced by default. Toggle independent navigation with `Ctrl+I`.
4. Use Delete Left / Delete Right to send the loser to the recycle bin and exit back to where you were.

**Repack a CBZ (delete duplicate pages, rename, change folder structure):**
1. With the file open, click Repack in the playlist's Tools group.
2. Thumbnail grid shows every page. Click to select; Ctrl+click for multiple; `Delete` removes selected pages.
3. Edit the filename and internal folder name in the header inputs.
4. Click **Save** to repack and stay in repack mode (lets you keep iterating). Click **Repack & Save** to repack and exit back to reading.
5. Original CBZ gets copied to `[Repack Backup]` in the same folder before being replaced.

**Rename a file you're reading:** Press `F2`. A textarea opens with the filename pre-selected (extension excluded). Enter to save, Escape to cancel.

**See every keyboard shortcut:** Settings → Shortcuts tab.

---

## Known limitations & bugs

| Item | Notes |
|---|---|
| **Windows-only.** | Built and tested on Windows. The launchers (`.bat` files), recycle-bin fallback (PowerShell VisualBasic), and Immerse mode's taskbar workaround all rely on Windows-specific behavior. Other platforms aren't supported right now. |
| **Runs from source, not a `.exe`.** | Phase 11 (electron-builder packaging) isn't done yet. You need Node.js installed and you launch via the `.bat` files. A standalone portable `.exe` is on the roadmap. |
| **Memory cost during viewing.** | In-memory extraction means a 400MB CBZ holds ~400MB in RAM while you're viewing it. Compare mode with two open files = up to 800MB. Fine on any modern machine, but worth knowing. |
| **Some CBZs fail all extractors.** | Files that are actually RAR5 archives or use obscure 7z compression methods can fail to open. There's no fallback past 7z + node-unrar-js — the file gets skipped with an error in the log panel. |
| **Cover image occasionally shows the previous file** during very rapid navigation. Mitigated by a counter that discards stale extraction results, but can still trigger under heavy spam-clicking. Resolves on next navigation. |
| **Repack center-offset is approximate** when both the thumbnail panel and the playlist panel are visible. Image is centered close to dead-center, not exactly. Not a functional issue. |
| **No metadata or reading-history tracking.** | This is a sorting/reading workflow tool, not a managed library. If you need metadata, tags, collections across a curated library, multi-user, or progress sync, use Kavita or LANraragi instead. |

---

## Troubleshooting

**`npm` is not recognized as a command, or install.bat fails.** — Node.js wasn't added to your PATH. Re-run the Node.js installer and make sure "Add to PATH" is checked, or install Node fresh.

**App opens but no pages display.** — Usually an extraction race. Press Next then Previous to retry the current file. If it persists, check the in-app log panel (right side of the playlist) for the actual error.

**Sort fails with "Drive X:\ is not available."** — The override path you configured for that category is on a drive that isn't currently mounted (USB unplugged, network share offline, etc.). Either mount the drive or change the override in Settings → Sort Categories.

**Sort or repack errors with `EXDEV`.** — Shouldn't happen anymore (cross-drive moves fall back to copy+unlink), but if it does, file an issue. Workaround: configure the destination on the same drive as the source.

**The legacy v4.1 PowerShell version opens instead of v5.** — You launched the old launcher in `Old CBZ Sorter/[000-RunCBZ_Sorter Launcher].bat`. Use `[000-Run CBZ Player Main.bat` in the project root for the v5 app.

**Settings hotkeys interfere with the app's hotkeys.** — Shouldn't happen — the app disables global hotkeys while the Settings modal is open. If it does, file an issue with reproduction steps.

**Immerse mode doesn't fully cover one of my monitors.** — Should be fixed in v0.8 (the blackout windows go into native fullscreen on Windows to cover the taskbar). If you still see a gap, tell us which monitor (resolution + scale factor) — likely a mixed-DPI quirk specific to your setup.

**Page transitions show a brief black flash.** — Should also be fixed in v0.8 (decode-before-swap + page preloading). If you still see flicker, tell us your CBZ's typical page resolution.

---

## TL;DR for Monke

- Read CBZ. Sort CBZ. No alt-tab.
- Press a key (`K`, `T`, `F`, etc.) → file moves to a folder. Press `P` → file goes to recycle bin.
- Side panel = playlist. Like a video player. Shuffle, random, skip-viewed all work.
- Two CBZs side by side = compare mode. Pick the one to keep.
- Bad pages in a CBZ? Open repack mode. Delete pages, rename, save. Old version backed up.
- `F2` = rename the file you're reading.
- Got multiple monitors? Immerse mode blacks out the others so you can read in peace.
- Windows only. Run the `.bat` file. No `.exe` yet (coming soon).
