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
  | 'toggle-playlist' | 'toggle-center'
  | 'view-single' | 'view-dual-ltr' | 'view-dual-rtl' | 'view-scroll'
  | 'rename' | 'escape';

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

    // Ctrl combos
    if (ctrl) {
      switch (key.toLowerCase()) {
        case 'q': e.preventDefault(); onAction('quit'); return;
        case 'r': e.preventDefault(); onAction('refresh'); return;
        case 'e': e.preventDefault(); onAction('toggle-center'); return;
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
      switch (key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case ' ':
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
