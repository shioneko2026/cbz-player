; ─── CBZ Player custom NSIS install/uninstall macros ─────────────────────────
;
; electron-builder's `fileAssociations` config registers the default Open verb
; for .cbz (so double-click and "Open with CBZ Player" work). This file adds
; a CUSTOM right-click verb — "Compare in CBZ Player" — that electron-builder
; doesn't generate on its own. The Compare verb fires the same executable with
; a `--compare` flag, which the main process detects (via argv parsing in
; src/main/index.ts) and routes through the second-instance debounce so a
; multi-select of 2 files lands as one ad-hoc compare invocation.
;
; Per-user install (HKCU), no admin elevation. All keys are removed on
; uninstall.
;
; PROGID NOTE: electron-builder uses the `name` field from fileAssociations
; (here: "CBZ Archive") AS the registry ProgID key — NOT the convention
; `<exe>.<ext>` we initially assumed. Empirically verified by inspecting
; HKCU\Software\Classes\ after install. The Compare verb must be written
; under the SAME ProgID Windows actually consults when reading verbs for
; .cbz files, or it never appears in the right-click menu.

!define PROGID "CBZ Archive"

!macro customInstall
  ; Migration: an earlier (broken) installer wrote the Compare verb under the
  ; wrong ProgID `<exe>.cbz`. Clean that up so users who installed the broken
  ; build don't have stale keys after upgrading.
  DeleteRegKey HKCU "Software\Classes\${APP_EXECUTABLE_FILENAME}.cbz"

  ; ── Verb 1: "Compare in CBZ Player" ─────────────────────────────────────
  ; Shows on right-click of any .cbz (visibility can't be conditional on
  ; selection-count without a shell extension DLL — too heavy for v1). When
  ; invoked with != 2 files the main process gracefully falls back to a normal
  ; playlist load with a log entry explaining what happened.
  ; NOTE: ${APP_EXECUTABLE_FILENAME} already INCLUDES the .exe extension.
  ; Appending another .exe produces "CBZ Player.exe.exe" which doesn't exist.
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\compare" "" "Compare in CBZ Player"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\compare" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\compare\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --compare "%1"'

  ; ── Verb 2: "Add to CBZ Player Playlist" ────────────────────────────────
  ; Shows on right-click of any .cbz. Always appends (regardless of file
  ; count or whether the app is currently running). Useful when the user
  ; wants to explicitly add files to an existing playlist instead of letting
  ; the default Open verb decide replace-vs-append based on count.
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\addtoplaylist" "" "Add to CBZ Player Playlist"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\addtoplaylist" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\addtoplaylist\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --append "%1"'

  ; ── Verb 3: "Open in CBZ Player" (folder context menu) ───────────────────
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
!macroend

!macro customUnInstall
  ; Remove all custom verb registry entries we created. The default Open verb
  ; on .cbz (and the .cbz association itself) are removed by electron-builder's
  ; own uninstall logic based on the fileAssociations config.
  DeleteRegKey HKCU "Software\Classes\${PROGID}\shell\compare"
  DeleteRegKey HKCU "Software\Classes\${PROGID}\shell\addtoplaylist"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInCbzPlayer"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInCbzPlayer"
  ; Belt-and-suspenders: clean any leftover from the broken-ProgID era.
  DeleteRegKey HKCU "Software\Classes\${APP_EXECUTABLE_FILENAME}.cbz"
!macroend
