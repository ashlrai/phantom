import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { readLedgerLines } from './ledger-lines.js';
import { jobFamily, yieldTally } from './slot-yield.js';
import { readSource } from './runs-parked-queue.js';
import { parseStopFile, stoppedBy } from './stop-file.js';
import type { AutofillCandidate } from './autofill-sources.js';
import type { LaneSnapshotView, AutofillTickOptions } from './autofill-run.js';
import { flockReady } from '../queue/order.js';
import { appendGuarded } from '../queue/supersede.js';
import { readyJobs } from './empty-family-apply.js';
import type { AutofillDraft } from './queue-autofill.js';

/** Job suggestions never declare executable planner runners. */
export interface SupplyFloorSlate { v: 1; candidates: never[]; rankedJobs: (AutofillDraft & { lane: string })[] }

/** FINISH recovery jobs vary their area prefix; they share one measured family. */
export const supplyFamily = (id: string) => /FINISH.*S(?:R\d+)?$/.test(id) ? 'FINISH' : jobFamily(id);

export async function readSupplyRank(root: string, now: number) {
  const tally = yieldTally(now, 24);
  const known = await readLedgerLines(join(root, 'metrics/jobs.jsonl'), line => tally.add(line));
  const families = new Map<string, { launches: number; prs: number }>();
  if (known) for (const run of tally.runs()) {
    const name = supplyFamily(run.job), row = families.get(name) ?? { launches: 0, prs: 0 };
    row.launches++; row.prs += run.prs.size; families.set(name, row);
  }
  const stop = await readSource(join(root, 'queue/family-stop.tsv'), 65536, false);
  const retired = await readSource(join(root, 'queue/RETIRED'), 1024 * 1024, false);
  const stops = parseStopFile(stop.text).filter(row => row.until > now / 1000);
  const ids = new Set(retired.text.split(/\s+/));
  return (c: Pick<AutofillCandidate, 'id' | 'family'>): number | null => {
    const row = families.get(supplyFamily(c.id)) ?? families.get(c.family);
    if (stop.state === 'degraded' || retired.state === 'degraded' || ids.has(c.id)
      || stoppedBy(stops, [c.id, c.family]) || (row && row.launches >= 4 && row.prs / row.launches < 0.25)) return null;
    return row ? row.prs / row.launches : -1;
  };
}

/** Refill each live lane to at most eight waiting jobs. No hourly cap can strand a lane. */
export async function runSupplyFloor(o: AutofillTickOptions, view: LaneSnapshotView | null) {
  const { readAutofillOff, runQueueAutofill, LANE_NAME } = await import('./autofill-run.js');
  const pace = await (o.readPace ?? (() => import('./pace-verdict.js').then(m => m.readPaceByPool({ runsDir: o.runsDir, now: o.now }))))();
  const rows: { lane: string; added: number; line: string }[] = [];
  const slate: SupplyFloorSlate = { v: 1, candidates: [], rankedJobs: [] };
  if (!view || await (o.readOff ?? readAutofillOff)(o.runsDir) !== false) return rows;
  const queue = join(o.runsDir, 'queue');
  const lock = o.apply ? await flockReady(queue) : null;
  try {
    const router = await readSource(join(queue, 'router-queue.md'), 2 * 1024 * 1024, false);
    const ready = await readSource(join(queue, 'ready.tsv'), 2 * 1024 * 1024, false);
    if (router.state === 'degraded' || ready.state === 'degraded') return rows;
    let existing = router.text + '\n' + ready.text;
    const pending = readyJobs(router.text).filter(job => !ready.text.split('\n').some(line => line.split('\t')[0] === job.id));
    for (const f of view.lanes) {
      if (!LANE_NAME.test(f.lane) || f.held || f.remainingPct === null || f.remainingPct <= 0 || f.target === null || f.running === null || f.queued === null
        || pace.get(f.lane)?.verdict === 'over' || pace.get(f.lane)?.state === 'ahead') continue;
      const gap = f.target - f.running, min = Math.min(gap, 8), queued = f.queued + pending.filter(job => job.pool === f.lane).length;
      if (queued >= min) continue;
      const result = await (o.fill ?? runQueueAutofill)({ lane: f.lane, counts: { ...f, queued }, min, limit: min - queued, apply: false,
        root: o.root, runsDir: o.runsDir, dir: queue, entries: o.entries, now: o.now(),
        existing: [...existing.matchAll(/\bRQ-[A-Za-z0-9._-]+\b/g)].map(m => ({ id: m[0], scope: '' })) });
      if ('error' in result) continue;
      slate.rankedJobs.push(...result.drafted.map(d => ({ ...d, lane: f.lane })));
      let added = 0; const accepted = new Set<string>();
      if (o.apply) for (const d of result.drafted) {
        if (new RegExp(`\\b${d.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(existing)) continue;
        const text = `${d.prompt} ${d.acceptance}`.replace(/\s+/g, ' ');
        const line = `- READY ${d.id} (P1, pool=${f.lane}, tier=work, repo=${d.repo}, enq=${Math.floor(o.now() / 1000)}): ${text}\n`;
        await appendGuarded(join(queue, 'router-queue.md'), `\n${line}`); existing += line; added++; accepted.add(d.id);
      }
      if (o.apply && result.trace?.length) {
        await mkdir(join(o.runsDir, 'metrics'), { recursive: true });
        await appendGuarded(join(o.runsDir, 'metrics/generation.jsonl'), result.trace.map(d => JSON.stringify({ schema: 'queue.generation-event.v1', ...d,
          ...(d.event === 'drafted' && !accepted.has(d.job) ? { event: 'rejected', reason: 'duplicate' } : {}), ts: new Date(o.now()).toISOString() })).join('\n') + '\n');
      }
      const top = result.drafted[0];
      rows.push({ lane: f.lane, added, line: `supply: ${f.lane} +${added} (gap ${gap}, top family ${top?.family ?? 'unknown'} ${top?.yield === undefined || top.yield < 0 ? 'unknown' : top.yield.toFixed(2)})` });
    }
    slate.rankedJobs = slate.rankedJobs.sort((a, b) => (b.yield ?? -1) - (a.yield ?? -1)).slice(0, 8);
    while (Buffer.byteLength(JSON.stringify(slate)) > 65536) slate.rankedJobs.pop();
    if (o.apply) await writeFile(join(queue, 'planner-candidates.json'), JSON.stringify(slate), { flag: 'wx', mode: 0o600 })
      .catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    return rows;
  } finally { await lock?.release(); }
}
