import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readYieldBy } from '../src/core/fleet/yield-by.js';

it('reads source attribution and merge latency without crediting reverted work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleetcoreland760-'));
  try {
    const now = Date.parse('2026-11-22T00:00:00Z');
    const metrics = join(dir, 'jobs.jsonl');
    const queue = join(dir, 'router-queue.md');
    const lines = [
      { event: 'launch', job: 'RQ-PHX-KEPT1', lane: 'fake-host', src: 'leader', ts: new Date(now - 3_600_000).toISOString() },
      { event: 'publish', job: 'RQ-PHX-KEPT1', class: 'pr', url: 'https://example.invalid/pr/1' },
      { jobId: 'RQ-PHX-KEPT1', status: 'MERGED', mergedAt: new Date(now - 1_800_000).toISOString() },
      { event: 'launch', job: 'RQ-PHX-REVERTED1', lane: 'fake-host', ts: new Date(now - 3_600_000).toISOString() },
      { event: 'outcome', job: 'RQ-PHX-REVERTED1', state: 'MERGED', ts: new Date(now - 600_000).toISOString() },
      { event: 'revert', job: 'RQ-PHX-REVERTED1', ts: new Date(now - 300_000).toISOString() },
    ];
    await writeFile(metrics, lines.map(line => JSON.stringify(line)).join('\n'));
    await writeFile(queue, '- READY RQ-PHX-REVERTED1 (P1, pool=work, src=leader): fixture\n');
    const report = await readYieldBy({ by: 'source', metrics, queue, now });
    expect(report.known).toBe(true);
    expect(report.gaps).toEqual([]);
    expect(report.rows).toEqual([{
      name: 'leader', launches: 2, prs: 1, merged: 1, empty: 0, aborted: 0,
      merged_per_launch: 0.5, median_minutes_to_merge: 30,
    }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
