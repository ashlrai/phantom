import { join } from 'node:path';

import { wikiCloudSliceStats } from '../../cloud/store.js';
import { resolveDropJobRoot } from '../../fleet/drop-job-writer.js';
import { foldLaneRewardAttempts } from '../../fleet/lane-reward.js';
import { parseLedgerTs } from '../../metrics/loop.js';
import { readLedgerTail } from '../../router/outcomes.js';
import { WIKI_JOB_BYTES } from './brain-cloud.js';

export async function wikiSliceStats(root = resolveDropJobRoot()) {
  const cloud = wikiCloudSliceStats();
  const tail = await readLedgerTail(join(root, 'metrics', 'jobs.jsonl'));
  const measurements = new Map<string, { at: number; withSlice: boolean }>();
  const delivery = tail.state === 'read' ? foldLaneRewardAttempts(tail.text).attempts : null;
  if (tail.state === 'read') for (const line of tail.text.split('\n')) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const { event, job } = row;
      if (event !== 'wiki_slice' || typeof job !== 'string') continue;
      const at = parseLedgerTs(row.ts);
      const bytes = (row.wikiSlice as { bytes?: unknown } | undefined)?.bytes;
      if (at !== null && typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= WIKI_JOB_BYTES &&
          at >= (measurements.get(job)?.at ?? -Infinity)) measurements.set(job, { at, withSlice: bytes > 0 });
    } catch { /* partial and malformed ledger rows are not evidence */ }
  }
  const withSlice = { resolved: 0, merged: 0 };
  const withoutSlice = { resolved: 0, merged: 0 };
  for (const [job, receipt] of measurements) {
    const attempt = delivery?.get(job);
    if (!attempt?.outcome || attempt.outcomeTsMs < receipt.at) continue;
    const cohort = receipt.withSlice ? withSlice : withoutSlice;
    cohort.resolved++;
    if (attempt.outcome === 'merged') cohort.merged++;
  }
  const summarize = (cohort: typeof withSlice) => ({
    ...cohort, mergeRate: cohort.resolved ? cohort.merged / cohort.resolved : null,
  });
  return {
    schema: cloud.schema, cloud: { withSlice: cloud.withSlice, withoutSlice: cloud.withoutSlice },
    fleet: { coverage: tail.state, truncated: tail.state === 'read' && tail.truncated,
      withSlice: summarize(withSlice), withoutSlice: summarize(withoutSlice) },
  };
}
