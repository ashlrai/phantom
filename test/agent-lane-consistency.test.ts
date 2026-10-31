import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runLaneConsistency } from '../examples/agents/lane-consistency.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { listLiveWorkers } from '../src/core/fleet/runs-live-workers.js';

const clock = () => Date.parse('2026-10-31T12:00:00Z');
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture(lanes: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'lane-consistency-'));
  dirs.push(dir);
  await mkdir(join(dir, 'queue'));
  await writeFile(join(dir, 'queue/status.json'), JSON.stringify({
    last_tick: '2026-10-31T11:59:00Z', paused: false, mem_free_pct: 50, lanes,
  }));
  return dir;
}
const lane = (running: number) => ({ running, target: 3, queued: 0, held: false });

async function run(dir: string, ps: () => Promise<string>, args: string[] = []) {
  let out = '', err = '';
  const code = await runLaneConsistency(['--runs-dir', dir, ...args], {
    now: clock,
    runs: readFleetRunsDirState,
    workers: options => listLiveWorkers({ ...options, runPs: ps }),
    wait: async () => {},
    stdout: text => { out += text; }, stderr: text => { err += text; },
  });
  return { code, out, err, report: out ? JSON.parse(out) : null };
}

describe('lane consistency workflow', () => {
  it('compares counts, retains both one-sided lanes, and never emits command lines', async () => {
    const dir = await fixture({ 'codex-cmp': lane(3), claude: lane(0) });
    const result = await run(dir, async () => [
      '10 00:10 /fake/bin/launch.sh fake-job fake-repo codex-cmp work prompt=private-fixture',
      '11 00:10 /fake/bin/launch.sh fake-other fake-repo custom-lane fast another-private-fixture',
    ].join('\n'));
    expect(result.code).toBe(0);
    expect(result.report.lanes).toEqual([
      { lane: 'claude', reported: 0, workers: 0, delta: 0, consistency: 'matched' },
      { lane: 'codex-cmp', reported: 3, workers: 1, delta: 2, consistency: 'mismatched' },
      { lane: 'custom-lane', reported: null, workers: 1, delta: null, consistency: 'unknown' },
    ]);
    expect(result.report.observation.dispatch.lastTick).toBe('2026-10-31T11:59:00Z');
    expect(result.report.observation.workers.generatedAt).toBe('2026-10-31T12:00:00.000Z');
    expect(result.out).not.toMatch(/private-fixture|launch\.sh|fake-job|fake-repo/);
  });

  it('distinguishes healthy zero workers from unavailable ps', async () => {
    const dir = await fixture({ 'codex-cmp': lane(0) });
    const zero = await run(dir, async () => '');
    const unavailable = await run(dir, async () => { throw new Error('private-fixture'); });
    expect(zero.report.lanes[0]).toMatchObject({ workers: 0, delta: 0, consistency: 'matched' });
    expect(unavailable.report.lanes[0]).toMatchObject({ workers: null, delta: null, consistency: 'unknown' });
    expect(unavailable.report.observation.workers.sourceState).toBe('unavailable');
    expect(unavailable.out).not.toContain('private-fixture');
  });

  it('does not use partial or absent dispatcher status as an authoritative count', async () => {
    const dir = await fixture({ 'codex-cmp': lane(2), claude: { running: 'invalid' } });
    const ps = async () => '10 00:10 /fake/bin/launch.sh fake-job fake-repo codex-cmp work';
    const degraded = await run(dir, ps);
    expect(degraded.report.observation.dispatch.status).toBe('degraded');
    expect(degraded.report.lanes[0]).toMatchObject({ reported: null, workers: 1, consistency: 'unknown' });
    await rm(join(dir, 'queue/status.json'));
    const missing = await run(dir, ps);
    expect(missing.report.observation.dispatch.status).toBe('missing');
    expect(missing.report.lanes[0]).toMatchObject({ reported: null, workers: 1, consistency: 'unknown' });
  });

  it('bounds an oversized dispatcher timestamp', async () => {
    const dir = await fixture({ 'codex-cmp': lane(0) });
    await writeFile(join(dir, 'queue/status.json'), JSON.stringify({
      last_tick: `2026-10-31T11:59:00.${'0'.repeat(1000)}Z`, paused: false, mem_free_pct: 50,
      lanes: { 'codex-cmp': lane(0) },
    }));
    const { report } = await run(dir, async () => '');
    expect(report.observation.dispatch.lastTick).toBeNull();
  });

  it('bounds output and reports omitted lanes', async () => {
    const dir = await fixture({});
    const rows = Array.from({ length: 101 }, (_, i) => `${i + 1} 00:10 /fake/bin/launch.sh job${i} repo lane${i} work`).join('\n');
    const { report } = await run(dir, async () => rows);
    expect(report.lanes).toHaveLength(100);
    expect(report.omittedLanes).toBe(1);
  });

  it('validates options before reading and emits JSON errors without leaking failures', async () => {
    const dir = await fixture({});
    const invalid = await run(dir, async () => { throw new Error('should not read'); }, ['--wait-ms', '5001']);
    expect(invalid.code).toBe(2);
    expect(JSON.parse(invalid.err).error).toBe('invalid arguments');
    let err = '';
    const code = await runLaneConsistency([], { runs: async () => { throw new Error('private-fixture'); },
      workers: async () => { throw new Error('private-fixture'); }, stderr: text => { err += text; } });
    expect(code).toBe(1);
    expect(JSON.parse(err).error).toBe('unable to produce lane consistency report');
    expect(err).not.toContain('private-fixture');
  });

  it('passes bounded wait and abort signal to the injected wait and stops on interruption', async () => {
    const controller = new AbortController();
    let waited = 0, reads = 0, err = '';
    const code = await runLaneConsistency(['--wait-ms', '50'], {
      signal: controller.signal,
      wait: async (ms, signal) => { waited = ms; expect(signal).toBe(controller.signal); controller.abort(); throw new Error('aborted'); },
      runs: async () => { reads++; throw new Error('unexpected'); },
      stderr: text => { err += text; },
    });
    expect({ code, waited, reads }).toEqual({ code: 130, waited: 50, reads: 0 });
    expect(JSON.parse(err).error).toBe('interrupted');
  });
});
