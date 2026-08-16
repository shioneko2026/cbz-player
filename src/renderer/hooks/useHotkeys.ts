import { useEffect, useCallback } from 'react';

export type HotkeyAction =
  // Sort actions (Phase 6 will implement the actual file operations)
  | 'keep' | 'purge' | 'fix' | 'translate' | 'inquire' | 'unreadable'
  // Navigation
  | 'next-file' | 'prev-file' | 'random-file'
  // Page navigation (viewer only)
  | 'next-page' | 'prev-page' | 'first-page' | 'last-page'
  // App
  | 'fullscreen' | 'quit' | 'clear-log' | 'refresh'
  | 'toggle-playlist' | 'toggle-center' | 'toggle-immerse' | 'toggle-shortcuts'
  | 'focus-search'
  | 'view-single' | 'view-dual-ltr' | 'view-dual-rtl' | 'view-scroll'
  | 'rename' | 'escape'
  // Mode switches + playlist operations (session 9)
  | 'enter-compare' | 'enter-repack'
  | 'toggle-shuffle' | 'randomize-playlist'
  // Reverse the most recent move-style sort
  | 'undo';

interface UseHotkeysOptions {
  onAction: (action: HotkeyAction) => void;
  /** Include viewer page navigation keys */
  includePageNav?: boolean;
  /** Disable all hotkeys (e.g., during rename) */
  disabled?: boolean;
}

export function useHotkeys({ onAction, includePageNav = false, disabled = false }: UseHotkeysOptions) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (disabled) return;

    // Don't capture keys when typing in an input/textarea
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

    const key = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const alt = e.altKey;

    // Ctrl+Shift combos (mode switches + shuffle toggle)
    if (ctrl && shift && !alt) {
      switch (key.toLowerCase()) {
        case 'c': e.preventDefault(); onAction('enter-compare'); return;
        case 'r': e.preventDefault(); onAction('enter-repack'); return;
      }
      return;
    }

    // Ctrl+Alt combos (playlist mutation)
    if (ctrl && alt && !shift) {
      switch (key.toLowerCase()) {
        case 's': e.preventDefault(); onAction('randomize-playlist'); return;
      }
      return;
    }

    // Plain Ctrl combos (no shift, no alt)
    if (ctrl && !shift && !alt) {
      switch (key.toLowerCase()) {
        case 'q': e.preventDefault(); onAction('quit'); return;
        // Ctrl+F = focus the playlist search box, matching every other app.
        // The fit-mode cycle it used to trigger moved to Ctrl+Shift+F (session
        // 15) — those listeners live locally in CbzViewer/CompareViewer, not here.
        case 'f': e.preventDefault(); onAction('focus-search'); return;
        case 'r': e.preventDefault(); onAction('toggle-shuffle'); return;
        case 'i': e.preventDefault(); onAction('toggle-immerse'); return;
        case 'e': e.preventDefault(); onAction('toggle-center'); return;
        case 'z': e.preventDefault(); onAction('undo'); return;
        case '1': e.preventDefault(); onAction('view-single'); return;
        case '2': e.preventDefault(); onAction('view-dual-ltr'); return;
        case '3': e.preventDefault(); onAction('view-dual-rtl'); return;
        case '4': e.preventDefault(); onAction('view-scroll'); return;
      }
      return;
    }

    // Enter toggles fullscreen (unless on an input/button)
    if (key === 'Enter') {
      if (target.tagName === 'BUTTON') {
        e.preventDefault();
        (target as HTMLElement).blur();
      } else if (includePageNav) {
        e.preventDefault();
        onAction('fullscreen');
      }
      return;
    }

    // Page navigation (viewer)
    if (includePageNav) {
      // SPACE turns the page. (Double-tap-Space-to-Keep was removed in session
      // 15 — the user found it redundant and never adopted it. Don't reinstate
      // it without asking: it made every Space press ambiguous for the length of
      // the double-tap window, which is the reason it was dropped.)
      if (key === ' ') {
        e.preventDefault();
        onAction('next-page');
        return;
      }
      switch (key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault(); onAction('next-page'); return;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault(); onAction('prev-page'); return;
        case 'PageUp':
        case 'Home':
          e.preventDefault(); onAction('first-page'); return;
        case 'PageDown':
        case 'End':
          e.preventDefault(); onAction('last-page'); return;
        case 'Escape':
          e.preventDefault(); onAction('escape'); return;
        case 'F2':
          e.preventDefault(); onAction('rename'); return;
        case 'F6':
          e.preventDefault(); onAction('toggle-playlist'); return;
        case 'F11':
          e.preventDefault(); onAction('fullscreen'); return;
      }
    }

    // File navigation (both windows)
    switch (key) {
      case '[':
      case 'Backspace':
        e.preventDefault(); onAction('prev-file'); return;
      case ']':
      case '\\':
        e.preventDefault(); onAction('next-file'); return;
      // F5 refreshes the playlist from the source folder. This is now the ONLY
      // refresh key — Ctrl+R was reassigned to toggle-shuffle. Lives in the
      // both-windows section so it works from either the viewer or detached
      // playlist (the detached playlist routes it to the viewer via the message bus).
      case 'F5':
        e.preventDefault(); onAction('refresh'); return;
      // F1 opens the shortcut cheat-sheet. Lives in the both-windows section
      // (not under includePageNav) so it also works while repacking, where
      // page-nav is switched off. Closing it is handled by ShortcutsOverlay's
      // own listener, because App disables this dispatcher while it's open.
      case 'F1':
        e.preventDefault(); onAction('toggle-shortcuts'); return;
    }

    // Sort and nav keys (single letter, case-insensitive)
    switch (key.toLowerCase()) {
      case 'k': onAction('keep'); return;
      case 'p': onAction('purge'); return;
      case 'f': onAction('fix'); return;
      case 't': onAction('translate'); return;
      case 'i': onAction('inquire'); return;
      case 'u': onAction('unreadable'); return;
      case 'n': onAction('next-file'); return;
      case 'b': onAction('prev-file'); return;
      case 'r': onAction('random-file'); return;
      case 'c': onAction('clear-log'); return;
    }
  }, [onAction, includePageNav, disabled]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
