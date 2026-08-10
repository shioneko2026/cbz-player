; ─── CBZ Player custom NSIS install/uninstall macros ─────────────────────────
;
; electron-builder's `fileAssociations` config registers the default Open verb
; for .cbz (so double-click and "Open with CBZ Player" work, and "Make default
; via Windows Settings" flips the .cbz default handler to our ProgID). This
; file adds CUSTOM right-click verbs — Compare 2, Add to Playlist, Repack —
; that electron-builder doesn't generate on its own.
;
; ARCHITECTURE NOTE (session 11): the custom .cbz verbs live under
; HKCU\Software\Classes\SystemFileAssociations\.cbz\shell\* rather than the
; ProgID's shell\ subkey. SystemFileAssociations is Microsoft's documented
; additive-verb mechanism that fires regardless of which app is the active
; default handler for the extension. The old ProgID-only location (used in
; v0.9.0-session10) made the verbs invisible unless CBZ Player was set as
; the default .cbz app — a workflow friction the user surfaced during
; session 11 stress testing. Same pattern is used for .zip/.rar/.7z Repack.
;
; Per-user install (HKCU), no admin elevation. All keys are removed on
; uninstall.
;
; PROGID NOTE (kept for historical context): electron-builder uses the
; `name` field from fileAssociations (here: "CBZ Archive") AS the registry
; ProgID key — NOT the convention `<exe>.<ext>` we initially assumed.
; Empirically verified by inspecting HKCU\Software\Classes\ after install.
; The default Open verb that electron-builder generates IS still under the
; ProgID — we just don't put our custom verbs there anymore.

!define PROGID "CBZ Archive"

!macro customInstall
  ; Migration: an earlier (broken) installer wrote the Compare verb under the
  ; wrong ProgID `<exe>.cbz`. Clean that up so users who installed the broken
  ; build don't have stale keys after upgrading.
  DeleteRegKey HKCU "Software\Classes\${APP_EXECUTABLE_FILENAME}.cbz"

  ; Migration: session 11 moved the .cbz custom verbs from ${PROGID} to
  ; SystemFileAssociations. Clean up the old ProgID-located keys so they
  ; don't linger after over-install (NSIS over-install doesn't run
  ; customUnInstall, so this migration has to happen in customInstall).
  DeleteRegKey HKCU "Software\Classes\${PROGID}\shell\compare"
  DeleteRegKey HKCU "Software\Classes\${PROGID}\shell\addtoplaylist"
  DeleteRegKey HKCU "Software\Classes\${PROGID}\shell\repack"

  ; Migration: session 13 renamed the four .cbz verb subkeys with numeric
  ; prefixes (01compare / 02repack / 03addtoplaylist / 04openfolder). Delete the
  ; old un-prefixed subkeys first so an over-install doesn't leave BOTH the old
  ; and new verbs (each entry would appear twice).
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\compare"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\addtoplaylist"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\repack"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\openfolder"

  ; Desired context-menu order (top→bottom): Compare, Repack, Add to Playlist,
  ; Open this folder.
  ;
  ; HOW THE ORDER IS FORCED — read before "cleaning this up" (session 14):
  ; Session 13 assumed Windows sorts static verbs alphabetically by SUBKEY NAME
  ; and added the 01–04 subkey prefixes. That assumption is WRONG on Windows 11
  ; (verified on build 26200): the menu came out Add / Compare / Open / Repack,
  ; which is alphabetical by the VISIBLE LABEL, not the subkey name. Diagnosed
  ; with the deployed build installed, registry keys confirmed correct and free
  ; of leftovers, and the machine freshly rebooted — so it was neither a missing
  ; deploy nor a stale Explorer menu cache.
  ;
  ; So the LABELS carry the numeric prefixes ("1 Compare…", "2 Repack…", …).
  ; The 01–04 SUBKEY prefixes are deliberately KEPT as well: they cost nothing
  ; and they produce the same correct order on any Windows that does sort by
  ; subkey name. Belt and suspenders — don't strip either one.
  ;
  ; Side effect worth knowing: because every label now starts with a digit, all
  ; four CBZ Player verbs sort above other apps' verbs in the same menu.

  ; ── Verb 1 (order 01): "Compare 2 in CBZ Player" on .cbz ────────────────
  ; Shows on right-click of any .cbz REGARDLESS of which app is the default
  ; .cbz handler. SystemFileAssociations is Windows' documented additive-
  ; verb mechanism that doesn't disrupt whatever else is registered.
  ;
  ; Label is "Compare 2" so the user knows the verb needs exactly 2 files
  ; selected. We can't conditionally hide the verb based on selection count
  ; without a shell extension DLL (rejected as overkill for v1) — explicit
  ; label is the cheap-but-clear alternative. Invocation with !=2 files
  ; gracefully falls back to a normal Open (no error dialog).
  ;
  ; NOTE: ${APP_EXECUTABLE_FILENAME} already INCLUDES the .exe extension.
  ; Appending another .exe produces "CBZ Player.exe.exe" which doesn't exist.
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\01compare" "" "1 Compare 2 in CBZ Player"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\01compare" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\01compare\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --compare "%1"'

  ; ── Verb 2: "Add to CBZ Player Playlist" on .cbz ────────────────────────
  ; Shows on right-click of any .cbz REGARDLESS of default handler. Always
  ; appends (regardless of file count or whether the app is currently
  ; running). Useful when the user wants to explicitly add files to an
  ; existing playlist instead of letting the default Open verb decide
  ; replace-vs-append based on count.
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\03addtoplaylist" "" "3 Add to CBZ Player Playlist"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\03addtoplaylist" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\03addtoplaylist\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --append "%1"'

  ; ── Verb 3a: "Repack this CBZ" on .cbz files ────────────────────────────
  ; Shows on right-click of any .cbz REGARDLESS of default handler. Loads
  ; the file into the playlist, extracts, and enters repack mode
  ; automatically once extraction completes. Single-file operation — if
  ; user multi-selects, only the first is taken.
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\02repack" "" "2 Repack this CBZ"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\02repack" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\02repack\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --repack "%1"'

  ; ── Verb 3b: "Repack with CBZ Player" on non-.cbz archive types ─────────
  ; Same Repack verb, added to .zip / .rar / .7z via SystemFileAssociations
  ; so it works on those without disrupting their existing default handlers
  ; (Windows compressed folder, 7-Zip, WinRAR, etc.). The verb appears as
  ; an additional right-click option alongside whatever else is registered.
  ; Label is "Repack with CBZ Player" rather than ".cbz variant's 'Repack
  ; this CBZ'" since these files aren't .cbz and the "this CBZ" wording
  ; would be technically wrong. The extractor uses magic bytes so all four
  ; formats decompress the same way internally.
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.zip\shell\repack" "" "Repack with CBZ Player"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.zip\shell\repack" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.zip\shell\repack\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --repack "%1"'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.rar\shell\repack" "" "Repack with CBZ Player"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.rar\shell\repack" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.rar\shell\repack\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --repack "%1"'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.7z\shell\repack" "" "Repack with CBZ Player"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.7z\shell\repack" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.7z\shell\repack\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --repack "%1"'

  ; ── Verb 4: "Open in CBZ Player" (folder context menu) ──────────────────
  ; Shows on right-click of any FOLDER (not .cbz files). Scans the folder
  ; for .cbz files and loads them all as a fresh playlist. The folder path
  ; doubles as the sort destination (matches "load the folder" intent).
  ; Lives under Directory and Directory\Background — the latter is what
  ; shows when right-clicking the empty space inside an open folder window.
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCbzPlayer" "" "Open in CBZ Player"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCbzPlayer" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCbzPlayer\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --folder "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCbzPlayer" "" "Open this folder in CBZ Player"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCbzPlayer" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCbzPlayer\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --folder "%V"'

  ; ── Verb 5: "Open this folder in CBZ Player" on .cbz FILES ───────────────
  ; File-context counterpart to Verb 4. Right-clicking a .cbz opens its
  ; CONTAINING folder as a fresh playlist (all supported archives in the
  ; folder, starting at the first). %1 is the FILE, so the app resolves the
  ; parent directory itself via the --folder-of flag. Lives under
  ; SystemFileAssociations\.cbz so it appears regardless of the default handler.
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\04openfolder" "" "4 Open this folder in CBZ Player"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\04openfolder" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\04openfolder\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --folder-of "%1"'
!macroend

!macro customUnInstall
  ; Remove all custom verb registry entries we created. The default Open verb
  ; on .cbz (and the .cbz association itself) are removed by electron-builder's
  ; own uninstall logic based on the fileAssociations config.
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\01compare"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\02repack"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\03addtoplaylist"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\04openfolder"
  ; Belt-and-suspenders: also remove the pre-session-13 un-prefixed subkeys.
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\compare"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\addtoplaylist"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\repack"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.cbz\shell\openfolder"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInCbzPlayer"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInCbzPlayer"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.zip\shell\repack"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.rar\shell\repack"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.7z\shell\repack"
  ; Belt-and-suspenders: clean up any leftover ProgID-located entries from
  ; pre-session-11 installs that didn't get the customInstall migration.
  DeleteRegKey HKCU "Software\Classes\${PROGID}\shell\compare"
  DeleteRegKey HKCU "Software\Classes\${PROGID}\shell\addtoplaylist"
  DeleteRegKey HKCU "Software\Classes\${PROGID}\shell\repack"
  ; Belt-and-suspenders: clean any leftover from the broken-ProgID era.
  DeleteRegKey HKCU "Software\Classes\${APP_EXECUTABLE_FILENAME}.cbz"
!macroend
