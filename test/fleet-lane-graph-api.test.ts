/** RQ-PHX-RECUTDESKS0C185: recut of #4706 (merges by lane, Growth section).
 * The pure hourly builder (core/fleet/merge-graph.ts) and GET /api/verse/fleet/control/merge-graph
 * through the fleet-control family and the injected reader. Read-only display code, not a merge gate. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeGraph } from '../src/core/fleet/merge-graph.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';
import { createFleetMergeGraphApi, VERSE_FLEET_MERGE_GRAPH_PATH as PATH } from '../src/core/verse/fleet-merge-graph-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = Date.parse('2026-11-10T06:30:00Z');
const ROWS = [
  { event: 'launch', job: 'x', lane: 'work', ts: '2026-11-09T20:00:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'x', ts: '2026-11-09T23:15:00Z', ttm_s: 300 },
  { event: 'outcome', state: 'MERGED', job: 'y', lane: 'fast', ts: '2026-11-09T23:45:00Z', ttm_s: 30 },
  { event: 'outcome', state: 'FAILED', job: 'z', lane: 'fast', ts: '2026-11-09T23:50:00Z' },
];
const ledger = (extra: string[] = []) => [...extra, ...ROWS.map((row) => JSON.stringify(row))].join('\n');

async function call(api: ApiModule, method = 'GET', path = PATH) {
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url: path, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {} } as VerseApiContext, req, res, path, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}
const serve = (read: () => Promise<string | null>, method = 'GET') => call(createFleetMergeGraphApi({ read, now: () => NOW }), method);
const total = (body: { lanes: { buckets: { merges: number }[] }[] }) =>
  body.lanes.reduce((sum, lane) => sum + lane.buckets.reduce((s, bucket) => s + bucket.merges, 0), 0);

describe('fleet merge graph route (recut of #4706)', () => {
  it('lives under the fleet-control family prefix', () => {
    expect(PATH).toBe('/api/verse/fleet/control/merge-graph');
  });

  it('serves hourly merges by lane, attributing a lane-less merge to its launch lane', async () => {
    const r = await serve(async () => ledger());
    expect(r).toMatchObject({ handled: true, status: 200 });
    expect(r.body).toMatchObject({ schema: 'metrics.merges.v1', known: true, windowHours: 24 });
    expect(r.body.lanes.map((lane: { lane: string }) => lane.lane)).toEqual(['fast', 'work']);
    const hour = (name: string) => r.body.lanes.find((lane: { lane: string }) => lane.lane === name)
      .buckets.find((bucket: { start: string }) => bucket.start === '2026-11-09T23:00:00.000Z');
    expect(hour('work')).toEqual({ start: '2026-11-09T23:00:00.000Z', merges: 1, medianSeconds: 300 });
    expect(hour('fast')).toEqual({ start: '2026-11-09T23:00:00.000Z', merges: 1, medianSeconds: 30 });
  });

  it('ignores malformed lines, non-merge outcomes and future rows', async () => {
    const future = JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'fut', lane: 'work', ts: '2099-01-01T00:00:00Z' });
    const r = await serve(async () => ledger(['not json', '{"event":"outcome"}', '[1]', future]));
    expect(total(r.body)).toBe(2);
  });

  it('reports unknown, not an empty graph, when the ledger is unreadable or the reader throws', async () => {
    expect((await serve(async () => null)).body).toMatchObject({ known: false, lanes: null });
    const thrown = await serve(async () => { throw new Error('EACCES'); });
    expect(thrown).toMatchObject({ handled: true, status: 200, body: { known: false, lanes: null } });
    expect((await serve(async () => '')).body).toMatchObject({ known: true, lanes: [] });
  });

  it('answers 405 to non-GET and ignores other paths', async () => {
    let reads = 0;
    const read = async () => { reads++; return ledger(); };
    expect(await serve(read, 'POST')).toMatchObject({ handled: true, status: 405 });
    expect(await call(createFleetMergeGraphApi({ read }), 'GET', '/api/verse/fleet/control/merge-graphs')).toMatchObject({ handled: false });
    expect(reads).toBe(0);
  });
});

describe('fleet-control family dispatch reads the real jobs ledger', () => {
  let home = '';
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'merge-graph-home-'));
    vi.stubEnv('HOME', home);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('is unknown without a ledger and counts merges from ~/.ashlr-runs/metrics/jobs.jsonl', async () => {
    expect((await call(handleFleetControlApi)).body).toMatchObject({ schema: 'metrics.merges.v1', known: false });
    const at = new Date(Date.now() - 60_000).toISOString();
    await mkdir(join(home, '.ashlr-runs', 'metrics'), { recursive: true });
    await writeFile(join(home, '.ashlr-runs', 'metrics', 'jobs.jsonl'),
      `${JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'fake-job', lane: 'claude', ts: at, ttm_s: 90 })}\n`);
    const r = await call(handleFleetControlApi);
    expect(r).toMatchObject({ handled: true, status: 200, body: { known: true } });
    expect(r.body.lanes).toHaveLength(1);
    expect(r.body.lanes[0].lane).toBe('claude');
    expect(total(r.body)).toBe(1);
  });
});

const PURE_NOW = Date.parse('2026-11-09T12:30:00Z');
const PURE_ROWS = [
  { event: 'launch', job: 'a', lane: 'work', ts: '2026-11-08T09:00:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'a', ts: '2026-11-09T11:05:00Z', ttm_s: 60 },
  { event: 'outcome', state: 'MERGED', job: 'b', lane: 'work', ts: '2026-11-09T11:30:00Z', ttm_s: 180 },
  { event: 'outcome', state: 'MERGED', job: 'b', lane: 'work', ts: '2026-11-09T11:30:00Z', ttm_s: 180 },
  { event: 'outcome', state: 'MERGED', job: 'c', lane: 'fast', ts: '2026-11-09T12:10:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'old', lane: 'work', ts: '2026-11-08T12:59:00Z' },
];
describe('mergeGraph builder (from #4706)', () => {
  it('buckets unique merges by lane and computes medians from known times', () => {
    const report = mergeGraph(PURE_ROWS.map(row => JSON.stringify(row)).join('\n'), PURE_NOW);
    const work = report.lanes!.find(lane => lane.lane === 'work')!;
    expect(work.buckets).toHaveLength(24);
    expect(work.buckets[22]).toMatchObject({ start: '2026-11-09T11:00:00.000Z', merges: 2, medianSeconds: 120 });
    expect(work.buckets[0]).toMatchObject({ merges: 0, medianSeconds: null });
    expect(report.lanes![0]!.buckets[23]).toMatchObject({ merges: 1, medianSeconds: null });
  });
  it('distinguishes an unreadable ledger from an empty one', () => {
    expect(mergeGraph(null, PURE_NOW)).toMatchObject({ known: false, lanes: null });
    expect(mergeGraph('', PURE_NOW)).toMatchObject({ known: true, lanes: [] });
  });
});
