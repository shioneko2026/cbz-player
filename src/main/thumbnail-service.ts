import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { app, nativeImage } from 'electron';
import sevenBin from '7zip-bin';
import yauzl from 'yauzl';

/**
 * Cover-thumbnail service for the playlist's "Thumb List" mode.
 *
 * This is deliberately NOT built on cbz-extractor.ts. That module is a
 * named-slot, whole-archive extractor for the file currently being READ: it
 * decompresses every page into memory. Measured on the user's real library, a
 * full extract costs ~143 ms per archive versus ~7 ms to pull only the first
 * image — a 20x difference that matters when thumbnails are requested by the
 * screenful. Nothing here touches cbz-extractor's slotData.
 *
 * Library facts this is designed around (measured 2026-08-16, n=150):
 *   ~66% of .cbz files are RAR inside, ~33% ZIP (the extension lies).
 *   Cover formats: 55% jpg, 23% png, 21% webp, 1% gif.
 * The webp share is why the renderer-conversion fallback exists: Electron's
 * nativeImage cannot decode webp (verified — it returns an empty image), but
 * Chromium in the renderer decodes it natively.
 */

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif']);

/** Longest edge of a generated thumbnail, in px. Serves all three layouts. */
const THUMB_MAX_EDGE = 480;
const THUMB_JPEG_QUALITY = 80;

/** Hard cap on the on-disk cache. Least-recently-used evicted first. */
const CACHE_CAP_BYTES = 500 * 1024 * 1024;

/** How many covers may be extracted at once. Bounds disk thrash while scrolling. */
const MAX_CONCURRENT = 2;

/**
 * Covers that failed to extract. Prevents a broken archive from being retried
 * on every single scroll past its row. Cleared only by clearCache().
 */
const failedPaths = new Set<string>();

/** fullPath -> resolvers waiting on an in-flight or queued extraction. */
type Waiter = (result: ThumbResult) => void;
const pending = new Map<string, Waiter[]>();
const queue: string[] = [];
let activeCount = 0;

export type ThumbResult =
  | { status: 'ready'; url: string }
  | { status: 'failed'; reason: string };

/** Set by index.ts so the service can ask the viewer renderer to decode webp. */
type ConvertFn = (buffer: Buffer, mime: string) => Promise<Buffer | null>;
let convertViaRenderer: ConvertFn | null = null;
export function setRendererConverter(fn: ConvertFn): void {
  convertViaRenderer = fn;
}

function nsp(p: string): string {
  return path.toNamespacedPath(p);
}

export function getCacheDir(): string {
  return path.join(app.getPath('userData'), 'cbz-thumb-cache');
}

function ensureCacheDir(): string {
  const dir = getCacheDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

/**
 * Cache key is size + mtime, NOT the file path. The user renames files and
 * sorts them into category folders constantly; keying on path would throw away
 * a valid cover on every one of those operations. Residual risk: two files with
 * an identical byte size AND an identical millisecond mtime would share a
 * thumbnail. Accepted as negligible — the failure mode is a wrong picture, not
 * data loss.
 */
export function cacheKeyFor(fullPath: string): string | null {
  try {
    const st = fs.statSync(nsp(fullPath));
    return `${st.size}_${Math.round(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

function cachePathFor(key: string): string {
  return path.join(getCacheDir(), `${key}.jpg`);
}

function urlForKey(key: string): string {
  return `cbz-thumb://thumb/${key}.jpg`;
}

function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * Same collation cbz-extractor.ts uses to order pages (numeric, case-insensitive).
 * Keeping these identical is what makes the thumbnail actually be page 1 of what
 * the viewer will show — if they diverge, covers silently stop matching.
 */
function sortImageNames(names: string[]): string[] {
  return names
    .filter(isImageFile)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function readMagic(fullPath: string): Buffer {
  const buf = Buffer.alloc(8);
  try {
    const fd = fs.openSync(nsp(fullPath), 'r');
    try { fs.readSync(fd, buf, 0, 8, 0); } finally { fs.closeSync(fd); }
  } catch {}
  return buf;
}

function detectFormat(magic: Buffer): 'zip' | 'rar' | '7z' | 'unknown' {
  if (magic.length < 4) return 'unknown';
  if (magic[0] === 0x52 && magic[1] === 0x61 && magic[2] === 0x72 && magic[3] === 0x21) return 'rar';
  if (magic[0] === 0x50 && magic[1] === 0x4b) return 'zip';
  if (magic[0] === 0x37 && magic[1] === 0x7a && magic[2] === 0xbc && magic[3] === 0xaf) return '7z';
  return 'unknown';
}

/** ZIP: read the central directory, then decompress ONLY the first image. */
async function firstImageFromZip(fullPath: string): Promise<{ data: Buffer; name: string }> {
  return new Promise((resolve, reject) => {
    // autoClose MUST be false: with lazyEntries, yauzl closes the handle as soon
    // as the last entry is read, and we only know which entry we want AFTER
    // that. Leaving it on makes openReadStream fail with "closed" — verified.
    yauzl.open(nsp(fullPath), { lazyEntries: true, autoClose: false }, (err, zipFile) => {
      if (err || !zipFile) return reject(err ?? new Error('yauzl returned no zipfile'));
      const entries = new Map<string, yauzl.Entry>();
      zipFile.on('error', reject);
      zipFile.on('entry', (entry: yauzl.Entry) => {
        if (!/[\\/]$/.test(entry.fileName) && isImageFile(entry.fileName)) {
          entries.set(entry.fileName, entry);
        }
        zipFile.readEntry();
      });
      zipFile.on('end', () => {
        const sorted = sortImageNames([...entries.keys()]);
        if (sorted.length === 0) { zipFile.close(); return reject(new Error('No images in archive')); }
        const target = entries.get(sorted[0])!;
        zipFile.openReadStream(target, (streamErr, readStream) => {
          if (streamErr || !readStream) { zipFile.close(); return reject(streamErr ?? new Error('openReadStream failed')); }
          const chunks: Buffer[] = [];
          readStream.on('data', (c: Buffer) => chunks.push(c));
          readStream.on('end', () => { zipFile.close(); resolve({ data: Buffer.concat(chunks), name: sorted[0] }); });
          readStream.on('error', (e) => { zipFile.close(); reject(e); });
        });
      });
      zipFile.readEntry();
    });
  });
}

/**
 * RAR: list headers, then decompress only the first image entry.
 *
 * Uses createExtractorFromData, NOT createExtractorFromFile. The file-based
 * extractor writes to a target directory on disk and leaves `.extraction`
 * empty — every cover came back "produced no data" until this was switched.
 * Do not "optimise" it back to the file variant to avoid reading the archive
 * bytes; that variant cannot return data in memory at all.
 *
 * Reading the whole archive is acceptable here: the read is sequential and the
 * expensive part (decompressing 40+ pages) is what we're skipping. Measured at
 * ~9 ms median per cover on the real library, versus ~143 ms for a full extract.
 */
async function firstImageFromRar(fullPath: string): Promise<{ data: Buffer; name: string }> {
  const { createExtractorFromData } = await import('node-unrar-js');
  const archiveBuffer = await fs.promises.readFile(nsp(fullPath));
  // node-unrar-js wants an ArrayBuffer, and Node Buffers can be views into a
  // shared pool — copy so the extractor never sees unrelated bytes.
  const toArrayBuffer = () => {
    const ab = new ArrayBuffer(archiveBuffer.byteLength);
    new Uint8Array(ab).set(archiveBuffer);
    return ab;
  };

  const lister = await createExtractorFromData({ data: toArrayBuffer() });
  const names = [...lister.getFileList().fileHeaders]
    .filter((h: any) => !h.flags.directory)
    .map((h: any) => h.name as string);
  const sorted = sortImageNames(names);
  if (sorted.length === 0) throw new Error('No images in archive');

  const extractor = await createExtractorFromData({ data: toArrayBuffer() });
  const result = extractor.extract({ files: [sorted[0]] });
  const files = [...result.files];
  const first = files[0];
  if (!first?.extraction) throw new Error('RAR extraction produced no data');
  return { data: Buffer.from(first.extraction), name: sorted[0] };
}

/**
 * 7z: <1% of the library. Lists via 7za, then extracts the single first image
 * into a short staging dir (short to keep MAX_PATH headroom, same reasoning as
 * cbz-extractor's disk fallback).
 */
async function firstImageFrom7z(fullPath: string): Promise<{ data: Buffer; name: string }> {
  const listing = await new Promise<string>((resolve, reject) => {
    execFile(sevenBin.path7za, ['l', '-slt', fullPath], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.trim() || err.message));
        resolve(stdout);
      });
  });
  const names = listing.split(/\r?\n/)
    .filter(l => l.startsWith('Path = '))
    .map(l => l.slice('Path = '.length).trim());
  const sorted = sortImageNames(names);
  if (sorted.length === 0) throw new Error('No images in archive');

  const stagingDir = path.join(os.tmpdir(), `cbzthumb-${Date.now().toString(36)}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(sevenBin.path7za, ['x', fullPath, `-o${stagingDir}`, sorted[0], '-y'],
        { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (err) return reject(new Error(stderr?.trim() || err.message));
          resolve();
        });
    });
    const extracted = path.join(stagingDir, sorted[0]);
    const data = fs.readFileSync(nsp(extracted));
    return { data, name: sorted[0] };
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  }
}

async function readCoverBytes(fullPath: string): Promise<{ data: Buffer; name: string }> {
  const format = detectFormat(readMagic(fullPath));
  const attempts: Array<() => Promise<{ data: Buffer; name: string }>> = [];
  if (format === 'rar') attempts.push(() => firstImageFromRar(fullPath));
  else if (format === 'zip') attempts.push(() => firstImageFromZip(fullPath));
  else if (format === '7z') attempts.push(() => firstImageFrom7z(fullPath));
  else {
    // Unknown magic — try each, cheapest first.
    attempts.push(() => firstImageFromZip(fullPath));
    attempts.push(() => firstImageFromRar(fullPath));
    attempts.push(() => firstImageFrom7z(fullPath));
  }
  const errors: string[] = [];
  for (const attempt of attempts) {
    try { return await attempt(); } catch (err: any) { errors.push(err?.message ?? String(err)); }
  }
  throw new Error(errors.join(' | ') || 'No extractor succeeded');
}

function mimeForName(name: string): string {
  switch (path.extname(name).toLowerCase()) {
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.bmp': return 'image/bmp';
    case '.avif': return 'image/avif';
    default: return 'image/jpeg';
  }
}

/**
 * Shrink to a cache-sized JPEG. nativeImage handles jpg/png/gif/bmp; for webp
 * and avif it returns an empty image, and we hand the bytes to the renderer,
 * whose Chromium decoder handles them. That round-trip happens once per file —
 * afterwards the cached JPEG is indistinguishable from any other.
 */
async function downscaleToJpeg(data: Buffer, sourceName: string): Promise<Buffer> {
  const img = nativeImage.createFromBuffer(data);
  if (!img.isEmpty()) {
    const { width, height } = img.getSize();
    const longest = Math.max(width, height);
    const resized = longest > THUMB_MAX_EDGE
      ? img.resize(width >= height
          ? { width: THUMB_MAX_EDGE, quality: 'good' }
          : { height: THUMB_MAX_EDGE, quality: 'good' })
      : img;
    return resized.toJPEG(THUMB_JPEG_QUALITY);
  }

  if (!convertViaRenderer) {
    throw new Error(`Cannot decode ${path.extname(sourceName) || 'image'} in main and no renderer converter is registered`);
  }
  const converted = await convertViaRenderer(data, mimeForName(sourceName));
  if (!converted || converted.length === 0) {
    throw new Error(`Renderer could not decode ${path.extname(sourceName) || 'image'} cover`);
  }
  return converted;
}

async function produceThumb(fullPath: string): Promise<ThumbResult> {
  const key = cacheKeyFor(fullPath);
  if (!key) return { status: 'failed', reason: 'File is unreadable' };

  const dest = cachePathFor(key);
  if (fs.existsSync(nsp(dest))) {
    touch(dest);
    return { status: 'ready', url: urlForKey(key) };
  }

  const { data, name } = await readCoverBytes(fullPath);
  const jpeg = await downscaleToJpeg(data, name);
  ensureCacheDir();
  fs.writeFileSync(nsp(dest), jpeg);
  scheduleEviction();
  return { status: 'ready', url: urlForKey(key) };
}

/** LRU bookkeeping: "last used" is the thumb file's mtime, touched on every hit. */
function touch(file: string): void {
  const now = new Date();
  try { fs.utimesSync(nsp(file), now, now); } catch {}
}

let evictionScheduled = false;
function scheduleEviction(): void {
  if (evictionScheduled) return;
  evictionScheduled = true;
  setTimeout(() => { evictionScheduled = false; void evictIfOverCap(); }, 5000);
}

export async function evictIfOverCap(): Promise<void> {
  const dir = getCacheDir();
  let entries: Array<{ file: string; size: number; mtime: number }> = [];
  try {
    entries = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jpg'))
      .map(f => {
        const full = path.join(dir, f);
        const st = fs.statSync(nsp(full));
        return { file: full, size: st.size, mtime: st.mtimeMs };
      });
  } catch { return; }

  let total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total <= CACHE_CAP_BYTES) return;

  entries.sort((a, b) => a.mtime - b.mtime); // oldest touched first
  for (const entry of entries) {
    if (total <= CACHE_CAP_BYTES) break;
    try { fs.unlinkSync(nsp(entry.file)); total -= entry.size; } catch {}
  }
}

export function getCacheStats(): { fileCount: number; totalBytes: number } {
  try {
    const dir = getCacheDir();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jpg'));
    let totalBytes = 0;
    for (const f of files) {
      try { totalBytes += fs.statSync(nsp(path.join(dir, f))).size; } catch {}
    }
    return { fileCount: files.length, totalBytes };
  } catch {
    return { fileCount: 0, totalBytes: 0 };
  }
}

export function clearCache(): void {
  const dir = getCacheDir();
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.jpg')) { try { fs.unlinkSync(nsp(path.join(dir, f))); } catch {} }
    }
  } catch {}
  failedPaths.clear();
}

function settle(fullPath: string, result: ThumbResult): void {
  const waiters = pending.get(fullPath);
  pending.delete(fullPath);
  if (waiters) for (const w of waiters) w(result);
}

function pump(): void {
  while (activeCount < MAX_CONCURRENT && queue.length > 0) {
    const fullPath = queue.shift()!;
    if (!pending.has(fullPath)) continue; // cancelled while queued
    activeCount++;
    produceThumb(fullPath)
      .then(result => {
        if (result.status === 'failed') failedPaths.add(fullPath);
        settle(fullPath, result);
      })
      .catch((err: any) => {
        failedPaths.add(fullPath);
        settle(fullPath, { status: 'failed', reason: err?.message ?? String(err) });
      })
      .finally(() => { activeCount--; pump(); });
  }
}

/**
 * Returns immediately with a cached URL when one exists, otherwise enqueues and
 * resolves when the extraction lands. Callers that scroll away should call
 * cancel() so queued-but-not-started work is dropped rather than done blind.
 */
export function requestThumb(fullPath: string): Promise<ThumbResult> {
  if (failedPaths.has(fullPath)) {
    return Promise.resolve({ status: 'failed', reason: 'Cover could not be read (cached failure)' });
  }
  const key = cacheKeyFor(fullPath);
  if (key) {
    const dest = cachePathFor(key);
    if (fs.existsSync(nsp(dest))) {
      touch(dest);
      return Promise.resolve({ status: 'ready', url: urlForKey(key) });
    }
  }
  return new Promise<ThumbResult>(resolve => {
    const waiters = pending.get(fullPath);
    if (waiters) { waiters.push(resolve); return; } // already queued/in-flight
    pending.set(fullPath, [resolve]);
    queue.push(fullPath);
    pump();
  });
}

/** Drop a queued (not yet started) extraction. In-flight work is left to finish. */
export function cancelThumb(fullPath: string): void {
  const idx = queue.indexOf(fullPath);
  if (idx >= 0) {
    queue.splice(idx, 1);
    settle(fullPath, { status: 'failed', reason: 'cancelled' });
  }
}

/** Startup housekeeping: make sure the dir exists and trim if it's over cap. */
export function initThumbCache(): void {
  ensureCacheDir();
  void evictIfOverCap();
}
