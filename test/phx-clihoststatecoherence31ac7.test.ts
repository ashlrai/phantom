import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRunsRead } from '../src/cli/fleet-runs-read.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';

const guard = vi.hoisted(() => ({ root: '', violations: [] as string[], processes: [] as string[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const path = await import('node:path');
  function check(file: unknown) {
    const name = String(file);
    const rel = path.relative(guard.root, name);
    if (!guard.root || !path.isAbsolute(name) || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      guard.violations.push(name);
      throw new Error('read outside fake runs tree');
    }
  }
  return {
    ...fs,
    lstat: ((file: unknown, ...args: unknown[]) => {
      check(file);
      return (fs.lstat as (...values: unknown[]) => unknown)(file, ...args);
    }) as typeof fs.lstat,
    open: ((file: unknown, ...args: unknown[]) => {
      check(file);
      return (fs.open as (...values: unknown[]) => unknown)(file, ...args);
    }) as typeof fs.open,
    readdir: ((file: unknown, ...args: unknown[]) => {
      check(file);
      return (fs.readdir as (...values: unknown[]) => unknown)(file, ...args);
    }) as typeof fs.readdir,
  };
});
vi.mock('node:child_process', async importOriginal => {
  const child = await importOriginal<typeof import('node:child_process')>();
  const blocked = () => { guard.processes.push('process launch'); throw new Error('process launch forbidden'); };
  return { ...child, spawn: blocked, spawnSync: blocked, exec: blocked, execSync: blocked, execFile: blocked, execFileSync: blocked, fork: blocked };
});

const now = () => Date.parse('2026-10-31T04:00:00Z');
let root = '';
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
  guard.root = '';
});

async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'fake-fleet-coherence-'));
  guard.root = root;
  guard.violations = [];
  guard.processes = [];
  await mkdir(join(root, 'queue'), { recursive: true });
  await mkdir(join(root, 'leader/drop/done'), { recursive: true });
  await mkdir(join(root, 'metrics'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'queue/status.json'), JSON.stringify({
      last_tick: '2026-10-31T03:59:00Z', paused: false, mem_free_pct: 48,
      lanes: {
        'codex-personal': { running: 1, target: 2, queued: 2, held: true, held_reason: 'manual hold' },
        devin: { running: 2, target: 4, queued: 1, held: false },
      },
    })),
    writeFile(join(root, 'queue/claimed.tsv'), [
      'RQ-FAKE-RUN-PERSONAL\tcodex-personal\twork\t03:58\t1793419080',
      'RQ-FAKE-RUN-DEVIN\tdevin\twork\t03:58\t1793419080',
      '',
    ].join('\n')),
    writeFile(join(root, 'queue/ready.tsv'), [
      'READY\tRQ-FAKE-READY-PERSONAL\tcodex-personal\twork\tphantom\tfake task',
      'READY\tRQ-FAKE-READY-DEVIN\tdevin\twork\tphantom\tfake task',
      'PARKED-HOLD.codex-personal\tRQ-FAKE-PARK-PERSONAL\tcodex-personal\twork\tphantom\tfake task',
      'PARKED-BYHAND.devin\tRQ-FAKE-PARK-DEVIN\tdevin\twork\tphantom\tfake task',
      '',
    ].join('\n')),
    writeFile(join(root, 'queue/precheck-skips.tsv'), '2026-10-30 23:45:00\tRQ-FAKE-PARK-PERSONAL\tHOLD\tmanual hold\n'),
    writeFile(join(root, 'queue/claude-lane.state'), 'unknown\n'),
    writeFile(join(root, 'dispatch-events.log'), '2026-10-31 03:59:00 LAUNCH RQ-FAKE-RUN-DEVIN\n'),
    writeFile(join(root, 'metrics/jobs.jsonl'), ''),
  ]);
}

describe('fleet CLI host state coherence', () => {
  it('carries separate lane evidence through real readers and reports missing sources honestly', async () => {
    await fixture();
    expect(isAbsolute(root)).toBe(true);
    expect(relative(tmpdir(), root)).not.toMatch(/^\.\./);
    const deps = {
      runs: () => readFleetRunsDirState({ runsDir: root, now }),
      parked: () => readFleetQueue({ runsDir: root, now }),
      journal: async (): Promise<never> => { throw new Error('unexpected journal read'); },
    };
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
    async function cli(verb: 'runs' | 'parked', args: string[] = []) {
      output.length = 0;
      expect(await cmdFleetRunsRead(verb, args, deps)).toBe(0);
      expect(output).toHaveLength(1);
      return output[0]!;
    }

    const runs = await deps.runs();
    const queue = await deps.parked();
    expect(runs.sources.status).toBe('healthy');
    expect(runs.lanes).toEqual(expect.arrayContaining([
      expect.objectContaining({ lane: 'codex-personal', running: 1, target: 2, queued: 2, held: true, heldReason: 'manual hold' }),
      expect.objectContaining({ lane: 'devin', running: 2, target: 4, queued: 1, held: false }),
    ]));
    expect(runs.claimed.map(({ job, lane }) => ({ job, lane }))).toEqual([
      { job: 'RQ-FAKE-RUN-PERSONAL', lane: 'codex-personal' },
      { job: 'RQ-FAKE-RUN-DEVIN', lane: 'devin' },
    ]);
    expect(queue).toMatchObject({ sources: { ready: 'healthy', skips: 'healthy' }, total: 4, ready: 2, parked: 2, malformed: 0 });
    expect(queue.byLane).toEqual(expect.arrayContaining([
      expect.objectContaining({ lane: 'codex-personal', ready: 1, parked: 1 }),
      expect.objectContaining({ lane: 'devin', ready: 1, parked: 1 }),
    ]));
    expect(queue.groups).toEqual(expect.arrayContaining([
      { reason: 'HOLD', lane: 'codex-personal', count: 1, jobs: ['RQ-FAKE-PARK-PERSONAL'] },
      { reason: 'BYHAND', lane: 'devin', count: 1, jobs: ['RQ-FAKE-PARK-DEVIN'] },
    ]));
    expect(queue.skips[0]).toMatchObject({ job: 'RQ-FAKE-PARK-PERSONAL', code: 'HOLD' });
    expect(JSON.parse(await cli('runs', ['--json']))).toEqual(runs);
    expect(JSON.parse(await cli('parked', ['--json']))).toEqual(queue);
    const humanRuns = await cli('runs');
    expect(humanRuns).toContain('codex-personal: 1/2 running, 2 queued; held: true (manual hold)');
    expect(humanRuns).toContain('devin: 2/4 running, 1 queued; held: false');
    const humanQueue = await cli('parked');
    expect(humanQueue).toContain('codex-personal: 1 ready, 1 parked');
    expect(humanQueue).toContain('devin: 1 ready, 1 parked');
    expect(humanQueue).toContain('HOLD (codex-personal): 1 [RQ-FAKE-PARK-PERSONAL]');
    expect(humanQueue).toContain('BYHAND (devin): 1 [RQ-FAKE-PARK-DEVIN]');

    await rm(join(root, 'queue/status.json'));
    await rm(join(root, 'queue/ready.tsv'));
    const missingRuns = JSON.parse(await cli('runs', ['--json']));
    expect(missingRuns).toMatchObject({ sourceState: 'degraded', sources: { status: 'missing', claimed: 'healthy' }, lastTick: null, paused: null, lanes: [] });
    expect(missingRuns.claimed.map((row: { job: string }) => row.job)).toEqual(['RQ-FAKE-RUN-PERSONAL', 'RQ-FAKE-RUN-DEVIN']);
    const missingQueue = JSON.parse(await cli('parked', ['--json']));
    expect(missingQueue).toMatchObject({ sources: { ready: 'missing', skips: 'healthy' }, byLane: [], groups: [] });
    expect(missingQueue.skips[0].job).toBe('RQ-FAKE-PARK-PERSONAL');
    expect(await cli('runs')).toContain('status=missing');
    expect(await cli('runs')).toContain('paused: unknown');
    expect(await cli('parked')).toContain('ready=missing');
    expect(guard.violations).toEqual([]);
    expect(guard.processes).toEqual([]);
  });
});
