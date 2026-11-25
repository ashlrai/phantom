import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readOrderTrace } from '../src/core/fleet/order-trace.js';

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'order-health-'));
  await mkdir(join(root, 'leader'));
  await mkdir(join(root, 'metrics'));
  await writeFile(join(root, 'leader', 'MASON-INBOX.md'), '## 2026-11-12 22:29 ET (Mason, Slack) PRIORITY P0\nFake order\n');
  for (const id of ['RQ-FAKE-EMPTY', 'RQ-FAKE-PUB', 'RQ-FAKE-MERGED']) {
    await writeFile(join(root, `${id}.prompt`), "Serves Mason's Nov 12 22:29 order.");
  }
}
async function read(rows: string[]) {
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), rows.join('\n'));
  return readOrderTrace({ runsDir: root, now: () => 0 });
}
const row = (value: object) => JSON.stringify(value);
const empty = row({ type: 'outcome', job_id: 'RQ-FAKE-EMPTY', empty: true, timestamp: '2026-11-12T22:30:00Z' });
const launch = row({ event: 'launch', job: 'RQ-FAKE-EMPTY' });
const publish = row({ kind: 'published', jobId: 'RQ-FAKE-PUB', prUrl: 'https://example.invalid/pr/2', at: '2026-11-12T22:31:00Z' });
const older = row({ event: 'publish', job: 'RQ-FAKE-PUB', url: 'https://example.invalid/pr/1', ts: '2026-11-12T22:29:00Z' });
const merged = row({ event: 'outcome', job: 'RQ-FAKE-MERGED', state: 'MERGED' });

it('keeps lifecycle and publication evidence healthy in either row order', async () => {
  await fixture();
  const rows = [launch, empty, publish, older, merged];
  const first = await read(rows);
  const reverse = await read([...rows].reverse());
  expect(reverse).toEqual(first);
  expect(first.sources.publishes).toBe('healthy');
  expect(first.orders[0]?.jobs).toEqual(expect.arrayContaining([
    { id: 'RQ-FAKE-EMPTY', lane: null, state: 'queued', url: null, endedEmptyAt: '2026-11-12T22:30:00.000Z' },
    { id: 'RQ-FAKE-PUB', lane: null, state: 'published', url: 'https://example.invalid/pr/2' },
    { id: 'RQ-FAKE-MERGED', lane: null, state: 'merged', url: null },
  ]));
});

it('preserves an empty-only journal and missing journal state', async () => {
  await fixture();
  expect((await readOrderTrace({ runsDir: root })).sources.publishes).toBe('missing');
  const trace = await read([empty]);
  expect(trace.sources.publishes).toBe('healthy');
  expect(trace.orders[0]?.jobs.find(job => job.id === 'RQ-FAKE-EMPTY')?.endedEmptyAt).toBe('2026-11-12T22:30:00.000Z');
});

it.each([
  '{bad json',
  row({ event: 'publish', url: 'https://example.invalid/pr/1', ts: '2026-11-12T22:30:00Z' }),
  row({ event: 'published', job: 'RQ-FAKE-PUB', ts: '2026-11-12T22:30:00Z' }),
  row({ event: 'publish', job: 'RQ-FAKE-PUB', url: 'https://example.invalid/pr/1', ts: 'bad', state: 'MERGED' }),
  row({ event: 'outcome', job: 'RQ-FAKE-EMPTY', empty: true, ts: 'bad' }),
  row({ event: 'unknown', job: 'RQ-FAKE-EMPTY' }),
])('degrades malformed or unknown evidence: %s', async bad => {
  await fixture();
  const trace = await read([publish, bad]);
  expect(trace.sources.publishes).toBe('degraded');
  expect(trace.orders[0]?.jobs.find(job => job.id === 'RQ-FAKE-PUB')?.state).toBe(
    bad.includes('MERGED') ? 'merged' : 'published',
  );
});
