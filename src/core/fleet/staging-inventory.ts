import { execFile, execFileSync } from 'node:child_process';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

export const MAX_CHILDREN = 200;
export const DU_TIMEOUT_MS = 30_000;
export const DU_MAX_BUFFER = 16_384;
/** Default total wall-time budget for one inventory, listing included. */
export const DEFAULT_MAX_DURATION_MS = 120_000;
export const MAX_DURATION_MS_LIMIT = 3_600_000;
export const ELIGIBILITY = 'Age and size do not establish cleanup eligibility.';
export type IncompleteReason = 'listing-degraded' | 'truncated' | 'budget-exhausted' | 'measurement-failed';
type Child = { name: string; modifiedAt: string };
type Listing = { state: 'ok' | 'missing' | 'degraded'; children: Child[]; skippedSymlinks: number; truncated: boolean };
export type Entry = Child & { bytes: number | null; measurement: 'measured' | 'failed' | 'not-attempted' };
export interface InventoryDeps {
  now?: number;
  /** Monotonic milliseconds that drive the scan budget. Defaults to performance.now(). */
  clock?: () => number;
  list?: (root: string) => Promise<Listing>;
  /** The du runner. Receives a timeout already capped to the budget that remains. */
  measure?: (path: string, timeoutMs: number) => Promise<number> | number;
}
export interface InventoryOptions { maxDurationMs?: number }

export function isValidMaxDurationMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_DURATION_MS_LIMIT;
}

export async function listStaging(root: string): Promise<Listing> {
  const result: Listing = { state: 'ok', children: [], skippedSymlinks: 0, truncated: false };
  try {
    const stat = await lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { ...result, state: 'degraded' };
    const dir = await opendir(root);
    let count = 0;
    try {
      for await (const entry of dir) {
        if (++count > MAX_CHILDREN) { result.truncated = true; break; }
        try {
          const child = await lstat(join(root, entry.name));
          if (child.isSymbolicLink()) result.skippedSymlinks++;
          else if (child.isDirectory()) result.children.push({ name: entry.name, modifiedAt: child.mtime.toISOString() });
        } catch { result.state = 'degraded'; }
      }
    } catch { result.state = 'degraded'; }
  } catch (error) {
    result.state = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded';
  }
  return result;
}

/**
 * Synchronous du. `timeoutMs` bounds the child process: execFileSync kills it
 * once the timeout elapses. A call cannot be cancelled after it returns, so the
 * budget is enforced by capping each timeout to what remains before the call.
 */
export function measureStaging(path: string, timeoutMs: number = DU_TIMEOUT_MS): number {
  const text = execFileSync('du', ['-sk', path], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: DU_MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return parseDuBytes(text);
}

function parseDuBytes(text: string): number {
  const match = /^(\d+)\s/.exec(text);
  const bytes = match ? Number(match[1]) * 1024 : NaN;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid du result');
  return bytes;
}

/** Asynchronous du using execFile, preserving master's async responsiveness. */
export function measureStagingAsync(path: string, timeoutMs: number = DU_TIMEOUT_MS): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = execFile('du', ['-sk', path], {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: DU_MAX_BUFFER,
    }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(parseDuBytes(stdout)); } catch (parseError) { reject(parseError); }
    });
    child.stdin?.end();
    child.stderr?.removeAllListeners('data');
    child.stderr?.resume();
  });
}

export async function inventoryStaging(root: string, deps: InventoryDeps = {}, options: InventoryOptions = {}) {
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  if (!isValidMaxDurationMs(maxDurationMs)) throw new RangeError(`maxDurationMs must be an integer from 1 to ${MAX_DURATION_MS_LIMIT}`);
  // The budget starts before listing so it bounds the whole inventory, not only du.
  const clock = deps.clock ?? (() => performance.now());
  const started = clock();
  const elapsedMs = () => clock() - started;
  let listing: Listing;
  try { listing = await (deps.list ?? listStaging)(root); }
  catch { listing = { state: 'degraded', children: [], skippedSymlinks: 0, truncated: false }; }
  const entries: Entry[] = [];
  let exhausted = false;
  for (const child of listing.children.slice(0, MAX_CHILDREN)) {
    const entry: Entry = { ...child, bytes: null, measurement: 'not-attempted' };
    entries.push(entry);
    if (exhausted) continue;
    try {
      // Recheck immediately before du; du's default physical mode does not follow symlinks.
      if (!deps.list && !(await lstat(join(root, child.name))).isDirectory()) throw new Error('child changed');
      // Computed after the recheck so the timeout reflects the budget actually left. Floored, and
      // below 1 means exhausted: execFileSync treats a timeout of 0 as no timeout at all.
      const timeoutMs = Math.min(DU_TIMEOUT_MS, Math.floor(maxDurationMs - elapsedMs()));
      if (timeoutMs < 1) { exhausted = true; continue; }
      const measured = await (deps.measure ?? measureStagingAsync)(join(root, child.name), timeoutMs);
      if (!Number.isSafeInteger(measured) || measured < 0) throw new Error('invalid measurement');
      entry.bytes = measured;
      entry.measurement = 'measured';
    } catch { entry.measurement = 'failed'; }
  }
  entries.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name));
  const measuredEntries = entries.filter(entry => entry.measurement === 'measured');
  const failed = entries.filter(entry => entry.measurement === 'failed').length;
  const notAttempted = entries.length - measuredEntries.length - failed;
  const truncated = listing.truncated || listing.children.length > MAX_CHILDREN;
  const incompleteReasons: IncompleteReason[] = [];
  if (listing.state === 'degraded') incompleteReasons.push('listing-degraded');
  if (truncated) incompleteReasons.push('truncated');
  if (exhausted) incompleteReasons.push('budget-exhausted');
  if (failed > 0) incompleteReasons.push('measurement-failed');
  const complete = incompleteReasons.length === 0;
  return {
    schema: 'fleet.staging-inventory.v1', generatedAt: new Date(deps.now ?? Date.now()).toISOString(),
    root, source: complete ? listing.state : 'degraded', complete, truncated, incompleteReasons,
    skippedSymlinks: listing.skippedSymlinks, entries,
    // Only measured entries count. Unmeasured bytes are unknown, never zero.
    totalMeasuredBytes: measuredEntries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
    measurements: { measured: measuredEntries.length, unmeasured: failed + notAttempted, failed, notAttempted },
    budget: { maxDurationMs, elapsedMs: elapsedMs(), exhausted },
    cleanupEligibility: ELIGIBILITY,
  };
}
