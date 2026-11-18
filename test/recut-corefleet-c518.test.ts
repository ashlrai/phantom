import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

// PR #6323 recovery: prove successive reads reflect repairs on disk, without
// caching health or confusing a damaged metrics source with a damaged status.
let runsDir: string;
const tick = '2026-11-17T10:00:00Z';
const now = () => Date.parse(tick);
const lane = { running: 0, target: 1, queued: 0, held: false, healthy: false };
const status = {
  schema: 'dispatchd.status.v1', last_tick: tick, paused: null,
  mem_free_pct: 50, lanes: { 'test-lane': lane },
};
const read = () => readFleetRunsDirState({ runsDir, now });

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'recut-corefleet-c518-'));
  await mkdir(join(runsDir, 'queue'));
  await writeFile(join(runsDir, 'queue/status.json'), JSON.stringify(status));
});
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

it('drops stale lane measurements after damage and observes a repaired paused snapshot', async () => {
  expect((await read()).lanes[0]).toMatchObject({ healthy: false, running: 0 });
  const path = join(runsDir, 'queue/status.json');
  await writeFile(path, '{damaged');
  const damaged = await read();
  expect(damaged.sources.status).toBe('degraded');
  expect(damaged.lanes).toEqual([]);
  expect(damaged.lastTick).toBeNull();
  expect(damaged.paused).toBeNull();

  const repaired = JSON.stringify({ ...status, paused: 'fixture hold', lanes: {
    hard_cap: 4, 'test-lane': { ...lane, healthy: true, held: true,
      held_reason: 'inspect C:\\fixture\\private.txt' },
  } });
  await writeFile(path, repaired);
  const recovered = await read();
  expect(recovered.sources.status).toBe('healthy');
  expect(recovered.lastTick).toBe(tick);
  expect(recovered.paused).toBe(true);
  expect(recovered.lanes).toHaveLength(1);
  expect(recovered.lanes[0]).toMatchObject({ lane: 'test-lane', healthy: true, held: true });
  expect(recovered.lanes[0]!.heldReason).toBe('inspect [path]');
  expect(await readFile(path, 'utf8')).toBe(repaired);
});

it('keeps status health independent while metrics recover from unknown to measured zero', async () => {
  expect((await read()).lanes[0]!.tokensLastHour).toBeNull();
  await mkdir(join(runsDir, 'metrics'));
  const path = join(runsDir, 'metrics/jobs.jsonl');
  await writeFile(path, '{damaged\n');
  const damaged = await read();
  expect(damaged.sources).toMatchObject({ status: 'healthy', metrics: 'degraded' });
  expect(damaged.lanes[0]!.tokensLastHour).toBeNull();
  await writeFile(path, '');
  const recovered = await read();
  expect(recovered.sources).toMatchObject({ status: 'healthy', metrics: 'healthy' });
  expect(recovered.lanes[0]).toMatchObject({ healthy: false, tokensLastHour: 0 });
  expect(await readFile(path, 'utf8')).toBe('');
});
