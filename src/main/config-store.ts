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
  repackColumns: 3,
  repackThumbnailSize: 150,
  repackPanelWidth: 40,
  beepOnLastPage: true,
  beepVolume: 0.15,
  beepPitch: 600,
};

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'cbz-sorter-config.json');
}

export function loadConfig(): AppConfig {
  const configPath = getConfigPath();
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
