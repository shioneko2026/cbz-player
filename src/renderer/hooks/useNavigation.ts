import { useCallback, useRef } from 'react';
import { FileInfo } from '../lib/types';

interface NavigationOptions {
  files: FileInfo[];
  /** Playlist positions matching the search box; null = no active search. */
  activeIndices: number[] | null;
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
 * ACTIONS:
 *   'next' / 'back' / 'random' — explicit user navigation; `currentIndex` is a
 *      file that still exists in `files`, so a random pick avoids re-picking it.
 *   'after-remove' — the post-sort auto-advance. The file at `currentIndex` has
 *      ALREADY been filtered out of `files`, so `currentIndex` is the slot it
 *      vacated (now holding what would have been the sequential next file) and
 *      there is no "current file" for a random pick to avoid. See below.
 *
 * Returns null when there's nothing to navigate to.
 */
export function pickNextIndex(opts: {
  action: 'next' | 'back' | 'random' | 'after-remove';
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

  if (action === 'after-remove') {
    // Post-sort advance. The sorted file is already gone from `files`, so the
    // slot it vacated now holds the sequential next file — holding the index is
    // the sequential behaviour, and it wraps to 0 when the sorted file was last.
    // With Shuffle on we pick uniformly with NO "don't repeat" exclusion: the
    // file the user was on no longer exists in the list, so there is nothing to
    // avoid (excluding a slot here would just make one arbitrary file unreachable).
    if (shuffleEnabled) {
      newIndex = Math.floor(Math.random() * files.length);
    } else {
      newIndex = (currentIndex < 0 || currentIndex >= files.length) ? 0 : currentIndex;
    }
  } else if (action === 'random' || (action === 'next' && shuffleEnabled)) {
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

/**
 * Which playlist positions the search box currently matches.
 * Returns null when there's no active search — callers treat null as "no filter"
 * and take the unfiltered fast path, so an empty box costs nothing.
 *
 * Matching is case-insensitive substring on the FILE NAME only (not the folder
 * path): the playlist can hold files from several folders, and matching paths
 * would make a query like "keep" select every file already sorted into [00-Keep].
 */
export function computeActiveIndices(files: FileInfo[], query: string): number[] | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const out: number[] = [];
  for (let i = 0; i < files.length; i++) {
    if (files[i].name.toLowerCase().includes(q)) out.push(i);
  }
  return out;
}

/**
 * pickNextIndex, restricted to the files the search box currently matches.
 *
 * This is a THIN ADAPTER, deliberately: it translates real playlist positions
 * into "position among the matches", runs the UNCHANGED pickNextIndex over that
 * smaller space, and translates the answer back. Shuffle, Skip-Viewed and the
 * post-sort advance therefore inherit search behaviour for free, and there is
 * still exactly ONE index-picking algorithm — see the "don't fork it again"
 * history on pickNextIndex above.
 *
 * The current file not being among the matches is NOT a special case; it falls
 * out of the translation. `indexOf` returns -1, and the base algorithm already
 * maps -1 to "first match" for next, "last match" for back, and a free uniform
 * draw for random. That is exactly the intended behaviour: typing a search never
 * moves the page you are reading, and the first Next carries you into the results.
 */
export function pickNextIndexFiltered(opts: {
  action: 'next' | 'back' | 'random' | 'after-remove';
  files: FileInfo[];
  /** null = no active search. */
  activeIndices: number[] | null;
  currentIndex: number;
  shuffleEnabled: boolean;
  skipViewedEnabled: boolean;
  viewedPaths: Set<string>;
  resetViewed: () => void;
}): number | null {
  const { activeIndices, files, currentIndex, action, ...rest } = opts;

  if (activeIndices === null) {
    return pickNextIndex({ action, files, currentIndex, ...rest });
  }
  if (activeIndices.length === 0) return null; // search matches nothing

  // For 'after-remove', currentIndex is the slot the sorted file VACATED, and
  // activeIndices is already computed against the post-removal list — so the
  // anchor is the first match at or after that slot. findIndex returning -1
  // (nothing left at or after it) is the wrap-to-start case, which the base
  // algorithm's out-of-range check already handles.
  const pos = action === 'after-remove'
    ? activeIndices.findIndex(i => i >= currentIndex)
    : activeIndices.indexOf(currentIndex);

  const picked = pickNextIndex({
    action,
    files: activeIndices.map(i => files[i]),
    currentIndex: pos,
    ...rest,
  });
  return picked === null ? null : activeIndices[picked];
}

export function useNavigation(opts: NavigationOptions) {
  const {
    files, activeIndices, currentIndex, shuffleEnabled, skipViewedEnabled,
    viewedPaths, setCurrentIndex, addViewed, resetViewed, broadcast,
  } = opts;

  const navigate = useCallback((action: 'next' | 'back' | 'random') => {
    const newIndex = pickNextIndexFiltered({
      action, files, activeIndices, currentIndex, shuffleEnabled,
      skipViewedEnabled, viewedPaths, resetViewed,
    });
    if (newIndex === null) return;

    addViewed(files[newIndex].fullPath);
    setCurrentIndex(newIndex);
    broadcast(newIndex);
  }, [files, activeIndices, currentIndex, shuffleEnabled, skipViewedEnabled, viewedPaths, setCurrentIndex, addViewed, resetViewed, broadcast]);

  const jumpTo = useCallback((index: number) => {
    if (index < 0 || index >= files.length) return;
    addViewed(files[index].fullPath);
    setCurrentIndex(index);
    broadcast(index);
  }, [files, addViewed, setCurrentIndex, broadcast]);

  return { navigate, jumpTo };
}
