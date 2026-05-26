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

!macro customInstall
  ; Compare verb. Shows on right-click of any .cbz (visibility can't be
  ; conditional on selection-count without a shell extension DLL — too heavy
  ; for v1). When invoked with != 2 files the main process gracefully falls
  ; back to a normal playlist load with a log entry explaining what happened.
  ;
  ; The ProgID under fileAssociations defaults to "${APP_EXECUTABLE_FILENAME}.cbz"
  ; per electron-builder convention. Subclass key lives under that ProgID's
  ; shell\compare.
  WriteRegStr HKCU "Software\Classes\${APP_EXECUTABLE_FILENAME}.cbz\shell\compare" "" "Compare in CBZ Player"
  WriteRegStr HKCU "Software\Classes\${APP_EXECUTABLE_FILENAME}.cbz\shell\compare" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}.exe,0"
  WriteRegStr HKCU "Software\Classes\${APP_EXECUTABLE_FILENAME}.cbz\shell\compare\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}.exe" --compare "%1"'
!macroend

!macro customUnInstall
  ; Remove the Compare verb registry entries. The default Open verb (and the
  ; .cbz association itself) are removed by electron-builder's own uninstall
  ; logic based on the fileAssociations config.
  DeleteRegKey HKCU "Software\Classes\${APP_EXECUTABLE_FILENAME}.cbz\shell\compare\command"
  DeleteRegKey HKCU "Software\Classes\${APP_EXECUTABLE_FILENAME}.cbz\shell\compare"
!macroend
