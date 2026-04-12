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
 * Append session stats to a log file in the sort destination folder.
 * Format matches v4.1's [004-CBZ_Sorter_SESSIONLOG].txt
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

  const entry = [
    `[${dateStr}]`,
    `Time: ${startStr} - ${endStr}`,
    `Duration: ${h}:${m}:${s}`,
    `Keep: ${data.stats.kept} | Purged: ${data.stats.purged} | Opened: ${data.stats.opened} | Skipped: ${data.stats.skipped}`,
    `Fix: ${data.stats.fixed} | Translate: ${data.stats.translated} | Inquire: ${data.stats.inquired} | Unreadable: ${data.stats.unreadable}`,
    '',
  ].join('\n');

  try {
    fs.appendFileSync(logPath, entry + '\n', 'utf-8');
  } catch {
    // Best effort — folder might not exist
  }
}
