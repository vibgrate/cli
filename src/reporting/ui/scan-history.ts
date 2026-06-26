import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ── Scan history for ETA estimation ──

/** Timing data for a single completed scan step */
export interface StepTiming {
  id: string;
  durationMs: number;
}

/** A single historical scan record */
export interface ScanRecord {
  /** ISO timestamp of scan */
  timestamp: string;
  /** Total scan wall-clock duration in milliseconds */
  totalDurationMs: number;
  /** File count from tree discovery */
  totalFiles: number;
  /** Directory count from tree discovery */
  totalDirs: number;
  /** Per-step timing breakdown */
  steps: StepTiming[];
}

/** On-disk shape of the history file */
export interface ScanHistoryFile {
  /** Schema version for forward compatibility */
  version: 1;
  /** Most recent scan records (capped at MAX_RECORDS) */
  records: ScanRecord[];
}

const HISTORY_FILENAME = 'scan_history.json';
const MAX_RECORDS = 10;

/**
 * Load scan history from `.vibgrate/scan_history.json`.
 * Returns null if the file doesn't exist or is unreadable.
 */
export async function loadScanHistory(rootDir: string): Promise<ScanHistoryFile | null> {
  const filePath = path.join(rootDir, '.vibgrate', HISTORY_FILENAME);
  try {
    const txt = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(txt) as ScanHistoryFile;
    if (data.version === 1 && Array.isArray(data.records)) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Append a scan record to history and write to disk.
 * Keeps only the last MAX_RECORDS entries.
 */
export async function saveScanHistory(
  rootDir: string,
  record: ScanRecord,
): Promise<void> {
  const dir = path.join(rootDir, '.vibgrate');
  const filePath = path.join(dir, HISTORY_FILENAME);

  let history: ScanHistoryFile;
  const existing = await loadScanHistory(rootDir);
  if (existing) {
    history = existing;
    history.records.push(record);
    // Keep only the most recent records
    if (history.records.length > MAX_RECORDS) {
      history.records = history.records.slice(-MAX_RECORDS);
    }
  } else {
    history = { version: 1, records: [record] };
  }

  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(history, null, 2) + '\n', 'utf8');
  } catch {
    // Non-fatal — history is best-effort
  }
}

/**
 * Estimate total scan duration from historical records.
 *
 * Strategy:
 * 1. If we have records with a similar file count (within 3×), use a
 *    weighted average of their total durations, scaled linearly by
 *    the file-count ratio (more files → proportionally longer).
 * 2. Falls back to the most recent record if no similar ones exist.
 * 3. Returns null if no history is available.
 */
export function estimateTotalDuration(
  history: ScanHistoryFile | null,
  currentFileCount: number,
): number | null {
  if (!history || history.records.length === 0) return null;

  // Find records within a reasonable size range (0.33× to 3× file count)
  const similar = history.records.filter((r) => {
    if (r.totalFiles === 0 || currentFileCount === 0) return false;
    const ratio = currentFileCount / r.totalFiles;
    return ratio >= 0.33 && ratio <= 3;
  });

  if (similar.length > 0) {
    // Weighted average: more recent records weigh more
    let weightedSum = 0;
    let weightTotal = 0;
    for (let i = 0; i < similar.length; i++) {
      const rec = similar[i]!;
      const weight = i + 1; // More recent = higher index in array = higher weight
      const scale = currentFileCount / rec.totalFiles;
      weightedSum += rec.totalDurationMs * scale * weight;
      weightTotal += weight;
    }
    return Math.round(weightedSum / weightTotal);
  }

  // Fallback: scale from most recent record
  const last = history.records[history.records.length - 1]!;
  if (last.totalFiles > 0 && currentFileCount > 0) {
    const scale = currentFileCount / last.totalFiles;
    return Math.round(last.totalDurationMs * scale);
  }

  return last.totalDurationMs;
}

/**
 * Estimate per-step duration from the most recent similar record.
 * Returns a map of stepId → estimated milliseconds.
 */
export function estimateStepDurations(
  history: ScanHistoryFile | null,
  currentFileCount: number,
): Map<string, number> {
  const result = new Map<string, number>();
  if (!history || history.records.length === 0) return result;

  // Find most recent record with step data
  let best: ScanRecord | null = null;
  for (let i = history.records.length - 1; i >= 0; i--) {
    const rec = history.records[i]!;
    if (rec.steps.length > 0) {
      best = rec;
      break;
    }
  }
  if (!best) return result;

  const scale = best.totalFiles > 0 && currentFileCount > 0
    ? currentFileCount / best.totalFiles
    : 1;

  for (const step of best.steps) {
    result.set(step.id, Math.round(step.durationMs * scale));
  }

  return result;
}
