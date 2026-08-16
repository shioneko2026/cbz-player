/**
 * SINGLE SOURCE OF TRUTH for the keyboard-shortcut reference.
 *
 * Rendered in two places — the F1 overlay (ShortcutsOverlay) and the
 * Settings > Shortcuts tab. Keep it that way: this list previously lived
 * inline in SettingsModal only, went stale across several sessions of
 * hotkey changes, and there was no way to notice. If you change a binding
 * in `useHotkeys.ts` (or a component-local listener), update it HERE and
 * both surfaces stay correct.
 *
 * This is a read-only reference — it does not define the bindings, it
 * documents them. The real bindings live in:
 *   - src/renderer/hooks/useHotkeys.ts   (global dispatcher)
 *   - CbzViewer.tsx / CompareViewer.tsx  (local Ctrl+Shift+F fit-cycle, middle-click sync)
 *   - RepackViewer.tsx                   (repack-only keys)
 */

export type ShortcutRow = [key: string, description: string];
export type ShortcutGroup = [title: string, rows: ShortcutRow[]];

interface CategoryLike {
  hotkey?: string;
  label: string;
}

/**
 * Build the grouped shortcut reference. Sort keys come from the user's live
 * category config so renamed categories show their real labels.
 */
export function getShortcutGroups(categories: CategoryLike[]): ShortcutGroup[] {
  return [
    ['Sort', [
      ...categories
        .filter(c => c.hotkey)
        .map(c => [c.hotkey!.toUpperCase(), c.label] as ShortcutRow),
      ['Ctrl+Z', 'Undo last sort (including purge)'],
    ]],
    ['File navigation', [
      ['N', 'Next file'],
      ['B', 'Previous file'],
      ['R', 'Random file'],
      ['] / \\', 'Next file'],
      ['[ / Backspace', 'Previous file'],
      ['Ctrl+F', 'Search the playlist (filters it; Next/Back then cycle the matches)'],
      ['Enter', 'Leave the search box, keeping the filter (in the search box)'],
    ]],
    ['Page navigation (viewer)', [
      ['← ↑', 'Previous page'],
      ['→ ↓ Space', 'Next page'],
      ['Home / PageUp', 'First page'],
      ['End / PageDown', 'Last page'],
    ]],
    ['View modes', [
      ['Ctrl+1', 'Single page'],
      ['Ctrl+2', 'Dual LTR'],
      ['Ctrl+3', 'Dual RTL'],
      ['Ctrl+4', 'Vertical scroll'],
      ['Ctrl+E', 'Toggle center page'],
      ['Ctrl+Shift+F', 'Cycle fit mode: Fit → Height → Width'],
      ['Ctrl+Wheel', 'Zoom in / out'],
    ]],
    ['Modes', [
      ['Ctrl+Shift+C', 'Enter compare mode (pick with current)'],
      ['Ctrl+Shift+R', 'Enter repack mode'],
      ['Ctrl+I', 'Toggle Immerse (docked mode only)'],
      ['Escape', 'Exit current mode / cancel action'],
    ]],
    ['Compare mode', [
      ['Middle-click', 'Toggle page-sync between the two files'],
      ['Ctrl+Shift+F', 'Cycle fit mode'],
    ]],
    ['Repack mode', [
      ['Click', 'Select that page (red); replaces the selection'],
      ['Ctrl+Click', 'Add / remove a single page from the selection'],
      ['Shift+Click', 'Select a range from the anchor'],
      ['← → ↑ ↓', 'Move the selection one page / one row'],
      ['Shift+Arrows', 'Extend the selection as a range'],
      ['Ctrl+A', 'Select all pages'],
      ['Delete', 'Delete the selected page(s)'],
      ['Ctrl+Z', 'Undo the last delete (step back one at a time)'],
      ['Ctrl+S', 'Repack & Save (write CBZ to disk and exit)'],
      ['Escape', 'Clear selection, then exit repack'],
    ]],
    ['Playlist', [
      ['Ctrl+R', 'Toggle shuffle mode (navigation)'],
      ['Ctrl+Alt+S', 'Randomize playlist order (current stays first)'],
      ['F5', 'Refresh playlist (re-scan source folder)'],
      ['F2', 'Rename current file'],
      ['F6', 'Toggle playlist panel (docked mode)'],
    ]],
    ['App', [
      ['F1', 'Show / hide this shortcut list'],
      ['Ctrl+Q', 'Quit'],
      ['F11 / Enter', 'Toggle fullscreen'],
      ['C', 'Clear log'],
    ]],
  ];
}
