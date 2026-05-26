import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { CategoryConfig, DEFAULT_CATEGORIES } from './file-operations';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AppConfig {
  categories: CategoryConfig[];
  viewerMode: 'single' | 'dual-rtl' | 'dual-ltr' | 'scroll';
  paneDark: boolean;
  viewerDark: boolean;
  viewerWindowBounds?: WindowBounds;
  playlistWindowBounds?: WindowBounds;
  playlistAlwaysOnTop: boolean;
  isDocked: boolean;
  dockedPanelWidth: number;
  playlistVisible: boolean;
  centerPage: boolean;
  logHeight: number;
  useSourceFolder: boolean;
  customOutputFolder: string;
  controlsHideDelay: number;
  controlBarMode: 'auto-hide' | 'hover-only' | 'always-visible';
  startFullscreen: boolean;
  darkBgBrightness: number;
  lightBgBrightness: number;
  writeLogsEnabled: boolean;
  minLogSessionMinutes: number;
  repackColumns: number;
  repackThumbnailSize: number;
  repackPanelWidth: number;
  beepOnLastPage: boolean;
  beepVolume: number;
  beepPitch: number;
}

const DEFAULT_CONFIG: AppConfig = {
  categories: DEFAULT_CATEGORIES,
  viewerMode: 'single',
  paneDark: true,
  viewerDark: true,
  playlistAlwaysOnTop: false,
  isDocked: false,
  dockedPanelWidth: 320,
  playlistVisible: true,
  centerPage: false,
  logHeight: 112,
  useSourceFolder: true,
  customOutputFolder: '',
  controlsHideDelay: 1500,
  controlBarMode: 'auto-hide' as const,
  startFullscreen: false,
  darkBgBrightness: 26,
  lightBgBrightness: 232,
  writeLogsEnabled: false,
  minLogSessionMinutes: 5,
  repackColumns: 3,
  repackThumbnailSize: 150,
  repackPanelWidth: 40,
  beepOnLastPage: true,
  beepVolume: 0.15,
  beepPitch: 600,
};

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'cbz-player-config.json');
}

function getLegacyConfigPath(): string {
  // Pre-rename filename. Read once on startup and migrate to the new name so
  // user-saved settings (per-category overrides, window state, etc.) survive
  // the rename without manual intervention.
  return path.join(app.getPath('userData'), 'cbz-sorter-config.json');
}

export function loadConfig(): AppConfig {
  const configPath = getConfigPath();
  const legacyPath = getLegacyConfigPath();
  // One-shot migration: if the new file doesn't exist but the legacy one does,
  // copy it across and delete the old one. Self-healing — runs once, then the
  // legacy file is gone and this branch never triggers again.
  try {
    if (!fs.existsSync(configPath) && fs.existsSync(legacyPath)) {
      fs.copyFileSync(legacyPath, configPath);
      try { fs.unlinkSync(legacyPath); } catch {}
    }
  } catch {}
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {}
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: Partial<AppConfig>): void {
  const configPath = getConfigPath();
  try {
    const existing = loadConfig();
    const merged = { ...existing, ...config };
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}
