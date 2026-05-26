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

  ; Compare verb. Shows on right-click of any .cbz (visibility can't be
  ; conditional on selection-count without a shell extension DLL — too heavy
  ; for v1). When invoked with != 2 files the main process gracefully falls
  ; back to a normal playlist load with a log entry explaining what happened.
  ; NOTE: ${APP_EXECUTABLE_FILENAME} already INCLUDES the .exe extension on
  ; Windows. Appending another `.exe` produces `CBZ Player.exe.exe` which
  ; doesn't exist and triggers the Windows "no app associated" error.
  ; (Burned by this in the first 0.9.0 install — see HANDOFF gotcha.)
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\compare" "" "Compare in CBZ Player"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\compare" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\compare\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --compare "%1"'
!macroend

!macro customUnInstall
  ; Remove the Compare verb registry entries. The default Open verb (and the
  ; .cbz association itself) are removed by electron-builder's own uninstall
  ; logic based on the fileAssociations config.
  DeleteRegKey HKCU "Software\Classes\${PROGID}\shell\compare\command"
  DeleteRegKey HKCU "Software\Classes\${PROGID}\shell\compare"
  ; Also belt-and-suspenders: clean any leftover from the broken-ProgID era.
  DeleteRegKey HKCU "Software\Classes\${APP_EXECUTABLE_FILENAME}.cbz"
!macroend
