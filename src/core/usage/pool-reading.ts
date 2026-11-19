/**
 * Measured pool readings — the read path, recovered from the pending
 * #6976. A recorded `queue/<pool>-reading.json` holds one measured usage
 * sample: used percent, capture time, provider reset time and a source
 * label. Metadata only: nothing here changes routing, holds or spending
 * authority. An old or expired record stays a stale measurement; staleness
 * is reported, never refreshed, re-measured or turned into a current quota
 * or reset. The write path of #6976 is deliberately absent from this module.
 */
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** Pool names: 1-40 lowercase letters, digits or hyphens, starting with a letter. */
export const POOL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const poolName = z.string().regex(POOL_NAME_PATTERN);

/** One measured sample. */
export interface PoolReading { pct: number; ts: number; reset_at: number; src: string }

/** Per-pool view; `reading` is null when the record is absent or invalid (explicitly unknown, not zero). */
export interface PoolReadingView { pool: string; reading: PoolReading | null; ageSeconds: number | null; stale: boolean; error?: string }

/** A record this old (by its recorded capture time) is stale. */
export const POOL_READING_STALE_SECONDS = 8 * 3600;

const directory = (root?: string) => join(root ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'queue');
const fileName = (pool: string) => `${poolName.parse(pool)}-reading.json`;

/** Open without following links; cap reads even if the named file grows. */
export async function showPoolReadings(pool?: string, root?: string): Promise<{ readings: PoolReadingView[]; staleAfterSeconds: number }> {
  const dir = directory(root), now = Date.now() / 1000;
  const names = pool === undefined ? await readdir(dir).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }) : [fileName(pool)];
  const readings = await Promise.all(names.filter(name => /^[a-z][a-z0-9-]{0,39}-reading\.json$/.test(name)).sort().map(async name => {
    const pool = name.slice(0, -'-reading.json'.length);
    try {
      const handle = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let raw: unknown;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size >= 4096) throw new Error('Invalid reading file');
        const buffer = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead >= 4096) throw new Error('Reading too large');
        raw = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      } finally { await handle.close(); }
      const reading = z.object({ pct: z.number().finite().min(0).max(100), ts: z.number().finite().nonnegative().max(now),
        reset_at: z.number().finite().positive(), src: z.string().trim().min(1).max(3000) }).strict().parse(raw);
      const ageSeconds = Math.floor(now - reading.ts);
      return { pool, reading, ageSeconds, stale: now - reading.ts >= POOL_READING_STALE_SECONDS };
    } catch { return { pool, reading: null, ageSeconds: null, stale: true, error: 'Reading missing or invalid' }; }
  }));
  return { readings, staleAfterSeconds: POOL_READING_STALE_SECONDS };
}
