import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditQueue, run } from '../examples/upgrade/queue-upgrade-audit.js';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const clock = () => Date.parse('2026-10-31T12:00:00Z');
const lane = (held = false) => ({ running: 1, target: 2, queued: 0, held, ceiling: null });
const status = (lanes: Record<string, unknown>) => JSON.stringify({
  last_tick: '2026-10-31T11:59:00Z', paused: false, mem_free_pct: 50, lanes,
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'fake-upgrade-audit-')); dirs.push(dir);
  await mkdir(join(dir, 'queue'));
  await writeFile(join(dir, 'queue/ready.tsv'), [
    'READY\tFAKE-READY-OLD\tremoved-lane\twork\tfake-repo\tprompt=private-fixture',
    'id\tstatus\tpool\ttier\trepo\ttitle',
    'FAKE-READY-HELD\tREADY\tcodex-personal\twork\tfake-repo\tprivate-fixture',
    'PARKED-BYHAND.codex-personal\tFAKE-PARKED\tcodex-local\twork\tfake-repo\tprivate-fixture',
    'FAKE-READY-OK\tREADY\tcodex-local\twork\tfake-repo\tprivate-fixture',
  ].join('\n'));
  await writeFile(join(dir, 'queue/status.json'), status({ 'codex-personal': lane(true), 'codex-local': lane() }));
  return dir;
}
async function execute(dir: string) {
  let output = '';
  const code = await run([], { readQueue: () => readFleetQueue({ runsDir: dir, now: clock }),
    readStatus: () => readFleetRunsDirState({ runsDir: dir, now: clock }), write: text => { output += text; } });
  return { code, output, report: JSON.parse(output) };
}

describe('queue upgrade audit', () => {
  it('joins mixed legacy and header rows, identifying removed and held lanes without exposing ready IDs', async () => {
    const dir = await fixture();
    const { code, output, report } = await execute(dir);
    expect(code).toBe(1);
    expect(report).toMatchObject({ v: 1, verdict: 'mismatch', sources: { queue: { ready: 'healthy', skips: 'missing' }, status: 'healthy' },
      queue: { total: 4, ready: 3, parked: 1, malformed: 0 }, findings: { unknownReady: 1, heldReady: 1, unconfirmedReady: 0 } });
    expect(report.lanes).toEqual([
      { lane: 'codex-local', ready: 1, parked: 0, relation: 'available', running: 1, target: 2, floor: null, ceiling: null, parkedSamples: [] },
      { lane: 'codex-personal', ready: 1, parked: 1, relation: 'held', running: 1, target: 2, floor: null, ceiling: null, parkedSamples: ['FAKE-PARKED'] },
      { lane: 'removed-lane', ready: 1, parked: 0, relation: 'unknown', running: null, target: null, floor: null, ceiling: null, parkedSamples: [] },
    ]);
    expect(output).not.toMatch(/FAKE-READY|private-fixture|fake-repo|prompt|\/tmp/);
  });

  it('verifies a healthy match, even when unrelated sources are missing', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'queue/ready.tsv'), 'READY\tFAKE-READY\tcodex-local\n');
    const { code, report } = await execute(dir);
    expect(code).toBe(0);
    expect(report).toMatchObject({ verdict: 'verified', findings: { unknownReady: 0, heldReady: 0 }, sources: { runs: 'degraded' } });
    expect(report.lanes.find((row: { lane: string }) => row.lane === 'codex-personal')).toMatchObject({ ready: 0, relation: 'held' });
  });

  it('retains partial queue counts and refuses to verify incomplete evidence', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'queue/ready.tsv'), 'READY\tFAKE-READY\tcodex-local\nCLAIMED\tFAKE-BAD\tcodex-local\n');
    const { code, report } = await execute(dir);
    expect(code).toBe(3);
    expect(report).toMatchObject({ verdict: 'insufficient', sources: { queue: { ready: 'degraded' } }, queue: { ready: 1, malformed: 1 } });
    expect(report.lanes.find((row: { lane: string }) => row.lane === 'codex-personal').ready).toBeNull();
  });

  it('does not mistake missing or partial status for removed lanes or zero capacity', async () => {
    const dir = await fixture();
    await rm(join(dir, 'queue/status.json'));
    let result = await execute(dir);
    expect(result.code).toBe(3);
    expect(result.report).toMatchObject({ sources: { status: 'missing' }, findings: { unknownReady: 0, unconfirmedReady: 3 } });
    expect(result.report.lanes.every((row: { relation: string; target: number | null }) => row.relation === 'unconfirmed' && row.target === null)).toBe(true);
    await writeFile(join(dir, 'queue/status.json'), status({ 'codex-local': lane(), 'future-lane': lane() }));
    result = await execute(dir);
    expect(result.code).toBe(3);
    expect(result.report).toMatchObject({ sources: { status: 'degraded' }, findings: { unknownReady: 0, unconfirmedReady: 2 } });
    expect(result.report.lanes.find((row: { lane: string }) => row.lane === 'removed-lane').target).toBeNull();
  });

  it('reports confirmed held work even if another status lane is invalid', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'queue/status.json'), status({ 'codex-personal': lane(true), 'future-lane': lane() }));
    const { code, report } = await execute(dir);
    expect(code).toBe(1);
    expect(report).toMatchObject({ verdict: 'mismatch', sources: { status: 'degraded' }, findings: { heldReady: 1, unknownReady: 0, unconfirmedReady: 2 } });
  });

  it('distinguishes missing queue from empty and bounds lane and sample output', async () => {
    const dir = await fixture();
    await rm(join(dir, 'queue/ready.tsv'));
    const missing = await execute(dir);
    expect(missing.code).toBe(3);
    expect(missing.report.queue).toMatchObject({ total: null, ready: null, parked: null });
    const queue = await readFleetQueue({ runsDir: dir, now: clock });
    const runs = await readFleetRunsDirState({ runsDir: dir, now: clock });
    queue.sources.ready = 'healthy';
    queue.byLane = Array.from({ length: 101 }, (_, i) => ({ lane: `fake-${String(i).padStart(3, '0')}`, ready: 1, parked: 0 }));
    queue.groups = [{ lane: 'fake-000', reason: 'FAKE', count: 20, jobs: Array.from({ length: 20 }, (_, i) => `FAKE-${String(i).padStart(2, '0')}`) }];
    const report = auditQueue(queue, runs);
    expect(report.omittedLanes).toBe(3);
    expect(report.lanes).toHaveLength(100);
    expect(report.findings.unknownReady).toBe(101);
    expect(report.lanes.find(row => row.lane === 'fake-000')?.parkedSamples).toHaveLength(8);
  });

  it('validates arguments and help before reads and hides failures', async () => {
    let output = '', calls = 0;
    const deps = { write: (text: string) => { output += text; }, readQueue: async () => { calls++; throw new Error('private-fixture'); },
      readStatus: async () => { calls++; throw new Error('private-fixture'); } };
    expect(await run(['--help'], deps)).toBe(0);
    expect(output).toContain('Usage:'); expect(calls).toBe(0);
    output = '';
    expect(await run(['--help', '--bad'], deps)).toBe(2);
    expect(JSON.parse(output).error).toContain('invalid arguments'); expect(calls).toBe(0);
    output = '';
    expect(await run([], deps)).toBe(1);
    expect(JSON.parse(output)).toEqual({ v: 1, error: 'unable to audit queue' });
    expect(output).not.toContain('private-fixture');
  });
});
