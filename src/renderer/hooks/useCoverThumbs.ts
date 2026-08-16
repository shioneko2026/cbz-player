import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Cover thumbnails for the playlist's Thumb List mode.
 *
 * Two rules drive this hook, both from the user's own requirements:
 *   1. Only rows you can actually see may cost anything. A cover is requested
 *      when its row enters the viewport and cancelled if it leaves before the
 *      extraction starts.
 *   2. Offscreen rows must not hold an <img>. Dropping the URL when a row
 *      travels far out of view is what keeps decoded bitmaps bounded on a
 *      15,000-file playlist — re-entering costs nothing real, because the disk
 *      cache and Chromium's cache both hit.
 *
 * The playlist itself is NOT virtualised (all rows render, they're just text).
 * That stays true; only the images are lazy.
 */

export type ThumbState = { url: string } | { failed: true; reason?: string };

/** Start fetching this far before a row scrolls into view. */
const ENTER_MARGIN_PX = 200;
/** Only release a row's image once it is this far outside the viewport. */
const RELEASE_MARGIN_PX = 1200;

export function useCoverThumbs(enabled: boolean) {
  const [thumbs, setThumbs] = useState<Map<string, ThumbState>>(new Map());
  // Mirror of `thumbs` for the observer callbacks, which must read the current
  // value without being re-created (and re-observing 15,000 rows) on every
  // cover that lands.
  const thumbsRef = useRef<Map<string, ThumbState>>(thumbs);
  useEffect(() => { thumbsRef.current = thumbs; }, [thumbs]);
  // Paths currently on (or near) screen. A row that leaves keeps its entry only
  // until it passes the release margin, at which point the image is dropped.
  const visiblePaths = useRef<Set<string>>(new Set());
  const requested = useRef<Set<string>>(new Set());
  const enterObserver = useRef<IntersectionObserver | null>(null);
  const releaseObserver = useRef<IntersectionObserver | null>(null);
  const elementPaths = useRef<WeakMap<Element, string>>(new WeakMap());

  // Results arrive by broadcast rather than as a reply, so the detached
  // playlist window sees covers it didn't personally request.
  useEffect(() => {
    if (!window.electronAPI?.onThumbReady) return;
    window.electronAPI.onThumbReady((payload) => {
      if (!payload?.fullPath) return;
      setThumbs(prev => {
        const next = new Map(prev);
        if (payload.url) next.set(payload.fullPath, { url: payload.url });
        else if (payload.failed) next.set(payload.fullPath, { failed: true, reason: payload.reason });
        return next;
      });
    });
  }, []);

  // Clearing the cache invalidates every URL we're holding.
  useEffect(() => {
    if (!window.electronAPI?.onThumbCacheCleared) return;
    window.electronAPI.onThumbCacheCleared(() => {
      requested.current.clear();
      setThumbs(new Map());
    });
  }, []);

  /**
   * Main can't decode webp or avif — about a fifth of this library's covers.
   * Chromium here can, so main sends us the bytes and we return a shrunk JPEG.
   * Runs once per file; afterwards the cached JPEG is served like any other.
   */
  useEffect(() => {
    if (!window.electronAPI?.onThumbConvertRequest) return;
    window.electronAPI.onThumbConvertRequest(async (payload) => {
      const respond = (data: Uint8Array | null) => window.electronAPI?.sendThumbConverted?.(payload.id, data);
      let objectUrl: string | null = null;
      try {
        const blob = new Blob([payload.data as any], { type: payload.mime });
        objectUrl = URL.createObjectURL(blob);
        const bitmap = await createImageBitmap(blob);
        const longest = Math.max(bitmap.width, bitmap.height);
        const scale = longest > 480 ? 480 / longest : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) { respond(null); return; }
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        const outBlob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.8));
        if (!outBlob) { respond(null); return; }
        respond(new Uint8Array(await outBlob.arrayBuffer()));
      } catch {
        // Fail visibly rather than silently: main turns a null into a "failed"
        // result, which paints the broken-cover placeholder on the row.
        respond(null);
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    });
  }, []);

  const requestFor = useCallback((fullPath: string) => {
    if (requested.current.has(fullPath)) return;
    requested.current.add(fullPath);
    window.electronAPI?.getThumb?.(fullPath).catch(() => {
      requested.current.delete(fullPath);
    });
  }, []);

  // Build the observers once per enable/disable cycle.
  useEffect(() => {
    if (!enabled) {
      enterObserver.current?.disconnect();
      releaseObserver.current?.disconnect();
      enterObserver.current = null;
      releaseObserver.current = null;
      visiblePaths.current.clear();
      requested.current.clear();
      setThumbs(new Map());
      return;
    }

    enterObserver.current = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const fullPath = elementPaths.current.get(entry.target);
        if (!fullPath) continue;
        if (entry.isIntersecting) {
          visiblePaths.current.add(fullPath);
          requestFor(fullPath);
        } else {
          visiblePaths.current.delete(fullPath);
          // Only cancels work that hasn't started; in-flight extraction is
          // allowed to finish and populate the cache.
          window.electronAPI?.cancelThumb?.(fullPath);
          // Forget that we asked. A cancelled request is never broadcast back,
          // so leaving it marked as requested would strand the row on a
          // placeholder forever if it scrolls back into view before the release
          // margin evicts it. Re-requesting is harmless — main coalesces
          // duplicate waiters for the same path.
          if (!thumbsRef.current.has(fullPath)) requested.current.delete(fullPath);
        }
      }
    }, { rootMargin: `${ENTER_MARGIN_PX}px 0px` });

    releaseObserver.current = new IntersectionObserver((entries) => {
      const dropped: string[] = [];
      for (const entry of entries) {
        const fullPath = elementPaths.current.get(entry.target);
        if (!fullPath || entry.isIntersecting) continue;
        dropped.push(fullPath);
      }
      if (dropped.length === 0) return;
      setThumbs(prev => {
        let changed = false;
        const next = new Map(prev);
        for (const p of dropped) {
          // Keep failures — re-requesting a known-bad cover on every scroll pass
          // would hammer a broken file for nothing.
          const cur = next.get(p);
          if (cur && 'url' in cur) { next.delete(p); requested.current.delete(p); changed = true; }
        }
        return changed ? next : prev;
      });
    }, { rootMargin: `${RELEASE_MARGIN_PX}px 0px` });

    return () => {
      enterObserver.current?.disconnect();
      releaseObserver.current?.disconnect();
      enterObserver.current = null;
      releaseObserver.current = null;
    };
  }, [enabled, requestFor]);

  /** Ref callback for a row element. Registers/unregisters with both observers. */
  const observeRow = useCallback((el: HTMLElement | null, fullPath: string) => {
    if (!el) return;
    elementPaths.current.set(el, fullPath);
    enterObserver.current?.observe(el);
    releaseObserver.current?.observe(el);
  }, []);

  const unobserveRow = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    enterObserver.current?.unobserve(el);
    releaseObserver.current?.unobserve(el);
  }, []);

  return { thumbs, observeRow, unobserveRow };
}
