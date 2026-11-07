import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readOrderTrace } from '../src/core/fleet/order-trace.js';
import { narrowOrderTrace, stateWord } from '../src/web-ui/routes/verse/fleet-inbox/order-trace-model.js';

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('promotes merged jobs while preserving publish URLs and healthy evidence', async () => {
  root = await mkdtemp(join(tmpdir(), 'order-trace-merged-'));
  await mkdir(join(root, 'leader'));
  await mkdir(join(root, 'metrics'));
  await writeFile(join(root, 'leader', 'MASON-INBOX.md'),
    '## 2026-11-01 23:31 ET (from Mason, relayed by Masbot)\nDo work\n');
  for (const id of ['RQ-PHX-FAKEA', 'RQ-PHX-FAKEB', 'RQ-PHX-FAKEC']) {
    await writeFile(join(root, `${id}.prompt`), "Serve Mason's Nov 1 23:31 order.");
  }
  await writeFile(join(root, 'RQ-PHX-FAKEA.launch'), 'launched RQ-PHX-FAKEA fake-lane pid 123 base fake');
  const url = 'https://github.com/ashlrai/phantom/pull/1234';
  const publish = { event: 'publish', job: 'RQ-PHX-FAKEA', url, ts: '2026-11-02T04:00:00.000Z' };
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), [
    publish,
    { job: 'RQ-PHX-FAKEA', outcome: 'merged', ts: '2026-11-02T05:00:00.000Z', url: 'https://example.invalid/other' },
    { ...publish, job: 'RQ-PHX-FAKEB' },
    { job_id: 'RQ-PHX-FAKEC', merged_at: '2026-11-02', pr_url: url },
  ].map(row => JSON.stringify(row)).join('\n'));
  const trace = await readOrderTrace({ runsDir: root });
  expect(trace.sources.publishes).toBe('healthy');
  expect(trace.orders[0]?.jobs).toEqual(expect.arrayContaining([
    { id: 'RQ-PHX-FAKEA', lane: 'fake-lane', state: 'merged', url },
    { id: 'RQ-PHX-FAKEB', lane: null, state: 'published', url },
    { id: 'RQ-PHX-FAKEC', lane: null, state: 'merged', url },
  ]));
  const narrowed = narrowOrderTrace(trace);
  expect(narrowed).not.toBeNull();
  const merged = narrowed!.orders[0]!.jobs.find(job => job.id === 'RQ-PHX-FAKEA')!;
  expect(stateWord(merged)).toBe('merged #1234');
  expect(stateWord({ ...merged, url: null })).toBe('merged');
});
