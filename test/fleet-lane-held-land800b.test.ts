/**
 * Held lanes in `fleet lanes` (fleet.lanes.v1): a lane whose launches are all written
 * as HELD gets a `held` object; a healthy lane has none. The Leader notice fires once
 * per lane per day at 3 held launches in an hour.
 */
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet-entry.js';
import { formatFleetLanes } from '../src/cli/fleet-lanes.js';
import { getFleetLaneSnapshot } from '../src/core/fleet/lane-console.js';
import { postHeldNotices } from '../src/core/fleet/lane-held-notice.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
let runs: string;
let queueDir: string;

beforeEach(async () => {
  runs = await mkdtemp(join(tmpdir(), 'lane-held-'));
  queueDir = join(runs, 'queue');
  await mkdir(queueDir, { recursive: true });
  await writeFile(join(queueDir, 'ready.tsv'), ['id\tstatus\tpool', 'g1\tREADY\tgrok', 'g2\tREADY\tgrok', 'g3\tREADY\tgrok', 'd1\tREADY\tdevin'].join('\n'));
  // The Grok usage reading is 3 days old; Devin's is fresh.
  await writeFile(join(queueDir, 'usage.jsonl'), [
    JSON.stringify({ pool: 'grok', pctUsed: 40, fetchedAt: new Date(NOW - 3 * 86_400_000).toISOString() }),
    JSON.stringify({ pool: 'devin', pctUsed: 10, fetchedAt: new Date(NOW - 60_000).toISOString() }),
  ].join('\n'));
});
afterEach(async () => { vi.restoreAllMocks(); await rm(runs, { recursive: true, force: true }); });

async function launch(job: string, text: string, minutesAgo: number): Promise<void> {
  await writeFile(join(runs, `${job}.launch`), text);
  const when = new Date(NOW - minutesAgo * 60_000);
  await utimes(join(runs, `${job}.launch`), when, when);
}
const snapshot = () => getFleetLaneSnapshot({ queueDir, budgetsDir: join(runs, 'budgets'), usageLogPaths: [join(queueDir, 'usage.jsonl')], now: () => new Date(NOW) });

describe('held lanes', () => {
  it('shows a held object for a lane with 3 held launches in an hour, and none for a healthy lane', async () => {
    await launch('g1', 'HELD: ultra reading older than 8h\n', 50);
    await launch('g2', 'HELD: ultra reading older than 8h\n', 30);
    await launch('g3', 'HELD: ultra reading older than 8h\n', 5);
    await launch('d1', 'launched claude-code\n', 5);
    const snap = await snapshot();
    expect(snap.schema).toBe('fleet.lanes.v1');
    const grok = snap.lanes.find(l => l.lane === 'grok')!;
    expect(grok.held).toEqual({
      reason: 'usage reading is 3 days old', since: new Date(NOW - 50 * 60_000).toISOString(),
      launches_held_1h: 3, meter_age_h: 72, next_step: 'Refresh the Grok usage reading',
    });
    const devin = snap.lanes.find(l => l.lane === 'devin')!;
    expect(devin.held).toBeUndefined();
    expect('held' in devin).toBe(false);
    expect(formatFleetLanes(snap)).toContain('HELD grok: usage reading is 3 days old · 3 held in the last hour');
    expect(formatFleetLanes(snap)).toContain('Next: Refresh the Grok usage reading');
  });

  it('drops the held object once the newest launch goes through', async () => {
    await launch('g1', 'HELD: ultra reading older than 8h\n', 50);
    await launch('g2', 'launched claude-code\n', 5);
    expect((await snapshot()).lanes.find(l => l.lane === 'grok')!.held).toBeUndefined();
  });

  it('posts one Leader notice per lane per day', async () => {
    await launch('g1', 'HELD: ultra reading older than 8h\n', 50);
    await launch('g2', 'HELD: ultra reading older than 8h\n', 30);
    await launch('g3', 'HELD: ultra reading older than 8h\n', 5);
    await launch('d1', 'launched claude-code\n', 5);
    const lanes = new Map((await snapshot()).lanes.flatMap(l => l.held ? [[l.lane, l.held] as const] : []));
    const posted: string[] = [];
    const deps = { stateDir: join(runs, 'leader'), post: (t: string) => { posted.push(t); } };
    expect(await postHeldNotices(lanes, deps, NOW)).toHaveLength(1);
    expect(await postHeldNotices(lanes, deps, NOW + 3_600_000)).toHaveLength(0);
    expect(posted).toEqual(['The grok lane has held 3 launches in the last hour: usage reading is 3 days old. Next step: Refresh the Grok usage reading.']);
    expect(await postHeldNotices(lanes, deps, NOW + 25 * 3_600_000)).toHaveLength(1);
  });

  it('stays quiet below 3 held launches', async () => {
    await launch('g1', 'HELD: ultra reading older than 8h\n', 30);
    await launch('g2', 'HELD: ultra reading older than 8h\n', 5);
    const lanes = new Map((await snapshot()).lanes.flatMap(l => l.held ? [[l.lane, l.held] as const] : []));
    expect(lanes.get('grok')?.launches_held_1h).toBe(2);
    expect(await postHeldNotices(lanes, { stateDir: join(runs, 'leader'), post: () => { throw new Error('should not post'); } }, NOW)).toEqual([]);
  });

  it('reaches the convention verb through the fleet entry and prints hold evidence', async () => {
    const at = new Date();
    await writeFile(join(runs, 'g1.launch'), 'HELD: usage reading is stale\n');
    await utimes(join(runs, 'g1.launch'), at, at);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleet(['lanes', '--queue-dir', queueDir])).toBe(0);
    expect(output.mock.calls.flat().join('\n')).toContain('Next: Refresh the Grok usage reading');
    output.mockClear();
    expect(await cmdFleet(['lanes', '--queue-dir', queueDir, '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]?.[0])).lanes.find((l: { lane: string }) => l.lane === 'grok').held.launches_held_1h).toBe(1);
  });

  it('ignores symlink and oversized launch records and retries a failed notice', async () => {
    await launch('g1', 'HELD: usage reading is stale\n', 50);
    await launch('g2', 'HELD: usage reading is stale\n', 30);
    await launch('g3', 'HELD: usage reading is stale\n', 5);
    await writeFile(join(runs, 'outside'), 'HELD: private details\n');
    await symlink(join(runs, 'outside'), join(runs, 'd1.launch'));
    expect((await snapshot()).lanes.find(l => l.lane === 'devin')?.held).toBeUndefined();
    await rm(join(runs, 'd1.launch'));
    await launch('d1', 'HELD: ' + 'x'.repeat(4096), 5);
    const snap = await snapshot();
    expect(snap.lanes.find(l => l.lane === 'devin')?.held).toBeUndefined();
    const lanes = new Map(snap.lanes.flatMap(l => l.held ? [[l.lane, l.held] as const] : []));
    const deps = { stateDir: join(runs, 'leader'), post: vi.fn(() => { throw new Error('offline'); }) };
    expect(await postHeldNotices(lanes, deps, NOW)).toEqual([]);
    deps.post.mockImplementation(() => {});
    expect(await postHeldNotices(lanes, deps, NOW)).toHaveLength(1);
    expect(await postHeldNotices(lanes, deps, NOW)).toEqual([]);
  });
});
