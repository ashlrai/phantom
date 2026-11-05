/** runCosWorkOnce — the bounded chief-of-staff worker (RQ-PHX-COSWORKONCE11).
 *
 * Every test roots at a fresh mkdtemp runsDir; the spawn seam is faked, so no
 * real CLI or login ever launches. Candidates are faked as
 * {provider:'fake', argv:['fake-cli']} and never touch planner-candidates.json.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCosWorkOnce } from '../src/core/cos/worker.js';
import { cmdFleetCos } from '../src/cli/fleet-cos.js';
import { cmdFleetCosWork } from '../src/cli/fleet-cos-work.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { queueCosEnvelope } from '../src/core/cos/intake.js';
import type { SpawnedPlannerProcess, SpawnLike } from '../src/core/fleet/planner-run.js';
import { setRunsSwitch } from '../src/core/fleet/runs-switches.js';
import { QueueStore } from '../src/core/queue/store.js';
import type { QueueJob } from '../src/core/queue/schema.js';

let runsDir: string;
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'cos-worker-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(runsDir, { recursive: true, force: true });
});

const candidates = [{ provider: 'fake', argv: ['fake-cli'] }];
const store = () => new QueueStore(join(runsDir, 'queue'), 250);
const jobs = async () => (await store().read()).jobs;

async function enqueueCos(body = 'Prepare a weekly project brief'): Promise<string> {
  return queueCosEnvelope({
    channel: 'cli', verifiedSenderId: 'cos-local', body,
    receivedAt: new Date().toISOString(), dedupeKey: 'a'.repeat(64),
  }, runsDir);
}

interface FakeScript { output?: string; code?: number; hang?: boolean }
/** A SpawnLike that never execs: PassThrough pipes, EventEmitter close/error. */
function fakeRunner(script: FakeScript) {
  let stdinData = '';
  let calls = 0;
  let killSignal: NodeJS.Signals | number | undefined;
  const spawn: SpawnLike = () => {
    calls += 1;
    const events = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.on('data', (chunk) => { stdinData += String(chunk); });
    const proc = {
      stdin, stdout, stderr,
      kill: (signal?: NodeJS.Signals | number) => {
        killSignal = signal;
        setImmediate(() => events.emit('close', null, 'SIGKILL'));
        return true;
      },
      on: (event: string, listener: (...args: never[]) => void) => { events.on(event, listener); return proc; },
      once: (event: string, listener: (...args: never[]) => void) => { events.once(event, listener); return proc; },
    } as unknown as SpawnedPlannerProcess;
    stdin.on('finish', () => {
      if (script.hang) return;
      if (script.output === undefined) {
        setImmediate(() => events.emit('close', script.code ?? 0, null));
      } else {
        stdout.end(script.output);
        stdout.once('end', () => setImmediate(() => events.emit('close', script.code ?? 0, null)));
      }
    });
    return proc;
  };
  return { spawn, stdin: () => stdinData, calls: () => calls, killSignal: () => killSignal };
}

describe('runCosWorkOnce', () => {
  it('returns idle on an empty queue without spawning', async () => {
    const runner = fakeRunner({ output: 'answer' });
    expect(await runCosWorkOnce({ runsDir, spawn: runner.spawn, candidates })).toEqual({ outcome: 'idle' });
    expect(runner.calls()).toBe(0);
  });

  it('returns paused with the PAUSE switch on and leaves the queue unchanged', async () => {
    const id = await enqueueCos();
    await setRunsSwitch('PAUSE', true, { runsDir });
    const before = await jobs();
    const runner = fakeRunner({ output: 'answer' });
    expect(await runCosWorkOnce({ runsDir, spawn: runner.spawn, candidates })).toEqual({ outcome: 'paused' });
    expect(runner.calls()).toBe(0);
    expect(await jobs()).toEqual(before);
    expect((await jobs()).find(job => job.id === id)?.status).toBe('READY');
  });

  it('claims only the cos job, drafts the reply and finishes DONE', async () => {
    const cosId = await enqueueCos('Prepare a weekly project brief');
    const plain: QueueJob = {
      id: 'plain-ready-job', status: 'READY', priority: 'P1', pool: 'work', tier: 'work',
      repo: 'ashlrai/phantom', scope: 'unrelated work', acceptance: '{}', deps: [], claims: [],
    };
    await store().add(plain);
    const runner = fakeRunner({ output: 'Your weekly brief is ready.' });
    const result = await runCosWorkOnce({ runsDir, spawn: runner.spawn, candidates, owner: 'test-worker' });
    expect(result).toEqual({ outcome: 'drafted', id: cosId, provider: 'fake' });
    expect(runner.calls()).toBe(1);
    const prompt = runner.stdin();
    const open = prompt.indexOf('BEGIN UNTRUSTED USER REQUEST');
    const close = prompt.indexOf('END UNTRUSTED USER REQUEST');
    expect(open).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(open);
    expect(prompt.slice(open, close)).toContain('Prepare a weekly project brief');

    const rows = await jobs();
    expect(rows.find(job => job.id === cosId)?.status).toBe('DONE');
    expect(rows.find(job => job.id === 'plain-ready-job')?.status).toBe('READY');
    const draft = JSON.parse(await readFile(join(runsDir, 'cos', `${cosId}.json`), 'utf8'));
    expect(draft.text).toBe('Your weekly brief is ready.');
    expect(draft.origin).toEqual({ channel: 'cli', senderId: 'cos-local' });
    expect(await readFile(join(runsDir, 'NEEDS-MASON.md'), 'utf8'))
      .toContain(`Approve chief-of-staff reply ${cosId}`);
  });

  it('blocks on a non-zero exit, writes no draft and never records stdout', async () => {
    const id = await enqueueCos();
    const runner = fakeRunner({ output: 'partial secret stdout', code: 1 });
    const result = await runCosWorkOnce({ runsDir, spawn: runner.spawn, candidates, owner: 'test-worker' });
    expect(result).toEqual({ outcome: 'blocked', id, reason: 'runner-exit-1' });
    const job = (await jobs()).find(row => row.id === id);
    expect(job?.status).toBe('BLOCKED');
    expect(job?.blockedReason).toBe('runner-exit-1');
    expect(job?.blockedReason).not.toContain('partial secret stdout');
    await expect(readFile(join(runsDir, 'cos', `${id}.json`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('kills a runner that never closes at timeoutMs and blocks', async () => {
    const id = await enqueueCos();
    const runner = fakeRunner({ hang: true });
    const result = await runCosWorkOnce({ runsDir, spawn: runner.spawn, candidates, timeoutMs: 40, owner: 'test-worker' });
    expect(result).toEqual({ outcome: 'blocked', id, reason: 'runner-timeout' });
    expect(runner.killSignal()).toBe('SIGKILL');
    const job = (await jobs()).find(row => row.id === id);
    expect(job?.status).toBe('BLOCKED');
    expect(job?.blockedReason).toBe('runner-timeout');
  });

  it('never lands a secret-shaped string verbatim in a draft', async () => {
    const id = await enqueueCos();
    const secret = `sk-test-${'a'.repeat(24)}`;
    const runner = fakeRunner({ output: `Here is the key you asked about: ${secret} — handle with care.` });
    const result = await runCosWorkOnce({ runsDir, spawn: runner.spawn, candidates, owner: 'test-worker' });
    expect(result.outcome).toBe('drafted');
    const draft = JSON.parse(await readFile(join(runsDir, 'cos', `${id}.json`), 'utf8'));
    expect(draft.text).not.toContain(secret);
    expect(draft.text).toContain('[REDACTED]');
  });

  it('drafts exactly once when two passes race one job', async () => {
    const id = await enqueueCos();
    const runner = fakeRunner({ output: 'The answer is ready.' });
    const opts = { runsDir, spawn: runner.spawn, candidates };
    const [first, second] = await Promise.all([
      runCosWorkOnce({ ...opts, owner: 'worker-a' }),
      runCosWorkOnce({ ...opts, owner: 'worker-b' }),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(['drafted', 'idle']);
    expect(runner.calls()).toBe(1);
    expect((await jobs()).find(row => row.id === id)?.status).toBe('DONE');
  });
});

describe('fleet cos verbs', () => {
  it('fleet cos-work --json prints one JSON line and exits 0 on idle', async () => {
    vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetCosWork(['--json'])).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0] as string)).toEqual({ outcome: 'idle' });
  });

  it('registers both cos and cos-work, and fleet cos --help prints usage', async () => {
    expect(FLEET_SUBCOMMAND_LOADERS).toHaveProperty('cos');
    expect(FLEET_SUBCOMMAND_LOADERS).toHaveProperty('cos-work');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetCos(['--help', '--json'])).toBe(0);
    const parsed = JSON.parse(output.mock.calls.at(-1)![0] as string);
    expect(parsed.usage).toContain('cos ask');
  });
});
