import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import sevenBin from '7zip-bin';
import yauzl from 'yauzl';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

/**
 * An extracted image lives either in memory (ZIP/RAR fast path, avoids touching
 * the filesystem — immune to Windows MAX_PATH) or on disk (7z fallback, uses a
 * deliberately short staging path to minimise MAX_PATH risk).
 */
export type ImageSource = { memory: Buffer } | { disk: string };

interface SlotData {
  tempDir: string | null;       // non-null only for disk-backed slots
  sources: ImageSource[];       // indexed by page number
  names: string[];              // basename per page, for display/repack
  relativePaths: string[];      // original intra-archive paths, for topLevelFolder detection
  topLevelFolder: string;
}

const slotData = new Map<string, SlotData>();
let extractionCounter = 0;

function isImageFile(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

/** Basename that handles both / and \ separators (ZIP entries always use /). */
function entryBasename(name: string): string {
  const idx = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return idx >= 0 ? name.substring(idx + 1) : name;
}

function detectFormatFromBuffer(buf: Buffer): 'zip' | 'rar' | '7z' | 'unknown' {
  if (buf.length < 4) return 'unknown';
  if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) return 'rar';
  if (buf[0] === 0x50 && buf[1] === 0x4B) return 'zip';
  if (buf.length >= 6 && buf[0] === 0x37 && buf[1] === 0x7A && buf[2] === 0xBC && buf[3] === 0xAF) return '7z';
  return 'unknown';
}

/** Return the common top-level folder across all relative paths, or '' if none. */
function detectTopLevelFolder(relativePaths: string[]): string {
  if (relativePaths.length === 0) return '';
  const firstSegments = relativePaths.map(p => {
    const parts = p.split(/[\\/]/);
    return parts.length > 1 ? parts[0] : '';
  });
  const first = firstSegments[0];
  if (!first) return '';
  return firstSegments.every(s => s === first) ? first : '';
}

/** Short random-ish id for staging dirs to keep MAX_PATH headroom. */
function shortId(): string {
  return Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 0xfff).toString(16).padStart(3, '0');
}

export type ProgressCallback = (percent: number, status: string) => void;

type RawEntry = { name: string; data: Buffer };

/**
 * Extract a ZIP fully into memory via yauzl.fromBuffer. Operates on the
 * archive bytes in memory, never touching the filesystem — immune to MAX_PATH
 * regardless of either the archive's file path or its internal folder names.
 */
async function extractZipFromBuffer(archiveBuffer: Buffer): Promise<RawEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archiveBuffer, { lazyEntries: true }, (err, zipFile) => {
      if (err) return reject(err);
      if (!zipFile) return reject(new Error('yauzl returned no zipfile'));

      const results: RawEntry[] = [];
      zipFile.on('error', reject);
      zipFile.on('end', () => resolve(results));
      zipFile.on('entry', (entry: yauzl.Entry) => {
        // Skip directory entries
        if (/[\\/]$/.test(entry.fileName)) { zipFile.readEntry(); return; }
        // Only bother decompressing images
        if (!isImageFile(entry.fileName)) { zipFile.readEntry(); return; }

        zipFile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) return reject(streamErr);
          if (!readStream) return reject(new Error('openReadStream returned null'));
          const chunks: Buffer[] = [];
          readStream.on('data', (chunk: Buffer) => chunks.push(chunk));
          readStream.on('end', () => {
            results.push({ name: entry.fileName, data: Buffer.concat(chunks) });
            zipFile.readEntry();
          });
          readStream.on('error', reject);
        });
      });
      zipFile.readEntry();
    });
  });
}

/**
 * Extract a RAR fully into memory via node-unrar-js.createExtractorFromData.
 * Takes the raw archive bytes; no filesystem access on the input side.
 */
async function extractRarFromBuffer(archiveBuffer: Buffer): Promise<RawEntry[]> {
  const { createExtractorFromData } = await import('node-unrar-js');
  // node-unrar-js's createExtractorFromData expects an ArrayBuffer. Copy the
  // Buffer's contents into a fresh ArrayBuffer (Node Buffers can be slices of a
  // shared pool, so passing .buffer directly could include unrelated bytes).
  const ab = new ArrayBuffer(archiveBuffer.byteLength);
  new Uint8Array(ab).set(archiveBuffer);
  const extractor = await createExtractorFromData({ data: ab });
  const extracted = extractor.extract();
  const results: RawEntry[] = [];
  for (const file of extracted.files) {
    if (file.fileHeader.flags.directory) continue;
    const name = file.fileHeader.name;
    if (!isImageFile(name)) continue;
    if (file.extraction) {
      results.push({ name, data: Buffer.from(file.extraction) });
    }
  }
  return results;
}

/**
 * Disk fallback for 7z (and malformed ZIP/RAR). Writes the archive bytes to a
 * short temp file so 7za.exe never sees the user's possibly-long source path,
 * then extracts into a short staging dir.
 */
async function extract7zFromBuffer(archiveBuffer: Buffer, outputDir: string): Promise<void> {
  const shortInputPath = path.join(os.tmpdir(), `cbz-in-${shortId()}.bin`);
  fs.writeFileSync(shortInputPath, archiveBuffer);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(sevenBin.path7za, ['x', shortInputPath, `-o${outputDir}`, '-y', '-spd'], {
        timeout: 60000, maxBuffer: 10 * 1024 * 1024,
      }, (err, _stdout, stderr) => {
        if (err) { reject(new Error(stderr?.trim() || err.message)); return; }
        resolve();
      });
    });
  } finally {
    try { fs.unlinkSync(shortInputPath); } catch {}
  }
}

/**
 * Extract images from a CBZ/CBR/CB7 file into a named slot.
 * Slot defaults to 'main'. Compare mode uses 'compare-left' and 'compare-right'.
 * Previous extraction in the same slot is cleaned up.
 *
 * ZIP and RAR archives go through in-memory extractors (no filesystem involvement);
 * 7z archives fall back to disk extraction with a deliberately short staging path.
 * Format detection is by magic bytes (extension is ignored — many .cbz files are
 * actually RAR or 7z), with extractor fallback if the detected format fails.
 */
export async function extractCbz(
  cbzPath: string,
  slot: string = 'main',
  onProgress?: ProgressCallback,
): Promise<{ images: string[]; imageNames: string[]; extractionId: string; topLevelFolder: string }> {
  cleanupSlot(slot);
  ++extractionCounter;

  // Read the archive bytes via a long-path-safe namespaced path. This is the
  // ONLY disk access to the user-supplied path; every downstream extractor
  // operates on the Buffer, so none of them can trip on MAX_PATH for the input
  // filename (which can easily exceed 260 chars for long-titled CBZs).
  const nsPath = path.toNamespacedPath(cbzPath);

  onProgress?.(5, 'Reading archive...');
  let archiveBuffer: Buffer;
  try {
    archiveBuffer = await fs.promises.readFile(nsPath);
  } catch (err: any) {
    throw new Error(`Cannot read archive file: ${err.message ?? String(err)}`);
  }

  const fileSizeMB = archiveBuffer.byteLength / (1024 * 1024);
  const estimatedSeconds = Math.max(2, fileSizeMB / 10);
  const format = detectFormatFromBuffer(archiveBuffer);

  onProgress?.(10, `Extracting archive (${fileSizeMB.toFixed(0)} MB)...`);

  // Progress ticker for the extraction window (10% → 55%)
  let extractDone = false;
  const tickerStart = Date.now();
  const progressTicker = setInterval(() => {
    if (extractDone) return;
    const elapsed = (Date.now() - tickerStart) / 1000;
    const progress = Math.min(55, 10 + (elapsed / estimatedSeconds) * 45);
    onProgress?.(Math.round(progress), `Extracting archive (${fileSizeMB.toFixed(0)} MB)...`);
  }, 500);

  const errors: string[] = [];

  // Ordered list of in-memory extractors to try based on detected format
  const memoryAttempts: Array<{ name: string; run: () => Promise<RawEntry[]> }> = [];
  if (format === 'zip' || format === 'unknown') {
    memoryAttempts.push({ name: 'yauzl', run: () => extractZipFromBuffer(archiveBuffer) });
  }
  if (format === 'rar' || format === 'unknown') {
    memoryAttempts.push({ name: 'unrar-js', run: () => extractRarFromBuffer(archiveBuffer) });
  }

  let memoryEntries: RawEntry[] | null = null;
  for (const attempt of memoryAttempts) {
    try {
      const r = await attempt.run();
      if (r.length > 0) { memoryEntries = r; break; }
    } catch (err: any) {
      errors.push(`${attempt.name}: ${err.message ?? String(err)}`);
    }
  }

  let diskTempDir: string | null = null;
  let diskEntries: Array<{ relativePath: string; fullPath: string }> | null = null;

  if (!memoryEntries) {
    // Fall back to disk extraction via 7za. Used for real 7z archives, or as a
    // last resort when in-memory extractors can't parse the file. The archive
    // bytes get written to a short temp file first so 7za never sees the
    // original long path.
    diskTempDir = path.join(os.tmpdir(), `cbz-${shortId()}`);
    try {
      fs.mkdirSync(diskTempDir, { recursive: true });
      await extract7zFromBuffer(archiveBuffer, diskTempDir);
      const collected: Array<{ relativePath: string; fullPath: string }> = [];
      collectImages(diskTempDir, diskTempDir, collected);
      if (collected.length === 0) throw new Error('Disk extraction produced no images');
      diskEntries = collected;
    } catch (err: any) {
      errors.push(`7za: ${err.message ?? String(err)}`);
      // Clean up the partial staging dir
      if (diskTempDir && fs.existsSync(diskTempDir)) {
        try { fs.rmSync(diskTempDir, { recursive: true, force: true }); } catch {}
      }
      extractDone = true;
      clearInterval(progressTicker);
      throw new Error(`All extractors failed:\n${errors.join('\n')}`);
    }
  }

  extractDone = true;
  clearInterval(progressTicker);

  onProgress?.(90, 'Indexing pages...');

  let sources: ImageSource[];
  let names: string[];
  let relativePaths: string[];

  if (memoryEntries) {
    memoryEntries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    sources = memoryEntries.map(e => ({ memory: e.data }));
    names = memoryEntries.map(e => entryBasename(e.name));
    relativePaths = memoryEntries.map(e => e.name);
  } else if (diskEntries) {
    diskEntries.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true, sensitivity: 'base' }));
    sources = diskEntries.map(d => ({ disk: d.fullPath }));
    names = diskEntries.map(d => path.basename(d.fullPath));
    relativePaths = diskEntries.map(d => d.relativePath);
  } else {
    throw new Error('Extraction produced no images');
  }

  if (sources.length === 0) {
    if (diskTempDir && fs.existsSync(diskTempDir)) {
      try { fs.rmSync(diskTempDir, { recursive: true, force: true }); } catch {}
    }
    throw new Error('No images found in archive');
  }

  const topLevelFolder = detectTopLevelFolder(relativePaths);
  slotData.set(slot, { tempDir: diskTempDir, sources, names, relativePaths, topLevelFolder });

  onProgress?.(100, 'Done');

  const images = sources.map((_, i) => String(i));
  return { images, imageNames: names, extractionId: slot, topLevelFolder };
}

/**
 * Resolve a page request (slot + page-index as string) to either an in-memory
 * buffer or a disk path. The protocol handler uses this to decide how to
 * construct the Response body.
 */
export function resolveImage(extractionId: string, filename: string): ImageSource | null {
  const data = slotData.get(extractionId);
  if (!data) return null;
  const pageIndex = parseInt(filename, 10);
  if (isNaN(pageIndex) || pageIndex < 0 || pageIndex >= data.sources.length) return null;
  return data.sources[pageIndex];
}

/** Return the sources array for a slot (or null if no extraction). Used by the repack handler. */
export function getSlotSources(slot: string): ImageSource[] | null {
  const data = slotData.get(slot);
  return data ? data.sources : null;
}

/** Return the basenames for a slot (or null). Used by the repack handler for original filenames. */
export function getSlotNames(slot: string): string[] | null {
  const data = slotData.get(slot);
  return data ? data.names : null;
}

/** Presence check — used by the repack handler in place of the old getSlotDir. */
export function hasSlot(slot: string): boolean {
  return slotData.has(slot);
}

/** Clean up a specific slot's resources (disk temp dir if any, plus in-memory buffers via GC). */
export function cleanupSlot(slot: string): void {
  const data = slotData.get(slot);
  if (data?.tempDir && fs.existsSync(data.tempDir)) {
    try { fs.rmSync(data.tempDir, { recursive: true, force: true }); } catch {}
  }
  slotData.delete(slot);
}

/** Clean up all extraction resources across every slot. */
export function cleanupTemp(): void {
  for (const slot of Array.from(slotData.keys())) {
    cleanupSlot(slot);
  }
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
