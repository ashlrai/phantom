import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaimedTsv, readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-open-lanes-')); dirs.push(dir);
  await mkdir(join(dir, 'queue'));
  return dir;
}
const row = (running: number, target: number, queued: number) => ({ running, target, queued, held: false });
async function status(dir: string, lanes: Record<string, unknown>) {
  await writeFile(join(dir, 'queue/status.json'), JSON.stringify({ last_tick: '2026-11-04T00:00:00Z', paused: false, mem_free_pct: 50, lanes }));
  return readFleetRunsDirState({ runsDir: dir });
}

it('reads well-formed lanes and ignores the global cap', async () => {
  const s = await status(await fixture(), { devin: row(1, 2, 3), zai: row(2, 3, 4), grok: row(3, 4, 5), cursor: row(4, 5, 6), hard_cap: 20 });
  expect(s.sources.status).toBe('healthy');
  expect(s.lanes.map(({ lane, running, target, queued }) => ({ lane, running, target, queued }))).toEqual([
    { lane: 'devin', running: 1, target: 2, queued: 3 }, { lane: 'zai', running: 2, target: 3, queued: 4 },
    { lane: 'grok', running: 3, target: 4, queued: 5 }, { lane: 'cursor', running: 4, target: 5, queued: 6 },
  ]);
});
it('marks malformed lane keys degraded', async () => {
  const s = await status(await fixture(), { zai: row(1, 2, 3), 'Bad Lane!': row(1, 2, 3), '../x': row(1, 2, 3) });
  expect(s.sources.status).toBe('degraded');
  expect(s.lanes.map(lane => lane.lane)).toEqual(['zai']);
});
it('validates claimed lane IDs', () => {
  expect(parseClaimedTsv('RQ-FAKE-1\tgrok\twork\t00:00\t1\nRQ-FAKE-2\tUPPER\twork\t00:00\t1'))
    .toEqual([{ job: 'RQ-FAKE-1', lane: 'grok', tier: 'work', at: '1970-01-01T00:00:01.000Z' }]);
});
it('finds pending drops for open lanes', async () => {
  const dir = await fixture();
  await mkdir(join(dir, 'leader/drop/zai'), { recursive: true });
  await mkdir(join(dir, 'leader/drop/done'));
  await writeFile(join(dir, 'leader/drop/zai/RQ-PHX-X.md'), 'fake');
  const s = await readFleetRunsDirState({ runsDir: dir });
  expect(s.sources.drop).toBe('healthy');
  expect(s.drop.pending).toEqual([{ lane: 'zai', file: 'RQ-PHX-X.md' }]);
});
it('reads metrics for open lanes and rejects invalid lane IDs', async () => {
  const dir = await fixture();
  await mkdir(join(dir, 'metrics'));
  await writeFile(join(dir, 'metrics/jobs.jsonl'), [
    JSON.stringify({ event: 'finish', job: 'RQ-FAKE-1', lane: 'grok', tokens_total: 42, ts: '2026-11-04T00:00:00Z' }),
    JSON.stringify({ event: 'finish', job: 'RQ-FAKE-2', lane: 'UPPER', tokens_total: 7, ts: '2026-11-04T00:00:00Z' }),
  ].join('\n'));
  const s = await status(dir, { grok: row(1, 2, 3) });
  // Use a fixed clock so the fake metrics remain within the one-hour window.
  const measured = await readFleetRunsDirState({ runsDir: dir, now: () => Date.parse('2026-11-04T00:30:00Z') });
  expect(s.sources.status).toBe('healthy');
  expect(measured.sources.metrics).toBe('degraded');
  expect(measured.lanes[0].tokensLastHour).toBe(42);
});
