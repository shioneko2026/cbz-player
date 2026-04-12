export interface FileInfo {
  name: string;
  fullPath: string;
  sizeBytes: number;
}

export interface AppState {
  files: FileInfo[];
  currentIndex: number;
  sortDestination: string | null;
  shuffleEnabled: boolean;
  skipViewedEnabled: boolean;
  globalHotkeysEnabled: boolean;
  viewedPaths: Set<string>;
  isProcessing: boolean;
}

export type NavigationAction = 'next' | 'back' | 'random';
