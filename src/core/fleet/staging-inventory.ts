import { execFile, execFileSync } from 'node:child_process';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_CHILDREN = 200;
export const DU_TIMEOUT_MS = 30_000;
export const DU_MAX_BUFFER = 16_384;
export const ELIGIBILITY = 'Age and size do not establish cleanup eligibility.';
type Child = { name: string; modifiedAt: string };
type Listing = { state: 'ok' | 'missing' | 'degraded'; children: Child[]; skippedSymlinks: number; truncated: boolean };
export interface InventoryDeps {
  now?: number;
  list?: (root: string) => Promise<Listing>;
  measure?: (path: string) => Promise<number> | number;
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

export function measureStaging(path: string): number {
  const text = execFileSync('du', ['-sk', path], {
    encoding: 'utf8', timeout: DU_TIMEOUT_MS, maxBuffer: DU_MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return parseDuBytes(text);
}

function parseDuBytes(text: string): number {
  const match = /^(\d+)\s/.exec(text);
  const bytes = match ? Number(match[1]) * 1024 : NaN;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid du result');
  return bytes;
}

export function measureStagingAsync(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = execFile('du', ['-sk', path], {
      encoding: 'utf8', timeout: DU_TIMEOUT_MS, maxBuffer: DU_MAX_BUFFER,
    }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(parseDuBytes(stdout)); } catch (parseError) { reject(parseError); }
    });
    child.stdin?.end();
    child.stderr?.removeAllListeners('data');
    child.stderr?.resume();
  });
}

export async function inventoryStaging(root: string, deps: InventoryDeps = {}) {
  let listing: Listing;
  try { listing = await (deps.list ?? listStaging)(root); }
  catch { listing = { state: 'degraded', children: [], skippedSymlinks: 0, truncated: false }; }
  const entries: { name: string; modifiedAt: string; bytes: number | null }[] = [];
  let failed = false;
  for (const child of listing.children.slice(0, MAX_CHILDREN)) {
    let bytes: number | null = null;
    try {
      // Recheck immediately before du; du's default physical mode does not follow symlinks.
      if (!deps.list && !(await lstat(join(root, child.name))).isDirectory()) throw new Error('child changed');
      const measured = await (deps.measure ?? measureStagingAsync)(join(root, child.name));
      if (!Number.isSafeInteger(measured) || measured < 0) throw new Error('invalid measurement');
      bytes = measured;
    } catch { failed = true; }
    entries.push({ ...child, bytes });
  }
  entries.sort ( (a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name));
  const truncated = listing.truncated || listing.children.length > MAX_CHILDREN;
  const complete = listing.state !== 'degraded' && !truncated && !failed;
  return {
    schema: 'fleet.staging-inventory.v1', generatedAt: new Date(deps.now ?? Date.now()).toISOString(),
    root, source: complete ? listing.state : 'degraded', complete, truncated,
    skippedSymlinks: listing.skippedSymlinks, entries,
    totalMeasuredBytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
    cleanupEligibility: ELIGIBILITY,
  };
}
