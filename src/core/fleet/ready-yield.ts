import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { flockReady, type TakeReadyLock } from '../queue/order.js';
import { parseReadyRows, readReadyText } from './ready-row-edit.js';
import { familyYieldFromRuns, type FamilyYieldRow } from './family-yield.js';
import { readLedgerLines } from './ledger-lines.js';
import { yieldTally } from './slot-yield.js';
import { supplyFamily } from './supply-floor.js';

export type FamilyStats = Pick<FamilyYieldRow, 'family' | 'launches' | 'merged' | 'prs'>;
function scores(stats: readonly FamilyStats[]) {
  const families = new Map(stats.filter(s => s.launches > 0).map(s => [s.family, s]));
  return (id: string) => {
    const family = supplyFamily(id), hit = families.get(family);
    const urgent = /(?:^|-)(?:FIXUP-(?:MAIN|CI)|INCIDENT)/i.test(id);
    return { urgent, merged: hit ? hit.merged / hit.launches : 0.5, prs: hit ? hit.prs / hit.launches : 0.5,
      reason: `${urgent ? 'urgent; ' : ''}${hit ? `${family} ${hit.merged}/${hit.launches} merged, ${hit.prs}/${hit.launches} PRs` : 'new: prior 0.5'}` };
  };
}
/** Stable, pure launch ordering; unknown families receive a neutral prior on both rates. */
export function orderReadyByYield<T extends { id: string }>(rows: readonly T[], familyStats: readonly FamilyStats[]): T[] {
  const score = scores(familyStats);
  return rows.map(row => ({ row, ...score(row.id) })).sort((a, b) =>
    Number(b.urgent) - Number(a.urgent) || (a.urgent ? 0 : b.merged - a.merged || b.prs - a.prs)).map(r => r.row);
}

/** Read under the dispatcher's lock, keep non-row lines in place, and swap a complete file. */
export async function orderReadyFile(runsDir: string, apply = false, now = Date.now(), deps: { lock?: TakeReadyLock; rename?: typeof rename } = {}) {
  const queue = join(runsDir, 'queue'), path = join(queue, 'ready.tsv');
  const lock = apply ? await (deps.lock ?? flockReady)(queue) : null;
  try {
    if (lock && !lock.quiet) throw new Error('dispatcher tick active; order unchanged');
    const text = await readReadyText(path), tally = yieldTally(now, 24);
    const known = await readLedgerLines(join(runsDir, 'metrics/jobs.jsonl'), line => tally.add(line));
    const report = familyYieldFromRuns(known ? tally.runs().map(r => ({ ...r, job: supplyFamily(r.job) })) : [], now, 24);
    const stats = [...report.families, ...report.single], rows = parseReadyRows(text), ordered = orderReadyByYield(rows, stats);
    const score = scores(stats);
    const moved = ordered.filter((r, i) => r !== rows[i]).length;
    let index = 0;
    const output = text.split('\n').map(line => !line.trim() || line.startsWith('#') ? line : ordered[index++]?.raw).join('\n');
    if (index !== rows.length) throw new Error('too many ready rows; order unchanged');
    if (apply && moved) {
      const temp = `${path}.${randomUUID()}.tmp`;
      const handle = await open(temp, 'wx', 0o600);
      try {
        try { await handle.writeFile(output); await handle.sync(); } finally { await handle.close(); }
        await (deps.rename ?? rename)(temp, path);
      } finally { await unlink(temp).catch(() => {}); }
    }
    const top = ordered[0];
    return { schema: 'jobs.order.v1' as const, known, applied: apply && moved > 0, moved,
      rows: ordered.map(r => ({ id: r.id, yield: score(r.id).merged, reason: score(r.id).reason })),
      line: `order: ${apply ? 'moved' : 'would move'} ${moved} rows, top ${top?.id ?? 'unknown'} yield ${top ? score(top.id).merged.toFixed(2) : 'unknown'}${known ? '' : ' (metrics unknown; prior 0.5)'}` };
  } finally { await lock?.release(); }
}
