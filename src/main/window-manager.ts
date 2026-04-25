import { BrowserWindow, screen, Display } from 'electron';
import path from 'path';
import { WindowBounds } from './config-store';

let viewerWindow: BrowserWindow | null = null;
let playlistWindow: BrowserWindow | null = null;

// ─── Immerse mode: black out every monitor except the viewer's ────────────────
// A frameless non-focusable always-on-top window per non-viewer display. Viewer
// is briefly promoted to always-on-top for the duration so it stays above the
// blackouts if the user alt-tabs or drags it around.

const blackoutWindows = new Map<number, BrowserWindow>();
let immerseActive = false;
let immerseViewerMoveTimer: ReturnType<typeof setTimeout> | null = null;
let displayListenersAttached = false;
let viewerMoveListenerAttached = false;

function createBlackoutOnDisplay(display: Display): BrowserWindow {
  const { bounds } = display;
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    // Allow fullscreen so we can cover the Windows taskbar, which otherwise
    // refuses to stay under a plain always-on-top window even at screen-saver
    // level (the taskbar has its own topmost z-order exception).
    fullscreenable: true,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    backgroundColor: '#000000',
    title: 'CBZ Sorter — Immerse',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Explicit html+body height so the black fill covers the entire viewport
  // even if a rendering path shortcuts body sizing. Electron's backgroundColor
  // already paints the window black, so this is belt-and-suspenders.
  win.loadURL('data:text/html,<html style="height:100%;background:%23000"><body style="margin:0;height:100%;background:%23000;overflow:hidden"></body></html>');
  win.setAlwaysOnTop(true, 'screen-saver'); // above normal windows but below OS prompts
  win.setIgnoreMouseEvents(true);
  win.showInactive(); // show without stealing focus from viewer
  // Re-assert exact bounds — on mixed-DPI multi-monitor Windows setups the
  // initial constructor bounds occasionally get rounded/scaled incorrectly
  // when the target display has a different scale factor than the primary.
  win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  // Force real fullscreen on Windows so the taskbar gets covered. setFullScreen
  // on a focusable:false window still fullscreens the bounds without stealing
  // keyboard focus from the viewer.
  if (process.platform === 'win32') {
    win.setFullScreen(true);
  }
  return win;
}

function rebuildBlackouts() {
  if (!immerseActive || !viewerWindow || viewerWindow.isDestroyed()) return;
  const displays = screen.getAllDisplays();
  const viewerBounds = viewerWindow.getBounds();
  const viewerDisplay = screen.getDisplayMatching(viewerBounds);
  const targetIds = new Set(displays.filter(d => d.id !== viewerDisplay.id).map(d => d.id));

  // Destroy blackouts that no longer match a target display (viewer moved to
  // them, or the display was removed).
  for (const [id, win] of blackoutWindows) {
    if (!targetIds.has(id)) {
      if (!win.isDestroyed()) win.destroy();
      blackoutWindows.delete(id);
    }
  }
  // Create blackouts for any target display that doesn't already have one.
  for (const d of displays) {
    if (d.id === viewerDisplay.id) continue;
    if (blackoutWindows.has(d.id)) continue;
    blackoutWindows.set(d.id, createBlackoutOnDisplay(d));
  }
}

function attachImmerseListeners() {
  if (!displayListenersAttached) {
    screen.on('display-added', rebuildBlackouts);
    screen.on('display-removed', rebuildBlackouts);
    screen.on('display-metrics-changed', rebuildBlackouts);
    displayListenersAttached = true;
  }
  if (!viewerMoveListenerAttached && viewerWindow && !viewerWindow.isDestroyed()) {
    // Debounce — dragging the viewer fires hundreds of move events per second.
    viewerWindow.on('move', () => {
      if (immerseViewerMoveTimer) clearTimeout(immerseViewerMoveTimer);
      immerseViewerMoveTimer = setTimeout(rebuildBlackouts, 200);
    });
    viewerMoveListenerAttached = true;
  }
}

function detachImmerseListeners() {
  if (displayListenersAttached) {
    screen.removeListener('display-added', rebuildBlackouts);
    screen.removeListener('display-removed', rebuildBlackouts);
    screen.removeListener('display-metrics-changed', rebuildBlackouts);
    displayListenersAttached = false;
  }
  // Viewer move listener stays attached for the window's lifetime — cheap to
  // keep around since the debounced callback is a no-op when immerseActive is
  // false. Simpler than tracking the exact handler reference across calls.
  if (immerseViewerMoveTimer) {
    clearTimeout(immerseViewerMoveTimer);
    immerseViewerMoveTimer = null;
  }
}

/**
 * Toggle Immerse mode. When enabled, creates a black fullscreen window on every
 * display except the one the viewer sits on. Viewer is promoted to always-on-top
 * for the duration so it stays visible above the blackouts. Idempotent.
 */
export function setImmerseEnabled(enabled: boolean): void {
  if (enabled && !viewerWindow) return; // no viewer, no anchor — abort
  if (enabled === immerseActive) return;
  immerseActive = enabled;

  if (enabled) {
    attachImmerseListeners();
    rebuildBlackouts();
    if (viewerWindow && !viewerWindow.isDestroyed()) {
      // screen-saver level matches the blackouts so they share a z-index plane;
      // the viewer stays on top because it's focused and has a later promotion.
      viewerWindow.setAlwaysOnTop(true, 'screen-saver');
      viewerWindow.focus();
    }
  } else {
    detachImmerseListeners();
    for (const [id, win] of blackoutWindows) {
      if (!win.isDestroyed()) win.destroy();
      blackoutWindows.delete(id);
    }
    if (viewerWindow && !viewerWindow.isDestroyed()) {
      viewerWindow.setAlwaysOnTop(false);
    }
  }
}

export function isImmerseActive(): boolean {
  return immerseActive;
}

export function destroyAllBlackouts(): void {
  setImmerseEnabled(false);
}

const isDev = process.env.NODE_ENV !== 'production';
const preloadPath = path.join(__dirname, 'preload.js');

function getRendererURL(hash: string): string {
  if (isDev) {
    return `http://localhost:5210/#${hash}`;
  }
  return `file://${path.join(__dirname, '../renderer/index.html')}#${hash}`;
}

export function createViewerWindow(savedBounds?: WindowBounds): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  viewerWindow = new BrowserWindow({
    width: savedBounds?.width ?? Math.round(width * 0.75),
    height: savedBounds?.height ?? Math.round(height * 0.85),
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#000000',
    title: 'CBZ Sorter v5',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  viewerWindow.loadURL(getRendererURL('viewer'));

  viewerWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  viewerWindow.on('closed', () => {
    viewerWindow = null;
  });

  return viewerWindow;
}

export function createPlaylistWindow(savedBounds?: WindowBounds, isDocked?: boolean): BrowserWindow {
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();
  const secondaryDisplay = displays.find(d => d.id !== primaryDisplay.id);

  let x: number | undefined, y: number | undefined;
  if (savedBounds) {
    x = savedBounds.x;
    y = savedBounds.y;
  } else if (secondaryDisplay) {
    x = secondaryDisplay.workArea.x + 50;
    y = secondaryDisplay.workArea.y + 50;
  } else {
    x = primaryDisplay.workArea.x + primaryDisplay.workArea.width - 420;
    y = primaryDisplay.workArea.y + 50;
  }

  playlistWindow = new BrowserWindow({
    width: savedBounds?.width ?? 380,
    height: savedBounds?.height ?? Math.round(primaryDisplay.workAreaSize.height * 0.9),
    minWidth: 320,
    minHeight: 500,
    x,
    y,
    backgroundColor: '#18181b',
    title: 'CBZ Sorter v5 — Playlist',
    show: !isDocked, // Hidden if starting in docked mode
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  playlistWindow.loadURL(getRendererURL('playlist'));

  playlistWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  playlistWindow.on('closed', () => {
    playlistWindow = null;
  });

  return playlistWindow;
}

export function getViewerWindow(): BrowserWindow | null {
  return viewerWindow;
}

export function getPlaylistWindow(): BrowserWindow | null {
  return playlistWindow;
}

export function getWindowBounds(win: BrowserWindow | null): WindowBounds | undefined {
  if (!win || win.isDestroyed()) return undefined;
  const bounds = win.getBounds();
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

export function sendToAll(channel: string, ...args: any[]) {
  if (viewerWindow && !viewerWindow.isDestroyed()) {
    viewerWindow.webContents.send(channel, ...args);
  }
  if (playlistWindow && !playlistWindow.isDestroyed()) {
    playlistWindow.webContents.send(channel, ...args);
  }
}
