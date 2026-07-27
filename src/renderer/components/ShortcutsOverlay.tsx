import React, { useEffect } from 'react';
import { getShortcutGroups } from '../lib/shortcuts';

interface ShortcutsOverlayProps {
  darkMode: boolean;
  categories: Array<{ hotkey?: string; label: string }>;
  onClose: () => void;
}

/**
 * F1 cheat-sheet overlay. Renders the SAME data as the Settings > Shortcuts
 * tab (see lib/shortcuts.ts) so the two can never drift apart.
 *
 * Owns its own F1/Escape handling via a local window listener — the same
 * pattern RepackViewer uses for Ctrl+S. This is deliberate: while the overlay
 * is open App passes `disabled` to useHotkeys so no stray sort key fires at
 * the cheat-sheet, which means the GLOBAL dispatcher can't be what closes it.
 */
export default function ShortcutsOverlay({ darkMode, categories, onClose }: ShortcutsOverlayProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F1' || e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const panel = darkMode ? 'bg-zinc-900 border-zinc-700' : 'bg-white border-zinc-300';
  const border = darkMode ? 'border-zinc-800' : 'border-zinc-200';
  const text = darkMode ? 'text-zinc-200' : 'text-zinc-800';
  const subtext = darkMode ? 'text-zinc-500' : 'text-zinc-500';
  const groups = getShortcutGroups(categories);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className={`w-full max-w-4xl max-h-full overflow-y-auto rounded-lg border shadow-2xl ${panel}`}
        onClick={e => e.stopPropagation()}
      >
        <div className={`flex items-center justify-between px-5 py-3 border-b ${border}`}>
          <h2 className={`text-base font-semibold ${text}`}>Keyboard Shortcuts</h2>
          <span className={`text-xs ${subtext}`}>F1 or Esc to close</span>
        </div>

        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          {groups.map(([group, rows]) => (
            <div key={group} className={`p-3 rounded border ${border}`}>
              <h4 className={`text-xs font-semibold uppercase tracking-wide ${subtext} mb-2`}>{group}</h4>
              <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
                {rows.map(([key, label]) => (
                  <React.Fragment key={`${group}-${key}-${label}`}>
                    <kbd className={`text-xs font-mono px-1.5 py-0.5 rounded border ${darkMode ? 'bg-zinc-800 border-zinc-700 text-zinc-200' : 'bg-zinc-100 border-zinc-300 text-zinc-800'} whitespace-nowrap`}>
                      {key}
                    </kbd>
                    <span className={`text-xs ${text}`}>{label}</span>
                  </React.Fragment>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
