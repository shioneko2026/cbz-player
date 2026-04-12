import fs from 'fs';
import path from 'path';

export interface FileInfo {
  name: string;
  fullPath: string;
  sizeBytes: number;
}

export interface CategoryConfig {
  id: string;
  label: string;
  folderName: string;
  hotkey: string;
  color: string;
  parentCategory?: string;
  dupeFolderName?: string;
  isPurge?: boolean;
}

export const DEFAULT_CATEGORIES: CategoryConfig[] = [
  { id: 'keep', label: 'Keep', folderName: '[00-Keep]', hotkey: 'k', color: 'emerald', dupeFolderName: '[Keep Dupes]' },
  { id: 'purge', label: 'Purge', folderName: '', hotkey: 'p', color: 'red', isPurge: true },
  { id: 'fix', label: 'To Fix', folderName: '[Needs Fixing]', hotkey: 'f', color: 'amber', dupeFolderName: '[Fix Dupes]' },
  { id: 'translate', label: 'Translate', folderName: '[To Be Translated OG]', hotkey: 't', color: 'sky', dupeFolderName: '[To Be TL Dupes]' },
  { id: 'inquire', label: 'Inquire', folderName: '[00-Inquire]', hotkey: 'i', color: 'purple', parentCategory: 'keep' },
  { id: 'unreadable', label: 'Unreadable', folderName: '[File Name Too Long]', hotkey: 'u', color: 'rose' },
];

/**
 * Scan a folder for .cbz files, sorted alphabetically (natural sort).
 */
export function scanForCbzFiles(folderPath: string): FileInfo[] {
  if (!fs.existsSync(folderPath)) return [];

  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  const cbzFiles: FileInfo[] = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.cbz')) {
      const fullPath = path.join(folderPath, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        cbzFiles.push({
          name: entry.name,
          fullPath,
          sizeBytes: stat.size,
        });
      } catch {
        // Skip files we can't stat
      }
    }
  }

  // Natural sort: handles "page1, page2, ..., page10" correctly
  cbzFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return cbzFiles;
}

/**
 * Build FileInfo objects from an array of specific file paths.
 * Filters to only .cbz files that exist.
 */
export function getFileInfoFromPaths(filePaths: string[]): FileInfo[] {
  const cbzFiles: FileInfo[] = [];

  for (const fp of filePaths) {
    if (!fp.toLowerCase().endsWith('.cbz')) continue;
    try {
      const stat = fs.statSync(fp);
      if (stat.isFile()) {
        cbzFiles.push({
          name: path.basename(fp),
          fullPath: fp,
          sizeBytes: stat.size,
        });
      }
    } catch {
      // Skip files that don't exist or can't be accessed
    }
  }

  cbzFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return cbzFiles;
}

/**
 * Determine the sort destination base folder from a list of file paths.
 * If all files are in the same folder, return that folder.
 * If files are from multiple folders, return null (caller should prompt user).
 */
export function detectSortDestination(filePaths: string[]): string | null {
  const folders = new Set(filePaths.map(fp => path.dirname(fp)));
  if (folders.size === 1) {
    return [...folders][0];
  }
  return null; // Multiple source folders
}

/**
 * Move a file to a sort category folder. Handles dupe detection.
 * Returns { moved: true, destPath, isDupe } or throws on error.
 */
export function sortFile(
  filePath: string,
  baseFolder: string,
  category: CategoryConfig,
  categories: CategoryConfig[],
): { destPath: string; isDupe: boolean } {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Source file not found: ${path.basename(filePath)}`);
  }

  // Resolve destination folder
  let destFolder: string;
  if (category.parentCategory) {
    const parent = categories.find(c => c.id === category.parentCategory);
    if (parent && parent.folderName) {
      destFolder = path.join(baseFolder, parent.folderName, category.folderName);
    } else {
      destFolder = path.join(baseFolder, category.folderName);
    }
  } else {
    destFolder = path.join(baseFolder, category.folderName);
  }

  // Ensure destination exists
  if (!fs.existsSync(destFolder)) {
    fs.mkdirSync(destFolder, { recursive: true });
  }

  const fileName = path.basename(filePath);
  let destPath = path.join(destFolder, fileName);
  let isDupe = false;

  // Check for dupe
  if (fs.existsSync(destPath)) {
    isDupe = true;
    if (category.dupeFolderName) {
      // Redirect to dupe folder
      const dupeFolder = path.join(baseFolder, category.dupeFolderName);
      if (!fs.existsSync(dupeFolder)) {
        fs.mkdirSync(dupeFolder, { recursive: true });
      }
      destPath = path.join(dupeFolder, fileName);
      // If dupe folder also has the file, add timestamp
      if (fs.existsSync(destPath)) {
        const ext = path.extname(fileName);
        const base = path.basename(fileName, ext);
        destPath = path.join(dupeFolder, `${base}_${Date.now()}${ext}`);
      }
    } else {
      // No dupe folder defined — force replace (for Inquire/Unreadable)
      fs.unlinkSync(destPath);
    }
  }

  // Move the file
  fs.renameSync(filePath, destPath);
  return { destPath, isDupe };
}

/**
 * Rename a file on disk. Returns the new FileInfo or throws on error.
 */
export function renameFile(oldPath: string, newName: string): FileInfo {
  const dir = path.dirname(oldPath);
  const newPath = path.join(dir, newName);

  if (fs.existsSync(newPath)) {
    throw new Error(`File already exists: ${newName}`);
  }
  if (!fs.existsSync(oldPath)) {
    throw new Error(`Source file not found: ${path.basename(oldPath)}`);
  }

  fs.renameSync(oldPath, newPath);
  const stat = fs.statSync(newPath);
  return { name: newName, fullPath: newPath, sizeBytes: stat.size };
}

/**
 * Ensure all sort category destination folders exist under the base folder.
 */
export function ensureSortFolders(baseFolder: string, categories: CategoryConfig[]): void {
  for (const cat of categories) {
    if (cat.isPurge || !cat.folderName) continue;

    let targetDir: string;
    if (cat.parentCategory) {
      const parent = categories.find(c => c.id === cat.parentCategory);
      if (parent && parent.folderName) {
        targetDir = path.join(baseFolder, parent.folderName, cat.folderName);
      } else {
        targetDir = path.join(baseFolder, cat.folderName);
      }
    } else {
      targetDir = path.join(baseFolder, cat.folderName);
    }

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
  }
}
