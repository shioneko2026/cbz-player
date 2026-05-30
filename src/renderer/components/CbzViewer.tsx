import React, { useState, useEffect, useRef, useCallback } from 'react';

export type ViewMode = 'single' | 'dual-rtl' | 'dual-ltr' | 'scroll';
export type FitMode = 'fit-width' | 'fit-height' | 'fit-page';

interface CbzViewerProps {
  images: string[];
  extractionId: string;
  darkMode: boolean;
  onPageChange?: (page: number) => void;
  onNextFile?: () => void;
  onPrevFile?: () => void;
  centerPage?: boolean;
  centerOffset?: number;
  onToggleCenter?: () => void;
  controlsHideDelay?: number;
  controlBarMode?: 'auto-hide' | 'hover-only' | 'always-visible';
  bgColor?: string;
}

// Retry loading broken images (race condition during rapid extraction).
// Since the <img> no longer uses `key`, the same DOM element is reused across
// page navigation — which means a pending retry setTimeout could fire after the
// user has already moved to a different page, overwriting React's fresh src
// with a stale retry URL. Guard by checking that the element's current src
// still matches the URL that originally failed before retrying.
function useImageRetry(maxRetries = 3, delay = 300) {
  const retryCountRef = React.useRef<Map<string, number>>(new Map());

  const handleError = React.useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const failedSrc = img.src;
    const count = retryCountRef.current.get(failedSrc) ?? 0;
    if (count < maxRetries) {
      retryCountRef.current.set(failedSrc, count + 1);
      setTimeout(() => {
        // Only retry if the element is still pointing at the URL that failed.
        // If React has since re-rendered a new src (user navigated), skip.
        if (img.src === failedSrc) {
          img.src = failedSrc + (failedSrc.includes('?') ? '&' : '?') + `retry=${count + 1}`;
        }
      }, delay);
    }
  }, [maxRetries, delay]);

  const reset = React.useCallback(() => {
    retryCountRef.current.clear();
  }, []);

  return { handleError, reset };
}

export default function CbzViewer({ images, extractionId, darkMode, onPageChange, onNextFile, onPrevFile, centerPage, centerOffset, onToggleCenter, controlsHideDelay = 1500, controlBarMode = 'auto-hide', bgColor }: CbzViewerProps) {
  const imageUrl = (filename: string) => `cbz-image://host/${extractionId}/${filename}`;
  const [viewMode, setViewMode] = useState<ViewMode>('single');
  const [fitMode, setFitMode] = useState<FitMode>('fit-page');
  const [currentPage, setCurrentPage] = useState(0);
  // Page actually rendered in the DOM. Lags currentPage by one decode cycle so
  // the <img> never shows a partially-loaded state. Updates only after the
  // target page(s) have been decoded into Chromium's image cache.
  const [displayedPage, setDisplayedPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const hideTimerRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageAreaRef = useRef<HTMLDivElement>(null);

  const { handleError: handleImgError, reset: resetRetries } = useImageRetry();

  // Track container width for center offset clamping
  const [areaWidth, setAreaWidth] = useState(0);

  useEffect(() => {
    const el = imageAreaRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setAreaWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Ctrl+F cycles fit mode: Fit → Height → Width → Fit. Local listener (not in
  // useHotkeys) because fitMode is local component state — same pattern as
  // RepackViewer's Ctrl+S and CompareViewer's Ctrl+I. Guarded so it doesn't
  // fire when typing in inputs (rename, settings, etc.).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'f') return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      e.preventDefault();
      setFitMode(curr => {
        const cycle: FitMode[] = ['fit-page', 'fit-height', 'fit-width'];
        return cycle[(cycle.indexOf(curr) + 1) % cycle.length];
      });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Center offset logic:
  // Without center mode: images are centered in the viewer pane (left of panel).
  // With center mode: we want images centered on the FULL SCREEN.
  // The viewer pane center is at viewerWidth/2 from viewer left edge.
  // The screen center is at (viewerWidth + panelWidth)/2 from viewer left edge = viewerWidth/2 + panelWidth/2.
  // So we need to shift right by panelWidth/2 = centerOffset.
  // BUT if the images are wide (dual mode) and the shift would push the right edge
  // past the viewer pane boundary (into the panel), we reduce the shift.
  //
  // Strategy: measure actual rendered content width via the imageAreaRef's first child.
  // If shifted content right edge > container width, reduce offset.
  const [contentWidth, setContentWidth] = useState(0);

  useEffect(() => {
    const el = imageAreaRef.current;
    if (!el) return;
    const measure = () => {
      // Find the actual image/wrapper element inside
      const child = el.firstElementChild as HTMLElement | null;
      if (child) setContentWidth(child.offsetWidth);
    };
    measure();
    const observer = new MutationObserver(measure);
    observer.observe(el, { childList: true, subtree: true });
    // Also re-measure on resize
    const resizeObs = new ResizeObserver(measure);
    resizeObs.observe(el);
    return () => { observer.disconnect(); resizeObs.disconnect(); };
  }, [images, displayedPage, viewMode]);

  const clampedOffset = (() => {
    if (!centerOffset) return 0;
    if (areaWidth <= 0 || contentWidth <= 0) return centerOffset;

    // Content is centered: its right edge is at areaWidth/2 + contentWidth/2
    const rightEdgeWithOffset = areaWidth / 2 + contentWidth / 2 + centerOffset;

    if (rightEdgeWithOffset <= areaWidth) {
      // Content fits with full offset — use it
      return centerOffset;
    }

    // Content would overflow right — reduce offset so right edge = areaWidth
    // offset = areaWidth - areaWidth/2 - contentWidth/2 = areaWidth/2 - contentWidth/2
    const maxOffset = (areaWidth - contentWidth) / 2;
    // If content is already wider than container, shift left (negative) to keep right edge visible
    return Math.max(maxOffset, 0);
  })();

  const totalPages = images.length;
  const isDual = viewMode === 'dual-rtl' || viewMode === 'dual-ltr';
  const pageStep = isDual ? 2 : 1;

  // Beep on last page
  const lastPageBeeped = useRef(false);
  const beepOnLastPage = (window as any).__cbzSettings?.beepOnLastPage ?? true;
  const beepVolume = (window as any).__cbzSettings?.beepVolume ?? 0.15;
  const beepPitch = (window as any).__cbzSettings?.beepPitch ?? 600;

  useEffect(() => {
    const isLastPage = currentPage >= totalPages - (isDual ? 2 : 1);
    if (isLastPage && totalPages > 0 && !lastPageBeeped.current && beepOnLastPage) {
      lastPageBeeped.current = true;
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = beepPitch;
        gain.gain.value = beepVolume;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
        setTimeout(() => ctx.close(), 300);
      } catch { /* audio not available */ }
    } else if (!isLastPage) {
      lastPageBeeped.current = false;
    }
  }, [currentPage, totalPages, isDual, beepOnLastPage, beepVolume, beepPitch]);

  // Decode-before-swap: before committing a page change into the DOM, decode
  // the target page(s) via an offscreen Image() so the visible <img>'s src
  // flips to an already-cached bitmap. Browser can render it the same frame —
  // no black flash, no partial state.
  // For dual-page mode, decode both left and right together (Promise.all) so
  // they swap in lockstep and never tear (one side advancing before the other).
  useEffect(() => {
    if (viewMode === 'scroll') {
      // Scroll mode mounts every page; no staged swap needed.
      if (displayedPage !== currentPage) setDisplayedPage(currentPage);
      return;
    }
    if (currentPage === displayedPage) return;
    if (!images.length || !images[currentPage] || !extractionId) return;
    let cancelled = false;

    const isDualMode = viewMode === 'dual-rtl' || viewMode === 'dual-ltr';
    const toDecode: number[] = [currentPage];
    if (isDualMode && currentPage + 1 < images.length) toDecode.push(currentPage + 1);

    Promise.all(
      toDecode.map(idx => {
        const img = new Image();
        img.src = `cbz-image://host/${extractionId}/${images[idx]}`;
        // Swallow decode errors — we still commit the page so the visible
        // <img>'s onError path (useImageRetry) can take over as normal.
        return img.decode().catch(() => {});
      })
    ).then(() => {
      if (!cancelled) setDisplayedPage(currentPage);
    });

    return () => { cancelled = true; };
  }, [currentPage, displayedPage, images, viewMode, extractionId]);

  // Preload neighbors (±3 pages) into the browser's image cache so future
  // navigation hits a decoded bitmap and the decode-before-swap effect above
  // resolves in microseconds. ±3 covers both single and dual nav patterns.
  useEffect(() => {
    if (viewMode === 'scroll' || !images.length || !extractionId) return;
    for (let d = -3; d <= 3; d++) {
      if (d === 0) continue;
      const idx = currentPage + d;
      if (idx < 0 || idx >= images.length) continue;
      const img = new Image();
      img.src = `cbz-image://host/${extractionId}/${images[idx]}`;
      // Fire and forget — decoded bitmap enters Chromium's image cache
      // keyed by URL. No explicit cleanup needed; React GCs the Image refs.
      img.decode().catch(() => {});
    }
  }, [currentPage, images, viewMode, extractionId]);

  // Reset page when images change
  useEffect(() => {
    setCurrentPage(0);
    setDisplayedPage(0);
    setZoom(1);
    resetRetries();
    lastPageBeeped.current = false;
  }, [images, resetRetries]);

  useEffect(() => { onPageChange?.(currentPage); }, [currentPage, onPageChange]);

  // Fullscreen change detection — check both browser and Electron fullscreen
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    // Also poll Electron's fullscreen state (for native fullscreen)
    const interval = setInterval(() => {
      // window.innerHeight close to screen.height indicates fullscreen
      const isFS = window.outerHeight >= screen.height - 5;
      setIsFullscreen(prev => isFS !== prev ? isFS : prev);
    }, 500);
    return () => { document.removeEventListener('fullscreenchange', handler); clearInterval(interval); };
  }, []);

  const goToPage = useCallback((page: number) => {
    setCurrentPage(Math.max(0, Math.min(page, totalPages - 1)));
  }, [totalPages]);

  const nextPage = useCallback(() => goToPage(currentPage + pageStep), [currentPage, pageStep, goToPage]);
  const prevPage = useCallback(() => goToPage(currentPage - pageStep), [currentPage, pageStep, goToPage]);
  const firstPage = useCallback(() => goToPage(0), [goToPage]);
  const lastPage = useCallback(() => goToPage(totalPages - 1), [goToPage, totalPages]);
  const zoomIn = useCallback(() => setZoom(z => Math.min(z + 0.25, 5)), []);
  const zoomOut = useCallback(() => setZoom(z => Math.max(z - 0.25, 0.25)), []);

  const toggleFullscreen = useCallback(() => {
    (window as any).electronAPI?.toggleFullscreen();
  }, []);

  // Expose for parent/hotkeys
  useEffect(() => {
    (window as any).__cbzViewer = {
      nextPage, prevPage, firstPage, lastPage, zoomIn, zoomOut, toggleFullscreen, setViewMode,
      getContentWidth: () => contentWidth,
      getAreaWidth: () => areaWidth,
    };
    return () => { delete (window as any).__cbzViewer; };
  }, [nextPage, prevPage, firstPage, lastPage, zoomIn, zoomOut, toggleFullscreen, contentWidth, areaWidth]);

  // Controls visibility based on mode
  const controlsHoveredRef = useRef(false);
  const isAlwaysVisible = controlBarMode === 'always-visible';
  const isHoverOnly = controlBarMode === 'hover-only';

  const handleMouseMove = useCallback(() => {
    if (isAlwaysVisible) return; // Always visible, no timer needed
    if (isHoverOnly) return; // Hover-only mode handled by onMouseEnter/Leave
    setShowControls(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (!controlsHoveredRef.current) {
      hideTimerRef.current = window.setTimeout(() => setShowControls(false), controlsHideDelay);
    }
  }, [controlsHideDelay, isAlwaysVisible, isHoverOnly]);

  // Hide controls initially (unless always-visible)
  useEffect(() => {
    if (isAlwaysVisible) { setShowControls(true); return; }
    if (isHoverOnly) { setShowControls(false); return; }
    hideTimerRef.current = window.setTimeout(() => setShowControls(false), controlsHideDelay);
    return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); };
  }, []);

  // Scroll wheel
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      if (e.deltaY < 0) zoomIn(); else zoomOut();
      return;
    }
    if (viewMode !== 'scroll') {
      if (e.deltaY > 0) nextPage(); else if (e.deltaY < 0) prevPage();
    }
  }, [viewMode, nextPage, prevPage, zoomIn, zoomOut]);

  // Image style based on fit mode + center offset (position: relative + left shifts without resizing)
  const getImageStyle = (): React.CSSProperties => {
    const base: React.CSSProperties = {
      display: 'block',
      transform: zoom !== 1 ? `scale(${zoom})` : undefined,
      transformOrigin: 'center center',
      position: clampedOffset ? 'relative' as const : undefined,
      left: clampedOffset ? `${clampedOffset}px` : undefined,
    };
    switch (fitMode) {
      case 'fit-width': return { ...base, width: '100%', height: 'auto', objectFit: 'contain' as const };
      case 'fit-height': return { ...base, width: 'auto', height: '100%', objectFit: 'contain' as const };
      case 'fit-page':
      default: return { ...base, width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' as const };
    }
  };

  if (images.length === 0) return null;

  const bg = bgColor ? '' : (darkMode ? 'bg-black' : 'bg-zinc-200');
  const controlsBg = darkMode ? 'bg-zinc-900/80' : 'bg-white/80';
  const controlsText = darkMode ? 'text-zinc-300' : 'text-zinc-700';
  const btnBase = `px-2 py-1 rounded text-xs transition-colors ${darkMode ? 'hover:bg-zinc-700' : 'hover:bg-zinc-200'}`;
  const btnActive = darkMode ? 'bg-zinc-700' : 'bg-zinc-300';

  // Dual page rendering — offset applied to wrapper, not individual images.
  // Uses displayedPage (not currentPage) so left/right advance together only
  // after decode-before-swap has committed the page change.
  // `key` is NOT set on the <img> elements — we want React to keep the same
  // DOM nodes across page transitions. The decode-before-swap effect above
  // ensures src is only updated to already-decoded URLs.
  const renderDualPages = () => {
    const leftIdx = viewMode === 'dual-rtl' ? displayedPage + 1 : displayedPage;
    const rightIdx = viewMode === 'dual-rtl' ? displayedPage : displayedPage + 1;
    // Remove position/left from individual image styles for dual mode
    const baseStyle = getImageStyle();
    const imgStyle = { ...baseStyle, maxWidth: '49%', position: undefined as any, left: undefined as any };

    return (
      <div
        className="flex items-center justify-center gap-1 h-full"
        style={clampedOffset ? { position: 'relative', left: `${clampedOffset}px` } : undefined}
      >
        {leftIdx >= 0 && leftIdx < totalPages && (
          <img src={imageUrl(images[leftIdx])} alt={`Page ${leftIdx + 1}`} style={imgStyle} draggable={false}
            onError={handleImgError} />
        )}
        {rightIdx >= 0 && rightIdx < totalPages && (
          <img src={imageUrl(images[rightIdx])} alt={`Page ${rightIdx + 1}`} style={imgStyle} draggable={false}
            onError={handleImgError} />
        )}
      </div>
    );
  };

  // Page info text
  const pageInfo = isDual
    ? `${currentPage + 1}-${Math.min(currentPage + 2, totalPages)} / ${totalPages}`
    : `${currentPage + 1} / ${totalPages}`;

  return (
    <div
      ref={containerRef}
      className={`h-full w-full ${bg} flex flex-col relative overflow-hidden select-none`}
      style={bgColor ? { backgroundColor: bgColor } : undefined}
      onMouseMove={handleMouseMove}
      onWheel={handleWheel}
    >
      {/* Image Display */}
      <div ref={imageAreaRef} className="flex-1 flex items-center justify-center overflow-hidden">
        {viewMode === 'single' && images[displayedPage] && (
          <img
            src={imageUrl(images[displayedPage])}
            alt={`Page ${displayedPage + 1}`}
            style={getImageStyle()}
            draggable={false}
            onError={handleImgError}
          />
        )}
        {isDual && renderDualPages()}
        {viewMode === 'scroll' && (
          <div className="h-full w-full overflow-y-auto flex flex-col items-center">
            {images.map((img, idx) => (
              <img key={img} src={imageUrl(img)} alt={`Page ${idx + 1}`} style={{ width: '100%', height: 'auto' }} draggable={false} />
            ))}
            <div className={`py-8 text-2xl font-light select-none ${darkMode ? 'text-zinc-800' : 'text-zinc-300'}`}>
              Last Page
            </div>
          </div>
        )}
      </div>

      {/* Last page indicator — visible when on the final page */}
      {currentPage >= totalPages - (isDual ? 2 : 1) && viewMode !== 'scroll' && (
        <div className={`absolute top-1/2 right-6 -translate-y-1/2 z-10 select-none ${darkMode ? 'text-zinc-700' : 'text-zinc-300'}`}>
          <p className="text-3xl font-light tracking-wide" style={{ writingMode: 'vertical-rl' }}>LAST PAGE</p>
        </div>
      )}

      {/* Persistent page counter — always visible, bottom-right corner */}
      <div className={`absolute bottom-12 right-3 z-10 px-2 py-1 rounded text-xs tabular-nums ${darkMode ? 'bg-black/50 text-zinc-400' : 'bg-white/50 text-zinc-600'}`}>
        {isDual
          ? `${currentPage + 1}-${Math.min(currentPage + 2, totalPages)} / ${totalPages}`
          : `${currentPage + 1} / ${totalPages}`
        }
      </div>

      {/* Hover trigger zone — invisible area at bottom that detects mouse for hover-only mode */}
      {isHoverOnly && !showControls && (
        <div
          className="absolute bottom-0 left-0 right-0 z-20 h-10"
          onMouseEnter={() => { controlsHoveredRef.current = true; setShowControls(true); }}
        />
      )}

      {/* Controls bar */}
      <div
        className={`${isAlwaysVisible ? 'flex-shrink-0' : 'absolute bottom-0 left-0 right-0 z-20 backdrop-blur-sm'} px-4 py-2 flex items-center justify-between gap-3 transition-opacity duration-200 ${controlsBg} ${controlsText} ${
          isAlwaysVisible ? 'opacity-100' : showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onMouseEnter={() => {
          controlsHoveredRef.current = true;
          setShowControls(true);
          if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        }}
        onMouseLeave={() => {
          controlsHoveredRef.current = false;
          if (!isAlwaysVisible) {
            hideTimerRef.current = window.setTimeout(() => setShowControls(false), isHoverOnly ? 300 : controlsHideDelay);
          }
        }}
      >
        {/* Fit Mode */}
        <div className="flex gap-1">
          {([['fit-page', 'Fit'], ['fit-height', 'Height'], ['fit-width', 'Width']] as const).map(([mode, label]) => (
            <button key={mode} onClick={() => setFitMode(mode)}
              className={`${btnBase} ${fitMode === mode ? btnActive : ''}`}>{label}</button>
          ))}
        </div>

        {/* View Mode */}
        <div className="flex gap-1">
          {([['single', '1-Page'], ['dual-ltr', 'Dual LTR'], ['dual-rtl', 'Dual RTL'], ['scroll', 'Scroll']] as const).map(([mode, label]) => (
            <button key={mode} onClick={() => { setViewMode(mode); setCurrentPage(0); }}
              className={`${btnBase} ${viewMode === mode ? btnActive : ''}`}>{label}</button>
          ))}
        </div>

        {/* Zoom */}
        <div className="flex items-center gap-1">
          <button onClick={zoomOut} className={btnBase}>−</button>
          <span className="text-xs tabular-nums w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button onClick={zoomIn} className={btnBase}>+</button>
        </div>

        {/* File Nav — center */}
        <div className="flex items-center gap-1">
          <button onClick={onPrevFile} className={btnBase} title="Previous File  [">◀ Prev</button>
          <button onClick={onNextFile} className={btnBase} title="Next File  ]">Next ▶</button>
        </div>

        {/* Center toggle */}
        {onToggleCenter && (
          <button onClick={onToggleCenter} className={`${btnBase} ${centerPage ? btnActive : ''}`} title="Center page on screen">
            ⊕ Center
          </button>
        )}

        {/* Fullscreen */}
        <button onClick={toggleFullscreen} className={btnBase}>
          {isFullscreen ? '⛶ Exit' : '⛶ Full'}
        </button>
      </div>
    </div>
  );
}
