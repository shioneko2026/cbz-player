import { BrowserWindow, screen } from 'electron';
import path from 'path';
import { WindowBounds } from './config-store';

let viewerWindow: BrowserWindow | null = null;
let playlistWindow: BrowserWindow | null = null;

const isDev = process.env.NODE_ENV !== 'production';
const preloadPath = path.join(__dirname, 'preload.js');

function getRendererURL(hash: string): string {
  if (isDev) {
    return `http://localhost:5173/#${hash}`;
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
