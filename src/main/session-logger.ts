import fs from 'fs';
import path from 'path';

export interface SessionLogData {
  sortDestination: string;
  startTime: number;
  endTime: number;
  stats: {
    opened: number;
    skipped: number;
    kept: number;
    purged: number;
    fixed: number;
    translated: number;
    inquired: number;
    unreadable: number;
  };
}

/**
 * Write session stats to the log file in the sort destination folder.
 *
 * Format (changed from v4.1's append-to-bottom layout):
 *   - Newest session at the TOP of the file (prepended on each write).
 *   - Each entry shows a prominent "Processed N files" total so the user
 *     can scan at a glance how productive a session was.
 *   - `Processed` = sum of all real sort actions (kept + purged + fixed +
 *     translated + inquired + unreadable). Opened and Skipped are shown
 *     separately as context (files looked at vs decided on).
 *
 * Prepending requires a read-modify-write of the whole file each session.
 * Session logs are small (a few hundred bytes per session) so this stays
 * cheap even after years of use.
 */
export function saveSessionLog(data: SessionLogData): void {
  if (!data.sortDestination) return;

  const logPath = path.join(data.sortDestination, '[004-CBZ_Sorter_SESSIONLOG].txt');
  const start = new Date(data.startTime);
  const end = new Date(data.endTime);
  const durationSec = Math.floor((data.endTime - data.startTime) / 1000);
  const h = String(Math.floor(durationSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((durationSec % 3600) / 60)).padStart(2, '0');
  const s = String(durationSec % 60).padStart(2, '0');

  const dateStr = start.toISOString().split('T')[0];
  const startStr = start.toLocaleTimeString('en-US', { hour12: false });
  const endStr = end.toLocaleTimeString('en-US', { hour12: false });

  const { stats } = data;
  const totalProcessed = stats.kept + stats.purged + stats.fixed +
                         stats.translated + stats.inquired + stats.unreadable;

  // Each stat line: 13-char left-padded label, 5-char right-padded count.
  // Lines up nicely in monospace viewers (Notepad, VS Code, etc.).
  const row = (label: string, value: number) =>
    `  ${(label + ':').padEnd(13)}${String(value).padStart(5)}`;

  const entry = [
    '============================================================',
    `[Session: ${dateStr}  ${startStr} -> ${endStr}  (${h}:${m}:${s})]`,
    `Processed ${totalProcessed} files  (Opened: ${stats.opened}, Skipped: ${stats.skipped})`,
    '',
    row('Keep', stats.kept),
    row('Purge', stats.purged),
    row('To Fix', stats.fixed),
    row('Translate', stats.translated),
    row('Inquire', stats.inquired),
    row('Unreadable', stats.unreadable),
    '============================================================',
    '',
    '',
  ].join('\n');

  try {
    let existing = '';
    try {
      existing = fs.readFileSync(logPath, 'utf-8');
    } catch {
      // File doesn't exist yet — first session for this destination.
    }
    fs.writeFileSync(logPath, entry + existing, 'utf-8');
  } catch {
    // Best effort — folder might not exist or be writable.
  }
}
