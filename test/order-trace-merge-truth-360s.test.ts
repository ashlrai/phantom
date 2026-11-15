/** Merge-truth regression for readOrderTrace + classifyOrder: a jobs.jsonl
 * row must carry explicit positive merge evidence before an order job reads
 * as merged — and only a merged job with a github pull URL lets
 * classifyOrder report VERIFIED. Negative spellings ('unmerged',
 * 'not_merged', 'merge_failed', 'MERGED_PENDING'), malformed merge
 * timestamps and unrelated event rows must never verify an order, while
 * real producer spellings (outcome/state MERGED, event 'merged', valid
 * merged_at/mergedAt, prUrl/pr_url/pr fallbacks) keep working. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readOrderTrace, type OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import { classifyOrder } from '../src/core/fleet/order-work-state.js';

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const ORDER_A_KEY = '11-12 22:29';
const ORDER_B_KEY = '11-13 13:13';
const PR = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;

interface JobSpec { id: string; order: 'A' | 'B'; launched?: boolean }

async function fixture(jobs: JobSpec[]): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'order-trace-merge-truth-'));
  await mkdir(join(root, 'leader'));
  await mkdir(join(root, 'metrics'));
  await writeFile(join(root, 'leader', 'MASON-INBOX.md'),
    '## 2026-11-12 22:29 ET (Mason, Fake console) PRIORITY P0\nFirst order\n' +
    '## 2026-11-13 13:13 ET (Mason, Fake console) PRIORITY P0\nSecond order\n');
  for (const job of jobs) {
    const citation = job.order === 'A' ? "Serves Mason's Nov 12 22:29 order." : "Serves Mason's Nov 13 13:13 order.";
    await writeFile(join(root, `${job.id}.prompt`), citation);
    if (job.launched !== false) {
      await writeFile(join(root, `${job.id}.launch`), `launched ${job.id} fake-lane pid 123 base fake`);
    }
  }
}

async function writeMetrics(rows: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

function orderOf(trace: OrderTraceV1, key: string) {
  const order = trace.orders.find(o => o.key === key);
  expect(order, `order ${key}`).toBeDefined();
  return order!;
}
function jobOf(trace: OrderTraceV1, key: string, id: string) {
  const job = orderOf(trace, key).jobs.find(j => j.id === id);
  expect(job, `job ${id} on order ${key}`).toBeDefined();
  return job!;
}
function verdict(trace: OrderTraceV1, key: string): string {
  return classifyOrder(orderOf(trace, key), trace.generatedAt, trace.generatedAt).state;
}

it('negative and unrelated metric rows never produce merged or VERIFIED', async () => {
  const jobs: JobSpec[] = [
    { id: 'RQ-PHX-TRUTH-UNMERGED', order: 'A' },
    { id: 'RQ-PHX-TRUTH-NOTMERGED', order: 'A' },
    { id: 'RQ-PHX-TRUTH-MERGEFAIL', order: 'A' },
    { id: 'RQ-PHX-TRUTH-MERGEPEND', order: 'A' },
    { id: 'RQ-PHX-TRUTH-BADMTS', order: 'A' },
    { id: 'RQ-PHX-TRUTH-EVENTS', order: 'A' },
    { id: 'RQ-PHX-TRUTH-PUB', order: 'A' },
    { id: 'RQ-PHX-TRUTH-LAUNCHED', order: 'A' },
  ];
  await fixture(jobs);
  const ts = '2026-11-13T10:00:00.000Z';
  await writeMetrics([
    // Substring lookalikes: none of these is positive merge evidence.
    { event: 'outcome', job: 'RQ-PHX-TRUTH-UNMERGED', state: 'unmerged', url: PR(910011), ts },
    { event: 'outcome', job: 'RQ-PHX-TRUTH-NOTMERGED', outcome: 'not_merged', ts },
    { event: 'outcome', job: 'RQ-PHX-TRUTH-MERGEFAIL', state: 'merge_failed', ts },
    { event: 'outcome', job: 'RQ-PHX-TRUTH-MERGEPEND', state: 'MERGED_PENDING', ts },
    // Merge timestamps that are not valid dates prove nothing.
    { job_id: 'RQ-PHX-TRUTH-BADMTS', merged_at: 'not-a-timestamp', pr_url: PR(910012) },
    { job_id: 'RQ-PHX-TRUTH-BADMTS', mergedAt: '2026-13-40 99:99', pr_url: PR(910012) },
    { job_id: 'RQ-PHX-TRUTH-BADMTS', merged_at: 1720000000, pr_url: PR(910012) },
    // Unrelated lifecycle and chatter rows mentioning merges.
    { event: 'launch', job: 'RQ-PHX-TRUTH-EVENTS', lane: 'fake-lane', ts: '2026-11-13T09:00:00.000Z' },
    { event: 'finish', job: 'RQ-PHX-TRUTH-EVENTS', outcome: 'empty', ts: '2026-11-13T09:30:00.000Z' },
    { event: 'note', job: 'RQ-PHX-TRUTH-EVENTS', detail: 'merge queued behind CI', ts: '2026-11-13T09:45:00.000Z' },
    // Legitimate non-merge states are preserved.
    { event: 'publish', job: 'RQ-PHX-TRUTH-PUB', url: PR(910013), ts: '2026-11-13T09:50:00.000Z' },
  ]);
  const trace = await readOrderTrace({ runsDir: root });
  for (const id of ['RQ-PHX-TRUTH-UNMERGED', 'RQ-PHX-TRUTH-NOTMERGED', 'RQ-PHX-TRUTH-MERGEFAIL',
    'RQ-PHX-TRUTH-MERGEPEND', 'RQ-PHX-TRUTH-BADMTS', 'RQ-PHX-TRUTH-EVENTS']) {
    expect(jobOf(trace, ORDER_A_KEY, id).state).toBe('launched');
  }
  expect(jobOf(trace, ORDER_A_KEY, 'RQ-PHX-TRUTH-PUB')).toEqual(
    { id: 'RQ-PHX-TRUTH-PUB', lane: 'fake-lane', state: 'published', url: PR(910013) });
  expect(jobOf(trace, ORDER_A_KEY, 'RQ-PHX-TRUTH-LAUNCHED').state).toBe('launched');
  expect(verdict(trace, ORDER_A_KEY)).not.toBe('VERIFIED');
  expect(verdict(trace, ORDER_A_KEY)).toBe('ASSIGNED');
});

it('producer merge spellings verify the order, including URL fallbacks', async () => {
  const jobs: JobSpec[] = [
    { id: 'RQ-PHX-TRUTH-V1', order: 'B' },
    { id: 'RQ-PHX-TRUTH-V2', order: 'B' },
    { id: 'RQ-PHX-TRUTH-V3', order: 'B' },
    { id: 'RQ-PHX-TRUTH-V4', order: 'B' },
    { id: 'RQ-PHX-TRUTH-V5', order: 'B' },
  ];
  await fixture(jobs);
  await writeMetrics([
    // dispatchd publish + later outcome row without a url: publish url wins.
    { event: 'publish', job: 'RQ-PHX-TRUTH-V1', url: PR(920011), ts: '2026-11-13T13:20:00.000Z' },
    { event: 'outcome', job: 'RQ-PHX-TRUTH-V1', state: 'MERGED', ts: '2026-11-13T14:00:00.000Z' },
    // metrics-outcomes reconciler row: publish copy carrying outcome MERGED.
    { event: 'publish', job: 'RQ-PHX-TRUTH-V2', url: PR(920012), ts: '2026-11-13T13:25:00.000Z' },
    { event: 'publish', job: 'RQ-PHX-TRUTH-V2', url: PR(920012), ts: '2026-11-13T14:05:00.000Z',
      outcome: 'MERGED', mergedAt: '2026-11-13T14:05:00.000Z',
      reconciledAt: '2026-11-13T14:06:00.000Z', source: 'metrics-outcomes-reconciler' },
    // merged_at timestamp spelling with pr_url.
    { job_id: 'RQ-PHX-TRUTH-V3', merged_at: '2026-11-13', pr_url: PR(920013) },
    // event 'merged' spelling.
    { event: 'merged', job: 'RQ-PHX-TRUTH-V4', url: PR(920014), ts: '2026-11-13T14:10:00.000Z' },
    // outcome row carrying the reconciler's prUrl field.
    { event: 'outcome', job: 'RQ-PHX-TRUTH-V5', outcome: 'MERGED', prUrl: PR(920015),
      mergedAt: '2026-11-13T14:15:00.000Z', ts: '2026-11-13T14:15:00.000Z' },
  ]);
  const trace = await readOrderTrace({ runsDir: root });
  expect(jobOf(trace, ORDER_B_KEY, 'RQ-PHX-TRUTH-V1'))
    .toEqual({ id: 'RQ-PHX-TRUTH-V1', lane: 'fake-lane', state: 'merged', url: PR(920011) });
  expect(jobOf(trace, ORDER_B_KEY, 'RQ-PHX-TRUTH-V2').state).toBe('merged');
  expect(jobOf(trace, ORDER_B_KEY, 'RQ-PHX-TRUTH-V2').url).toBe(PR(920012));
  expect(jobOf(trace, ORDER_B_KEY, 'RQ-PHX-TRUTH-V3'))
    .toEqual({ id: 'RQ-PHX-TRUTH-V3', lane: 'fake-lane', state: 'merged', url: PR(920013) });
  expect(jobOf(trace, ORDER_B_KEY, 'RQ-PHX-TRUTH-V4').state).toBe('merged');
  expect(jobOf(trace, ORDER_B_KEY, 'RQ-PHX-TRUTH-V5'))
    .toEqual({ id: 'RQ-PHX-TRUTH-V5', lane: 'fake-lane', state: 'merged', url: PR(920015) });
  expect(verdict(trace, ORDER_B_KEY)).toBe('VERIFIED');
});

it('a later valid merge row recovers a job on the next read without restart', async () => {
  await fixture([{ id: 'RQ-PHX-TRUTH-RECOVER', order: 'A' }]);
  await writeMetrics([
    { event: 'outcome', job: 'RQ-PHX-TRUTH-RECOVER', state: 'merge_failed', ts: '2026-11-13T10:00:00.000Z' },
  ]);
  let trace = await readOrderTrace({ runsDir: root });
  expect(jobOf(trace, ORDER_A_KEY, 'RQ-PHX-TRUTH-RECOVER').state).toBe('launched');
  expect(verdict(trace, ORDER_A_KEY)).toBe('ASSIGNED');

  await writeMetrics([
    { event: 'outcome', job: 'RQ-PHX-TRUTH-RECOVER', state: 'MERGED', url: PR(930011),
      ts: '2026-11-13T11:00:00.000Z' },
  ]);
  trace = await readOrderTrace({ runsDir: root });
  expect(jobOf(trace, ORDER_A_KEY, 'RQ-PHX-TRUTH-RECOVER'))
    .toEqual({ id: 'RQ-PHX-TRUTH-RECOVER', lane: 'fake-lane', state: 'merged', url: PR(930011) });
  expect(verdict(trace, ORDER_A_KEY)).toBe('VERIFIED');
});
