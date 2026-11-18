import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const poolName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const poolReadingInput = z.object({ pool: poolName, pct: z.number().finite().min(0).max(100),
  reset_at: z.union([z.number().finite(), z.string().trim().min(1)]), source: z.string().trim().min(1).max(3000) }).strict();
export interface PoolReading { pct: number; ts: number; reset_at: number; src: string }
export interface PoolReadingView { pool: string; reading: PoolReading | null; ageSeconds: number | null; stale: boolean; error?: string }
export const POOL_READING_STALE_SECONDS = 8 * 3600;
export const POOL_READING_PATH = '/api/verse/resources/pool/reading';
const directory = (root?: string) => join(root ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'queue');
const fileName = (pool: string) => `${poolName.parse(pool)}-reading.json`;

function epoch(value: string | number): number {
  return typeof value === 'number' ? value : /^\d+(?:\.\d+)?$/.test(value) ? Number(value)
    : z.iso.datetime({ offset: true }).safeParse(value).success ? Date.parse(value) / 1000 : NaN;
}

/** Measured metadata only. Never changes routing, holds, or spending authority. */
export async function setPoolReading(input: unknown, root?: string): Promise<PoolReadingView> {
  const parsed = poolReadingInput.parse(input);
  const ts = Date.now() / 1000, reset_at = epoch(parsed.reset_at);
  if (!Number.isFinite(reset_at) || reset_at <= ts || reset_at > 8.64e12) throw new Error('reset_at must be a future ISO time or Unix seconds');
  if (/\p{Cc}/u.test(parsed.source)) throw new Error('source must be one plain line');
  const reading: PoolReading = { pct: parsed.pct, ts, reset_at, src: parsed.source };
  const body = JSON.stringify(reading) + '\n';
  if (Buffer.byteLength(body) >= 4096) throw new Error('Reading must be under 4096 bytes');
  const dir = directory(root), target = join(dir, fileName(parsed.pool));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await lstat(dir)).isDirectory()) throw new Error('Reading directory must be a regular directory');
  try { if (!(await lstat(target)).isFile()) throw new Error('Reading must be a regular file'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(dir, `.${parsed.pool}-reading-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(body); await handle.sync(); await handle.close();
    await rename(temporary, target);
  } finally { await handle.close(); await unlink(temporary).catch(() => {}); }
  return { pool: parsed.pool, reading, ageSeconds: 0, stale: false };
}

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
