import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import sevenBin from '7zip-bin';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

// Named extraction slots — each slot holds its own temp dir
const slots = new Map<string, string>();
let extractionCounter = 0;

function isImageFile(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function detectFormat(filePath: string): 'zip' | 'rar' | '7z' | 'unknown' {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(8);
  fs.readSync(fd, buf, 0, 8, 0);
  fs.closeSync(fd);
  if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) return 'rar';
  if (buf[0] === 0x50 && buf[1] === 0x4B) return 'zip';
  if (buf[0] === 0x37 && buf[1] === 0x7A && buf[2] === 0xBC && buf[3] === 0xAF) return '7z';
  return 'unknown';
}

/**
 * Extract images from a CBZ/CBR/CB7 file into a named slot.
 * Slot defaults to 'main'. Compare mode uses 'compare-left' and 'compare-right'.
 * Previous extraction in the same slot is cleaned up.
 */
export type ProgressCallback = (percent: number, status: string) => void;

export async function extractCbz(cbzPath: string, slot: string = 'main', onProgress?: ProgressCallback): Promise<{ images: string[]; extractionId: string }> {
  // Clean up this specific slot if it already exists (shouldn't happen with unique slots)
  cleanupSlot(slot);

  ++extractionCounter;
  const tempDir = path.join(os.tmpdir(), 'cbz-sorter-viewer', `extract-${slot}-${Date.now()}`);
  const stagingDir = path.join(tempDir, '_staging');
  fs.mkdirSync(stagingDir, { recursive: true });

  // Store in slot — the slot name IS the extractionId
  slots.set(slot, tempDir);

  onProgress?.(5, 'Detecting format...');
  const format = detectFormat(cbzPath);
  const errors: string[] = [];

  onProgress?.(10, 'Extracting archive...');
  const extractors = format === 'rar'
    ? [() => extractRar(cbzPath, stagingDir), () => extract7z(cbzPath, stagingDir)]
    : [() => extract7z(cbzPath, stagingDir), () => extractRar(cbzPath, stagingDir)];

  let extracted = false;
  for (const extractor of extractors) {
    try { await extractor(); extracted = true; break; }
    catch (err: any) { errors.push(err.message); }
  }

  if (!extracted) throw new Error(`All extractors failed:\n${errors.join('\n')}`);

  onProgress?.(60, 'Collecting images...');
  const allImages: { relativePath: string; fullPath: string }[] = [];
  collectImages(stagingDir, stagingDir, allImages);
  allImages.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true, sensitivity: 'base' }));

  const images: string[] = [];
  const total = allImages.length;
  for (let i = 0; i < total; i++) {
    const ext = path.extname(allImages[i].fullPath).toLowerCase();
    const filename = `page-${String(i).padStart(4, '0')}${ext}`;
    if (i % 5 === 0) onProgress?.(60 + Math.round((i / total) * 35), `Processing page ${i + 1}/${total}...`);
    try { fs.copyFileSync(allImages[i].fullPath, path.join(tempDir, filename)); images.push(filename); }
    catch { /* skip */ }
  }

  onProgress?.(98, 'Cleaning up...');
  try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}

  onProgress?.(100, 'Done');
  return { images, extractionId: slot };
}

/**
 * Resolve an image path for the protocol handler.
 * Looks up the specific slot (extractionId = slot name), not all slots.
 */
export function resolveImagePath(extractionId: string, filename: string): string | null {
  const dir = slots.get(extractionId);
  if (dir) {
    const filePath = path.join(dir, filename);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

/**
 * Clean up a specific slot's temp directory.
 */
export function getSlotDir(slot: string): string | null {
  return slots.get(slot) ?? null;
}

export function cleanupSlot(slot: string): void {
  const dir = slots.get(slot);
  if (dir && fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  slots.delete(slot);
}

/**
 * Clean up all extraction temp directories.
 */
export function cleanupTemp(): void {
  for (const [slot] of slots) {
    cleanupSlot(slot);
  }
}

function extract7z(archivePath: string, outputDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(sevenBin.path7za, ['x', archivePath, `-o${outputDir}`, '-y', '-spd'], {
      timeout: 60000, maxBuffer: 10 * 1024 * 1024,
    }, (err, _stdout, stderr) => {
      if (err) { reject(new Error(stderr?.trim() || err.message)); return; }
      resolve();
    });
  });
}

async function extractRar(archivePath: string, outputDir: string): Promise<void> {
  const { createExtractorFromFile } = await import('node-unrar-js');
  const extractor = await createExtractorFromFile({ filepath: archivePath, targetPath: outputDir });
  const extracted = extractor.extract();
  for (const _file of extracted.files) {}
}

function collectImages(dir: string, baseDir: string, results: { relativePath: string; fullPath: string }[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) collectImages(fullPath, baseDir, results);
    else if (isImageFile(entry.name)) results.push({ relativePath: path.relative(baseDir, fullPath), fullPath });
  }
}
