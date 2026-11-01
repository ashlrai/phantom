import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRunsHistory, type RunsHistory, type RunsSample } from '../src/core/fleet/runs-history.js';
import { type RunsStallWindows } from '../src/core/fleet/runs-stall-windows.js';
import { createRunsHistoryApi, VERSE_RUNS_HISTORY_PATH } from '../src/core/verse/runs-history-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = Date.parse('2026-11-01T04:08:00.000Z');
const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();
const idle = { lane: 'fake-lane', running: 0, target: 2, queued: 1, held: false };
const sample = (seconds: number, changes: Partial<RunsSample> = {}): RunsSample => ({
  at: at(seconds), lanes: [{ ...idle }], workers: 0, leaders: 0, paused: false, ...changes,
});
const interval = (from: number, to: number, sampleCount: number) => ({
  lane: 'fake-lane', from: at(from), to: at(to), durationMs: (to - from) * 1000, sampleCount,
});
let root: string;
let file: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fake-stall-history-'));
  file = join(root, 'history.jsonl');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function getHistory(rows?: unknown[]) {
  if (rows) await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const readHistory = (hours: number) => readRunsHistory({ file, hours, now: () => NOW });
  const handler = createRunsHistoryApi({ sample: async () => false, readHistory });
  const req = { url: `${VERSE_RUNS_HISTORY_PATH}?hours=1` } as IncomingMessage;
  let status = 0;
  let body = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk: string) { body = chunk; return this; },
  } as unknown as ServerResponse;
  const handled = await handler({ token: 'fake-token', allowDispatch: false } as VerseApiContext,
    req, res, VERSE_RUNS_HISTORY_PATH, 'GET');
  expect(handled).toBe(true);
  expect(status).toBe(200);
  return JSON.parse(body) as RunsHistory & { stallWindows: RunsStallWindows };
}

describe('runs history observed idle intervals', () => {
  it('returns consecutive observations within the requested bounds and preserves the history', async () => {
    const rows = [sample(-3660), sample(-3600), sample(-3540), sample(-3450), sample(1)];
    const history = await getHistory(rows);
    expect(history.samples).toEqual(rows.slice(1, 4));
    expect(history.stallWindows).toEqual({
      sourceState: 'healthy', dropped: 0, maxSampleGapMs: 150_000,
      intervals: [interval(-3600, -3450, 3)],
    });
    expect(history.from).toBe(at(-3600));
    expect(history.to).toBe(at(0));
  });

  it('splits a gap over 150 seconds and does not report a lone sample', async () => {
    const history = await getHistory([sample(-500), sample(-350), sample(-199), sample(-139), sample(0)]);
    expect(history.stallWindows.intervals).toEqual([interval(-500, -350, 2), interval(-199, 0, 3)]);
    expect((await getHistory([sample(-60)])).stallWindows.intervals).toEqual([]);
  });

  it.each([
    ['held', sample(-180, { lanes: [{ ...idle, held: true }] })],
    ['paused', sample(-180, { paused: true })],
    ['unknown pause', sample(-180, { paused: null })],
    ['lane disappearance', sample(-180, { lanes: [] })],
    ['running', sample(-180, { lanes: [{ ...idle, running: 1 }] })],
    ['empty queue', sample(-180, { lanes: [{ ...idle, queued: 0 }] })],
    ['zero target', sample(-180, { lanes: [{ ...idle, target: 0 }] })],
    ['ambiguous duplicate lane', sample(-180, { lanes: [{ ...idle }, { ...idle }] })],
  ])('splits on %s', async (_reason, middle) => {
    const history = await getHistory([sample(-300), sample(-240), middle, sample(-120), sample(-60)]);
    expect(history.stallWindows.intervals).toEqual([interval(-300, -240, 2), interval(-120, -60, 2)]);
  });

  it('does not bridge malformed records whose position is unknown', async () => {
    const history = await getHistory([sample(-180), { at: at(-120), lanes: 'unknown' }, sample(-60)]);
    expect(history.sourceState).toBe('degraded');
    expect(history.stallWindows).toEqual({ sourceState: 'degraded', dropped: 1, maxSampleGapMs: 150_000, intervals: [] });
  });

  it('splits on non-increasing timestamps and handles independent lanes', async () => {
    const other = { ...idle, lane: 'fake-other' };
    const history = await getHistory([
      sample(-240, { lanes: [idle, other] }), sample(-180, { lanes: [idle, other] }),
      sample(-180), sample(-120),
    ]);
    expect(history.stallWindows.intervals).toEqual([
      { ...interval(-240, -180, 2), lane: 'fake-other' }, interval(-240, -180, 2), interval(-180, -120, 2),
    ]);
  });

  it('reports missing history without inventing observations', async () => {
    const history = await getHistory();
    expect(history.samples).toEqual([]);
    expect(history.stallWindows).toEqual({ sourceState: 'missing', dropped: 0, maxSampleGapMs: 150_000, intervals: [] });
  });
});
