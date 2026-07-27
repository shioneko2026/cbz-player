import { useCallback, useRef } from 'react';
import { FileInfo } from '../lib/types';

interface NavigationOptions {
  files: FileInfo[];
  currentIndex: number;
  shuffleEnabled: boolean;
  skipViewedEnabled: boolean;
  viewedPaths: Set<string>;
  setCurrentIndex: (idx: number) => void;
  addViewed: (path: string) => void;
  resetViewed: () => void;
  broadcast: (idx: number) => void;
}

/**
 * Choose the next playlist index for a navigation action, honouring Shuffle and
 * Skip-Viewed. PURE — each caller supplies its own view of files/currentIndex,
 * so the state-based hook below and the ref-based `navigateFile` in App.tsx can
 * share ONE algorithm while keeping their own state sources.
 *
 * WHY THIS EXISTS: these were previously two separate implementations, and the
 * App.tsx copy silently ignored BOTH shuffleEnabled and skipViewedEnabled — so
 * toggling Shuffle did nothing whenever you navigated from the viewer (only the
 * detached playlist's navigate honoured it). Keep this the single source of
 * truth; don't reintroduce a second copy.
 *
 * Returns null when there's nothing to navigate to.
 */
export function pickNextIndex(opts: {
  action: 'next' | 'back' | 'random';
  files: FileInfo[];
  currentIndex: number;
  shuffleEnabled: boolean;
  skipViewedEnabled: boolean;
  viewedPaths: Set<string>;
  resetViewed: () => void;
}): number | null {
  const {
    action, files, currentIndex, shuffleEnabled,
    skipViewedEnabled, viewedPaths, resetViewed,
  } = opts;
  if (files.length === 0) return null;

  let newIndex: number;

  if (action === 'random' || (action === 'next' && shuffleEnabled)) {
    // Random pick
    if (files.length === 1) {
      newIndex = 0;
    } else {
      do {
        newIndex = Math.floor(Math.random() * files.length);
      } while (newIndex === currentIndex && files.length > 1);
    }
  } else if (action === 'back') {
    newIndex = currentIndex <= 0 ? files.length - 1 : currentIndex - 1;
  } else {
    // next, sequential
    newIndex = currentIndex >= files.length - 1 ? 0 : currentIndex + 1;
  }

  // Skip viewed logic
  if (skipViewedEnabled && action !== 'back') {
    const startIndex = newIndex;
    let checked = 0;
    while (viewedPaths.has(files[newIndex].fullPath) && checked < files.length) {
      if (shuffleEnabled) {
        newIndex = Math.floor(Math.random() * files.length);
      } else {
        newIndex = newIndex >= files.length - 1 ? 0 : newIndex + 1;
      }
      checked++;
    }
    // All files viewed — reset and continue
    if (checked >= files.length) {
      resetViewed();
      newIndex = startIndex;
    }
  }

  return newIndex;
}

export function useNavigation(opts: NavigationOptions) {
  const {
    files, currentIndex, shuffleEnabled, skipViewedEnabled,
    viewedPaths, setCurrentIndex, addViewed, resetViewed, broadcast,
  } = opts;

  const navigate = useCallback((action: 'next' | 'back' | 'random') => {
    const newIndex = pickNextIndex({
      action, files, currentIndex, shuffleEnabled,
      skipViewedEnabled, viewedPaths, resetViewed,
    });
    if (newIndex === null) return;

    addViewed(files[newIndex].fullPath);
    setCurrentIndex(newIndex);
    broadcast(newIndex);
  }, [files, currentIndex, shuffleEnabled, skipViewedEnabled, viewedPaths, setCurrentIndex, addViewed, resetViewed, broadcast]);

  const jumpTo = useCallback((index: number) => {
    if (index < 0 || index >= files.length) return;
    addViewed(files[index].fullPath);
    setCurrentIndex(index);
    broadcast(index);
  }, [files, addViewed, setCurrentIndex, broadcast]);

  return { navigate, jumpTo };
}
