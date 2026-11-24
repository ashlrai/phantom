/** Only marker-owned STOP files may be cleared; names cannot escape the chosen directory. */
import { constants } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FleetPaceV1 } from './pace-verdict.js';
const MARK = 'written-by: phm pools pace\n';
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
    } else {
      let file;
      try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (e) { if (['ENOENT', 'ELOOP'].includes((e as NodeJS.ErrnoException).code ?? '')) { plan.action = 'keep'; continue; } throw e; }
      try { const stat = await file.stat(); if (stat.isFile() && stat.size <= 4096 && (await file.readFile('utf8')).startsWith(MARK)) await unlink(path); else plan.action = 'keep'; }
      finally { await file.close(); }
    }
  }
  return { apply, plans };
}
