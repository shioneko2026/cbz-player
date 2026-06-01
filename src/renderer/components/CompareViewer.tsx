import React, { useState, useEffect, useRef, useCallback } from 'react';

interface CompareViewerProps {
  leftImages: string[];
  leftExtractionId: string;
  leftName: string;
  leftFileSize?: number;
  leftCreatedDate?: string;
  rightImages: string[];
  rightExtractionId: string;
  rightName: string;
  rightFileSize?: number;
  rightCreatedDate?: string;
  darkMode: boolean;
  onDeleteLeft?: () => void;
  onDeleteRight?: () => void;
  onSwap?: () => void;
  onExit?: () => void;
}

function imageUrl(extractionId: string, filename: string): string {
  return `cbz-image://host/${extractionId}/${filename}`;
}

function useImageRetry(maxRetries = 3, delay = 500) {
  const retryCountRef = React.useRef<Map<string, number>>(new Map());
  const handleError = React.useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const src = img.src.split('?')[0];
    const count = retryCountRef.current.get(src) ?? 0;
    if (count < maxRetries) {
      retryCountRef.current.set(src, count + 1);
      setTimeout(() => { img.src = src + `?retry=${count + 1}&t=${Date.now()}`; }, delay);
    }
  }, [maxRetries, delay]);
  const reset = React.useCallback(() => { retryCountRef.current.clear(); }, []);
  return { handleError, reset };
}

type FitMode = 'fit-page' | 'fit-width' | 'fit-height';

export default function CompareViewer(props: CompareViewerProps) {
  const {
    leftImages, leftExtractionId, leftName,
    rightImages, rightExtractionId, rightName,
    darkMode, onDeleteLeft, onDeleteRight, onSwap, onExit,
    leftFileSize, leftCreatedDate, rightFileSize, rightCreatedDate,
  } = props;

  const [leftPage, setLeftPage] = useState(0);
  const [rightPage, setRightPage] = useState(0);
  const [synced, setSynced] = useState(true);
  // Offset between right and left pages (right - left) captured when sync is
  // enabled. Allows the user to manually align two doujins that have a page
  // offset (e.g. one has a blank insert page) by: disable sync, navigate each
  // side independently to the matching pages, re-enable sync. From then on,
  // navigation moves both sides by the same delta, preserving the alignment.
  // At default (both pages 0, sync enabled), offset = 0 — same as old behavior.
  const [syncOffset, setSyncOffset] = useState(0);
  const [fitMode, setFitMode] = useState<FitMode>('fit-page');
  const [zoom, setZoom] = useState(1);
  const [showControls, setShowControls] = useState(true);
  const { handleError: handleImgError, reset: resetRetries } = useImageRetry();
  const [hoveredSide, setHoveredSide] = useState<'left' | 'right' | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [lockedSideWidth, setLockedSideWidth] = useState<number | null>(null);

  // Lock each side's width when compare mode starts
  useEffect(() => {
    if (containerRef.current && lockedSideWidth === null) {
      const w = Math.floor(containerRef.current.clientWidth / 2);
      setLockedSideWidth(w);
    }
  }, [lockedSideWidth]);

  const leftTotal = leftImages.length;
  const rightTotal = rightImages.length;

  // Page navigation. When sync is on, the "other" side targets `clamped +/-
  // syncOffset` and is clamped to its own range. If the offset would push the
  // other side past its boundary, that side sticks at the boundary while this
  // side continues — preserves the "keep scrolling the longer file alone"
  // behavior the user relies on. When the navigating side comes back into the
  // range where the offset is satisfiable, sync re-engages automatically.
  const goLeftPage = useCallback((p: number) => {
    const clamped = Math.max(0, Math.min(p, leftTotal - 1));
    setLeftPage(clamped);
    if (synced) {
      const targetRight = clamped + syncOffset;
      setRightPage(Math.max(0, Math.min(targetRight, rightTotal - 1)));
    }
  }, [leftTotal, rightTotal, synced, syncOffset]);

  const goRightPage = useCallback((p: number) => {
    const clamped = Math.max(0, Math.min(p, rightTotal - 1));
    setRightPage(clamped);
    if (synced) {
      const targetLeft = clamped - syncOffset;
      setLeftPage(Math.max(0, Math.min(targetLeft, leftTotal - 1)));
    }
  }, [leftTotal, rightTotal, synced, syncOffset]);

  // Toggling sync ON captures the current offset (rightPage - leftPage) so the
  // user's manual alignment is preserved. Toggling sync OFF doesn't reset the
  // offset — it just stops applying it during navigation. Used by both the
  // Ctrl+I keyboard shortcut and the on-screen sync button.
  const toggleSync = useCallback(() => {
    setSynced(prev => {
      const next = !prev;
      if (next) setSyncOffset(rightPage - leftPage);
      return next;
    });
  }, [leftPage, rightPage]);

  // Keyboard/scroll navigation based on hovered side
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onExit?.(); return; }
      // F11 handled by Electron menu bar accelerator — don't duplicate here
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
        e.preventDefault(); toggleSync(); return;
      }
      // Ctrl+F cycles fit mode: Fit → Height → Width → Fit. Same behavior as
      // the main CbzViewer; local to this component because fitMode is local.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFitMode(curr => {
          const cycle: FitMode[] = ['fit-page', 'fit-height', 'fit-width'];
          return cycle[(cycle.indexOf(curr) + 1) % cycle.length];
        });
        return;
      }

      const side = hoveredSide ?? 'left';
      const goPage = side === 'left' ? goLeftPage : goRightPage;
      const current = side === 'left' ? leftPage : rightPage;
      const total = side === 'left' ? leftTotal : rightTotal;

      switch (e.key) {
        case 'ArrowRight': case 'ArrowDown': case ' ':
          e.preventDefault(); goPage(current + 1); break;
        case 'ArrowLeft': case 'ArrowUp':
          e.preventDefault(); goPage(current - 1); break;
        case 'PageUp':
          e.preventDefault(); goPage(0); break;
        case 'PageDown':
          e.preventDefault(); goPage(total - 1); break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hoveredSide, leftPage, rightPage, leftTotal, rightTotal, goLeftPage, goRightPage, onExit]);

  // Controls auto-hide
  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setShowControls(false), 1500);
  }, []);

  // Scroll handler
  const handleWheel = useCallback((e: React.WheelEvent, side: 'left' | 'right') => {
    if (e.ctrlKey) {
      e.preventDefault();
      setZoom(z => e.deltaY < 0 ? Math.min(z + 0.25, 5) : Math.max(z - 0.25, 0.25));
      return;
    }
    const goPage = side === 'left' ? goLeftPage : goRightPage;
    const current = side === 'left' ? leftPage : rightPage;
    if (e.deltaY > 0) goPage(current + 1);
    else if (e.deltaY < 0) goPage(current - 1);
  }, [leftPage, rightPage, goLeftPage, goRightPage]);

  const getImageStyle = (): React.CSSProperties => {
    const base: React.CSSProperties = {
      display: 'block',
      transform: zoom !== 1 ? `scale(${zoom})` : undefined,
      transformOrigin: 'center center',
    };
    switch (fitMode) {
      case 'fit-width': return { ...base, width: '100%', height: 'auto' };
      case 'fit-height': return { ...base, width: 'auto', height: '100%' };
      case 'fit-page':
      default:
        // Fills the container in both axes + preserves aspect ratio. Replaces
        // maxWidth/maxHeight (which only constrains) so small images upscale to
        // fill instead of staying at intrinsic size. See matching change in
        // CbzViewer for context.
        return { ...base, width: '100%', height: '100%', objectFit: 'contain' as const };
    }
  };

  const bg = darkMode ? 'bg-black' : 'bg-zinc-200';
  const controlsBg = darkMode ? 'bg-zinc-900/80' : 'bg-white/80';
  const controlsText = darkMode ? 'text-zinc-300' : 'text-zinc-700';
  const btnBase = `px-2 py-1 rounded text-xs transition-colors ${darkMode ? 'hover:bg-zinc-700' : 'hover:bg-zinc-200'}`;
  const btnActive = darkMode ? 'bg-zinc-700' : 'bg-zinc-300';
  const sideBorder = darkMode ? 'border-zinc-700' : 'border-zinc-400';

  const formatSize = (bytes?: number) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const renderSide = (
    images: string[], extractionId: string, name: string,
    page: number, total: number, side: 'left' | 'right',
    onDelete?: () => void,
    fileSize?: number, createdDate?: string,
  ) => (
    <div
      className={`h-full flex flex-col relative overflow-hidden min-h-0 ${side === 'left' ? `border-r ${sideBorder}` : ''}`}
      style={lockedSideWidth ? { width: lockedSideWidth, flexShrink: 0 } : { flex: 1 }}
      onMouseEnter={() => setHoveredSide(side)}
      onWheel={(e) => handleWheel(e, side)}
    >
      {/* Info block — bottom, mirrored toward center: page count, file size, date */}
      <div className={`absolute bottom-3 z-10 px-3 py-1.5 rounded ${side === 'left' ? 'right-3 text-right' : 'left-3 text-left'} ${darkMode ? 'bg-black/60 text-zinc-200' : 'bg-white/60 text-zinc-700'}`}>
        <div className="text-sm font-medium tabular-nums">{page + 1} / {total}</div>
        {fileSize ? <div className="text-xs tabular-nums opacity-70">{formatSize(fileSize)}</div> : null}
        {createdDate ? <div className="text-xs opacity-70">{createdDate}</div> : null}
      </div>

      {/* Delete button — bottom, mirrored toward center */}
      {onDelete && (
        <button
          onClick={onDelete}
          className={`absolute bottom-20 z-10 px-3 py-1.5 rounded text-sm font-medium transition-opacity opacity-60 hover:opacity-100 bg-red-700 hover:bg-red-600 text-white ${side === 'left' ? 'right-3' : 'left-3'}`}
        >
          Delete {side === 'left' ? 'Left' : 'Right'}
        </button>
      )}


      {/* Image */}
      <div className="flex-1 flex items-center justify-center overflow-hidden">
        {images.length > 0 && page < images.length && (
          <img
            key={`${extractionId}-${images[page]}`}
            src={imageUrl(extractionId, images[page])}
            alt={`Page ${page + 1}`}
            style={getImageStyle()}
            draggable={false}
            onError={handleImgError}
          />
        )}
      </div>
    </div>
  );

  return (
    <div
      ref={containerRef}
      className={`h-full w-full ${bg} flex flex-col relative select-none`}
      onMouseMove={handleMouseMove}
    >
      {/* Two-pane view */}
      <div className="flex-1 flex min-h-0">
        {renderSide(leftImages, leftExtractionId, leftName, leftPage, leftTotal, 'left', onDeleteLeft, leftFileSize, leftCreatedDate)}
        {renderSide(rightImages, rightExtractionId, rightName, rightPage, rightTotal, 'right', onDeleteRight, rightFileSize, rightCreatedDate)}
      </div>

      {/* Shared controls bar — absolute overlay, shows on mouse move */}
      <div className={`flex-shrink-0 ${controlsBg} ${controlsText}`}>
        {/* Filenames stacked — centered on screen, left-aligned within the block */}
        <div className="flex justify-center px-4 py-1">
          <div className={`text-left max-w-[70%] ${darkMode ? 'text-zinc-500' : 'text-zinc-500'}`}>
            <div className="text-[10px] leading-tight break-words">◀ {leftName}</div>
            <div className="text-[10px] leading-tight break-words">▶ {rightName}</div>
          </div>
        </div>
        {/* Controls row */}
        <div className="flex items-center justify-center gap-4 px-4 py-1.5">
          <button onClick={onSwap} className={btnBase} title="Swap sides">⇄ Swap</button>
          <button onClick={toggleSync} className={`${btnBase} ${synced ? btnActive : ''}`} title="Sync page navigation">
            {synced ? '🔗 Synced' : '🔓 Independent'}
          </button>
          <div className="flex gap-1">
            {([['fit-page', 'Fit'], ['fit-height', 'Height'], ['fit-width', 'Width']] as const).map(([mode, label]) => (
              <button key={mode} onClick={() => setFitMode(mode)} className={`${btnBase} ${fitMode === mode ? btnActive : ''}`}>{label}</button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setZoom(z => Math.max(z - 0.25, 0.25))} className={btnBase}>−</button>
            <span className="text-xs tabular-nums w-10 text-center">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => Math.min(z + 0.25, 5))} className={btnBase}>+</button>
          </div>
          <button onClick={onExit} className={`${btnBase} text-red-400`} title="Exit compare mode (Escape)">✕ Exit Compare</button>
        </div>
      </div>
    </div>
  );
}
