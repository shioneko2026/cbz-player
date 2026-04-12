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

// Retry loading broken images (race condition during rapid extraction)
function useImageRetry(maxRetries = 3, delay = 300) {
  const retryCountRef = React.useRef<Map<string, number>>(new Map());

  const handleError = React.useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const src = img.src;
    const count = retryCountRef.current.get(src) ?? 0;
    if (count < maxRetries) {
      retryCountRef.current.set(src, count + 1);
      setTimeout(() => {
        img.src = src + (src.includes('?') ? '&' : '?') + `retry=${count + 1}`;
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
  }, [images, currentPage, viewMode]);

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

  // Reset page when images change
  useEffect(() => {
    setCurrentPage(0);
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

  // Dual page rendering — offset applied to wrapper, not individual images
  const renderDualPages = () => {
    const leftIdx = viewMode === 'dual-rtl' ? currentPage + 1 : currentPage;
    const rightIdx = viewMode === 'dual-rtl' ? currentPage : currentPage + 1;
    // Remove position/left from individual image styles for dual mode
    const baseStyle = getImageStyle();
    const imgStyle = { ...baseStyle, maxWidth: '49%', position: undefined as any, left: undefined as any };

    return (
      <div
        className="flex items-center justify-center gap-1 h-full"
        style={clampedOffset ? { position: 'relative', left: `${clampedOffset}px` } : undefined}
      >
        {leftIdx >= 0 && leftIdx < totalPages && (
          <img key={images[leftIdx]} src={imageUrl(images[leftIdx])} alt={`Page ${leftIdx + 1}`} style={imgStyle} draggable={false}
            onError={handleImgError} />
        )}
        {rightIdx >= 0 && rightIdx < totalPages && (
          <img key={images[rightIdx]} src={imageUrl(images[rightIdx])} alt={`Page ${rightIdx + 1}`} style={imgStyle} draggable={false}
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
        {viewMode === 'single' && (
          <img
            key={images[currentPage]}
            src={imageUrl(images[currentPage])}
            alt={`Page ${currentPage + 1}`}
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
          {([['fit-page', 'Fit'], ['fit-width', 'Width'], ['fit-height', 'Height']] as const).map(([mode, label]) => (
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
