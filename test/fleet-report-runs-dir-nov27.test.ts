import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetApiPools } from '../src/cli/fleet-api-pools.js';
import { cmdFleetDeadHeads } from '../src/cli/fleet-dead-heads.js';
import { cmdFleetIdleLanes } from '../src/cli/fleet-idle-lanes.js';
import { cmdFleetKept } from '../src/cli/fleet-kept.js';
import { cmdFleetLaneIdle } from '../src/cli/fleet-lane-idle.js';
import { cmdFleetLaneShare } from '../src/cli/fleet-lane-share.js';
import { readFleetLeaderHealth } from '../src/cli/fleet-leader-health.js';
import { cmdFleetLoad } from '../src/cli/fleet-load.js';
import { readLoginHealth } from '../src/cli/fleet-login-health.js';
import { cmdFleetQueueCounts } from '../src/cli/fleet-queue-counts.js';
import { cmdFleetShedPlan } from '../src/cli/fleet-shed-plan.js';
import { cmdFleetStarved } from '../src/cli/fleet-starved.js';
import { cmdFleetTrim } from '../src/cli/fleet-trim.js';
import { readFleetVerdict } from '../src/cli/fleet-verdict.js';

const ENV_DIR = join(tmpdir(), 'fleet-runs-dir-env');
const STATUS = JSON.stringify({
  schema: 'dispatchd.status.v1',
  admission: { cap: 4, running: 1, reason: null, admit: true },
  lanes: { devin: { held: false, running: 0, target: 2, queued: 1 } },
});
const underEnv = (path: string) => path === ENV_DIR || path.startsWith(`${ENV_DIR}/`);

let savedEnv: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  savedEnv = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = ENV_DIR;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedEnv === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = savedEnv;
});

function recording(body: string | ((path: string) => string)) {
  const calls: string[] = [];
  const read = async (path: string): Promise<string> => {
    calls.push(path);
    return typeof body === 'function' ? body(path) : body;
  };
  return { calls, read };
}

describe('fleet status readers honor ASHLR_RUNS_DIR', () => {
  it('fleet starved reads queue/status.json under the override', async () => {
    const { calls, read } = recording(STATUS);
    await cmdFleetStarved([], read, async () => ({ lanes: {}, waiting_elsewhere: 0 }));
    expect(calls).toEqual([join(ENV_DIR, 'queue', 'status.json')]);
  });

  it('fleet lane-share reads queue/status.json under the override', async () => {
    const { calls, read } = recording(STATUS);
    await cmdFleetLaneShare([], read);
    expect(calls).toEqual([join(ENV_DIR, 'queue', 'status.json')]);
  });

  it('fleet lane-idle reads queue/status.json under the override', async () => {
    const { calls, read } = recording(STATUS);
    await cmdFleetLaneIdle([], read);
    expect(calls).toEqual([join(ENV_DIR, 'queue', 'status.json')]);
  });

  it('fleet idle-lanes reads status and both job ledgers under the override', async () => {
    const { calls, read } = recording(path => path.endsWith('status.json') ? STATUS : '');
    await cmdFleetIdleLanes([], read);
    expect(calls[0]).toBe(join(ENV_DIR, 'queue', 'status.json'));
    expect(calls).toContain(join(ENV_DIR, 'metrics', 'jobs.jsonl'));
    expect(calls).toContain(join(ENV_DIR, 'queue', 'jobs.jsonl'));
    expect(calls.every(underEnv)).toBe(true);
  });

  it('fleet trim reads queue/status.json under the override', async () => {
    const { calls, read } = recording(STATUS);
    await cmdFleetTrim([], read);
    expect(calls).toEqual([join(ENV_DIR, 'queue', 'status.json')]);
  });

  it('fleet shed-plan reads queue/status.json under the override', async () => {
    const { calls, read } = recording(STATUS);
    await cmdFleetShedPlan([], read);
    expect(calls).toEqual([join(ENV_DIR, 'queue', 'status.json')]);
  });

  it('fleet load reads queue/status.json under the override', async () => {
    const { calls, read } = recording(STATUS);
    await cmdFleetLoad([], { read });
    expect(calls).toEqual([join(ENV_DIR, 'queue', 'status.json')]);
  });

  it('fleet api-pools reads queue/status.json under the override', async () => {
    const { calls, read } = recording(JSON.stringify({ budget: { 'claude-api': { pools: {} } } }));
    await cmdFleetApiPools([], read);
    expect(calls).toEqual([join(ENV_DIR, 'queue', 'status.json')]);
  });

  it('fleet kept reads status.json and jobs.jsonl under the override', async () => {
    const { calls, read } = recording(path => path.endsWith('status.json') ? '{"kept_worktrees":[]}' : '');
    await cmdFleetKept([], read, read);
    expect(calls).toEqual([
      join(ENV_DIR, 'queue', 'status.json'),
      join(ENV_DIR, 'metrics', 'jobs.jsonl'),
    ]);
  });

  it('fleet verdict reads all three evidence files under the override', async () => {
    const { calls, read } = recording(path => path.endsWith('status.json') ? STATUS : '');
    await readFleetVerdict({ read });
    expect(calls).toContain(join(ENV_DIR, 'queue', 'status.json'));
    expect(calls).toContain(join(ENV_DIR, 'queue', 'dispatch-events.log'));
    expect(calls).toContain(join(ENV_DIR, 'metrics', 'jobs.jsonl'));
    expect(calls.every(underEnv)).toBe(true);
  });

  it('fleet leader-health reads dispatch-events.log and the leader dir under the override', async () => {
    const events = recording(() => '2020-01-01 00:00:00 OPUS-LEADER rc=1\n');
    const outputs: string[] = [];
    const health = await readFleetLeaderHealth({
      readEvents: events.read,
      readLatestOutput: async dir => { outputs.push(dir); return null; },
      now: Date.now(),
    });
    expect(events.calls).toEqual([join(ENV_DIR, 'queue', 'dispatch-events.log')]);
    expect(outputs).toEqual([join(ENV_DIR, 'leader')]);
    expect(health.consecutiveFailures).toBe(1);
  });

  it('fleet login-health reads metrics/jobs.jsonl under the override', async () => {
    const { calls, read } = recording('');
    await readLoginHealth(read);
    expect(calls).toEqual([join(ENV_DIR, 'metrics', 'jobs.jsonl')]);
  });
});

describe('fleet queue reports honor ASHLR_RUNS_DIR', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  async function seedRunsDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-env-runs-'));
    dirs.push(dir);
    await mkdir(join(dir, 'queue', 'run'), { recursive: true });
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await writeFile(join(dir, 'queue', 'ready.tsv'),
      'READY\tenv-job-1\tenv-lane\twork\texample/phantom\tFixture\n');
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), '');
    return dir;
  }

  it('fleet queue-counts defaults its root to the override', async () => {
    process.env.ASHLR_RUNS_DIR = await seedRunsDir();
    const printed: string[] = [];
    logSpy.mockImplementation((text: unknown) => { printed.push(String(text)); });
    const code = await cmdFleetQueueCounts(['--json']);
    expect(code).toBe(0);
    const report = JSON.parse(printed.join('\n')) as { lanes: { lane: string }[] };
    expect(report.lanes.map(lane => lane.lane)).toContain('env-lane');
  });

  it('fleet dead-heads defaults its root to the override', async () => {
    process.env.ASHLR_RUNS_DIR = await seedRunsDir();
    const printed: string[] = [];
    logSpy.mockImplementation((text: unknown) => { printed.push(String(text)); });
    const code = await cmdFleetDeadHeads(['--json']);
    expect(code).toBe(0);
    const report = JSON.parse(printed.join('\n')) as { lanes: { lane: string }[] };
    expect(report.lanes.map(lane => lane.lane)).toContain('env-lane');
  });
});
