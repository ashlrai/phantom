/** An order whose every job ended EMPTY (outcome row, empty: true, in
 * metrics/jobs.jsonl) reports BLOCKED on those jobs instead of owned work. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { endedEmptyBlocker } from '../src/core/fleet/order-lane-blocker.js';
import { readOrderTrace, type OrderTraceJob } from '../src/core/fleet/order-trace.js';
import { classifyOrder, type TraceOrder } from '../src/core/fleet/order-work-state.js';
import type { LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const GEN = '2026-01-02T03:00:00.000Z';
const NOW = '2026-01-02T03:05:00.000Z';
const EMPTY = '2026-01-02T02:00:00.000Z';
const job = (state: OrderTraceJob['state'], id = 'RQ-FAKE-ONE', extra: Partial<OrderTraceJob> = {}): OrderTraceJob =>
  ({ id, lane: 'fake-lane', state, url: null, ...extra });
const order = (jobs: OrderTraceJob[]): TraceOrder => ({ at: '2026-01-01 10:00', source: 'Fake console', key: 'fake-order', jobs });

describe('endedEmptyBlocker', () => {
  it('blocks a single launched job that ended empty, as of the outcome ts', () => {
    const o = order([job('launched', 'RQ-FAKE-ONE', { endedEmptyAt: EMPTY })]);
    expect(endedEmptyBlocker(o, GEN)).toEqual({ dependency: 'job RQ-FAKE-ONE ended empty', source: 'metrics/jobs.jsonl', at: EMPTY });
    expect(classifyOrder(o, GEN, NOW)).toEqual({ state: 'BLOCKED', asOf: EMPTY, source: 'metrics/jobs.jsonl', missing: [] });
  });

  it('sorts ids, caps at three, and uses the newest ts', () => {
    const later = '2026-01-02T02:30:00.000Z';
    const ids = ['RQ-D', 'RQ-B', 'RQ-A', 'RQ-C', 'RQ-E'];
    const o = order(ids.map((id, i) => job('launched', id, { endedEmptyAt: i === 2 ? later : EMPTY })));
    expect(endedEmptyBlocker(o, GEN)).toEqual({
      dependency: 'job RQ-A ended empty, job RQ-B ended empty, job RQ-C ended empty, +2 more',
      source: 'metrics/jobs.jsonl', at: later,
    });
  });

  it('is not BLOCKED while a sibling is still queued', () => {
    const o = order([job('launched', 'RQ-FAKE-ONE', { endedEmptyAt: EMPTY }), job('queued', 'RQ-FAKE-TWO')]);
    expect(endedEmptyBlocker(o, GEN)).toBeUndefined();
    expect(classifyOrder(o, GEN, NOW).state).toBe('ASSIGNED');
  });

  it('is undefined for a launched sibling without an empty outcome, and for no jobs', () => {
    expect(endedEmptyBlocker(order([job('launched', 'RQ-A', { endedEmptyAt: EMPTY }), job('launched', 'RQ-B')]), GEN)).toBeUndefined();
    expect(endedEmptyBlocker(order([]), GEN)).toBeUndefined();
  });

  it('leaves a merged order VERIFIED', () => {
    const url = 'https://github.com/fake-org/fake-repo/pull/7';
    const o = order([job('merged', 'RQ-A', { url }), job('launched', 'RQ-B', { endedEmptyAt: EMPTY })]);
    expect(endedEmptyBlocker(o, GEN)).toBeUndefined();
    expect(classifyOrder(o, GEN, NOW).state).toBe('VERIFIED');
  });

  it('ignores job ids outside the strict RQ shape', () => {
    for (const id of ['rq-lower', 'RQ-', 'RQ-BAD ID', 'X-FAKE', `RQ-${'A'.repeat(81)}`]) {
      expect(endedEmptyBlocker(order([job('launched', id, { endedEmptyAt: EMPTY })]), GEN)).toBeUndefined();
    }
  });

  it('keeps the held-lane blocker when every job is queued on a held lane', () => {
    const lanes: LaneTargetsV1 = { v: 1, generatedAt: GEN, sourceState: 'healthy', lanes: [{
      lane: 'fake-lane', target: 1, floor: 0, ceiling: 4, held: true, heldReason: null, heldUntil: null,
      pausedFrom: null, lastChange: null, changedBy: null,
    }] };
    const o = order([job('queued', 'RQ-FAKE-ONE', { endedEmptyAt: EMPTY })]);
    expect(classifyOrder(o, GEN, NOW, undefined, lanes)).toMatchObject({ state: 'BLOCKED', source: 'slots.json' });
  });
});

describe('readOrderTrace ended-empty rows', () => {
  let root: string;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  async function fixture(rows: Array<Record<string, unknown>>, launched = true): Promise<void> {
    root = await mkdtemp(join(tmpdir(), 'order-ended-empty-370-'));
    await mkdir(join(root, 'leader'));
    await mkdir(join(root, 'metrics'));
    await writeFile(join(root, 'leader', 'MASON-INBOX.md'), '## 2026-11-12 22:29 ET (Mason, Fake console) PRIORITY P0\nFake order\n');
    await writeFile(join(root, 'RQ-FAKE-ONE.prompt'), "Serves Mason's Nov 12 22:29 order.");
    if (launched) await writeFile(join(root, 'RQ-FAKE-ONE.launch'), 'launched RQ-FAKE-ONE fake-lane pid 123 base fake');
    await writeFile(join(root, 'metrics', 'jobs.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  const outcome = (ts: unknown, extra: Record<string, unknown> = {}) =>
    ({ event: 'outcome', empty: true, job: 'RQ-FAKE-ONE', lane: 'fake-lane', ts, ...extra });
  const read = () => readOrderTrace({ runsDir: root, now: () => Date.parse(NOW) });

  it('end to end: a launched job with an empty outcome row classifies BLOCKED', async () => {
    await fixture([outcome('2026-01-02T01:00:00Z'), outcome('2026-01-02T02:00:00+0000')]);
    const trace = await read();
    const o = trace.orders[0]!;
    expect(o.jobs).toEqual([{ id: 'RQ-FAKE-ONE', lane: 'fake-lane', state: 'launched', url: null, endedEmptyAt: EMPTY }]);
    expect(classifyOrder(o, trace.generatedAt, NOW)).toEqual({ state: 'BLOCKED', asOf: EMPTY, source: 'metrics/jobs.jsonl', missing: [] });
  });

  it('ignores a malformed ts and a non-RQ id', async () => {
    await fixture([outcome('not a time'), outcome(42), outcome(EMPTY, { job: 'other-1' })]);
    const o = (await read()).orders[0]!;
    expect(o.jobs[0]).not.toHaveProperty('endedEmptyAt');
    expect(classifyOrder(o, GEN, NOW).state).toBe('ASSIGNED');
  });

  it('drops endedEmptyAt once the job is published or merged', async () => {
    const url = 'https://github.com/fake-org/fake-repo/pull/9';
    await fixture([outcome(EMPTY), { event: 'publish', job: 'RQ-FAKE-ONE', url, ts: EMPTY }]);
    let o = (await read()).orders[0]!;
    expect(o.jobs[0]).toMatchObject({ state: 'published' });
    expect(o.jobs[0]).not.toHaveProperty('endedEmptyAt');
    await rm(root, { recursive: true, force: true });
    await fixture([outcome(EMPTY), { event: 'merged', job: 'RQ-FAKE-ONE', url, ts: EMPTY }]);
    o = (await read()).orders[0]!;
    expect(o.jobs[0]).toMatchObject({ state: 'merged' });
    expect(o.jobs[0]).not.toHaveProperty('endedEmptyAt');
    expect(classifyOrder(o, GEN, NOW).state).toBe('VERIFIED');
  });
});
