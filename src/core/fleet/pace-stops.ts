/** Only marker-owned STOP files may be cleared; names cannot escape the chosen directory. */
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FleetPaceV1 } from './pace-verdict.js';
const MARK = 'written-by: phm pools pace\n';
const MARK_BYTES = Buffer.from(MARK);
const plainStop = (stat: BigIntStats) => stat.isFile() && !stat.isSymbolicLink() &&
  stat.nlink === 1n && stat.ino > 0n && stat.size <= 4096n;
const sameInode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const absent = (error: unknown) => ['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '');

async function clearOwnedStop(path: string): Promise<boolean> {
  try {
    // O_NOFOLLOW is not a portable guarantee. Inspect the name without
    // following links, and compare it with the opened descriptor.
    const before = await lstat(path, { bigint: true });
    if (!plainStop(before)) return false;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await file.stat({ bigint: true });
      if (!plainStop(opened) || !sameInode(before, opened)) return false;
      const prefix = Buffer.alloc(MARK_BYTES.length);
      const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
      if (bytesRead !== MARK_BYTES.length || !prefix.equals(MARK_BYTES)) return false;
      const named = await lstat(path, { bigint: true });
      if (!plainStop(named) || !sameInode(opened, named)) return false;
      // Node exposes only a name-based unlink; this recheck is not an atomic
      // compare-and-delete. The STOP directory must not be writable by others.
      await unlink(path);
      return true;
    } finally { await file.close(); }
  } catch (error) {
    if (absent(error)) return false;
    throw error;
  }
}
export async function paceStops(report: FleetPaceV1, dir: string, config: unknown, apply = false) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Loop config must map pools to loop names');
  const seen = new Set<string>();
  const plans = Object.entries(config).flatMap(([pool, loops]) => {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(pool) || !Array.isArray(loops)) throw new Error('Invalid pool or loops');
    return loops.map((loop: unknown) => {
      if (typeof loop !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(loop) || seen.has(loop)) throw new Error('Loop names must be unique plain names');
      seen.add(loop);
      const verdict = report.pools.find(p => p.pool === pool)?.verdict;
      return { pool, loop, action: verdict === 'spent' ? 'stop' : ['ok', 'over', 'free'].includes(verdict ?? '') ? 'clear' : 'keep' };
    });
  });
  for (const plan of plans) {
    if (!apply || plan.action === 'keep') continue;
    const path = join(dir, `STOP-${plan.loop}`);
    if (plan.action === 'stop') {
      await mkdir(dir, { recursive: true });
      try { const file = await open(path, 'wx', 0o600); try { await file.writeFile(`${MARK}${plan.pool} is spent\n`); } finally { await file.close(); } }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; plan.action = 'keep'; }
    } else if (!await clearOwnedStop(path)) plan.action = 'keep';
  }
  return { apply, plans };
}
