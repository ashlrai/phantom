import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { planPlannerPass, runPlannerPass, type SpawnedPlannerProcess, type SpawnLike } from '../src/core/fleet/planner-run.js';

// Fixed local-time clock: Oct 31 18:00. Fixture rows sit before it; the
// advertised account reset sits after it, so `cmp` stays usage-limited.
const now = new Date(2026, 9, 31, 18, 0, 0).getTime();
const PROMPT = 'planner prompt fixture — plain fake text, not a secret\n';
const USAGE_LIMIT_LOG = [
  'planner pass starting',
  "ERROR: You've hit your usage limit. Upgrade to Pro (https://example.invalid/pro) or try again at Nov 4th, 2026 1:41 AM.",
].join('\n');
const LIMITED_EVENTS = [
  '2026-10-31 13:00:00 LEADER fixups=2 bets=3 reaps=0 ignored=0 free_gb=137',
  '2026-10-31 14:14:03 LEADER cmp rc=1',
].join('\n');
const CANDIDATES = [
  { provider: 'cmp', argv: ['cmp-login', 'exec', 'plan'] },
  { provider: 'sol', argv: ['sol-login', 'run', '--json'] },
] as const;

type FakeBehavior = { code?: number; signal?: NodeJS.Signals | null; error?: Error; hang?: boolean };
type SpawnCall = { program: string; args: readonly string[]; options: Parameters<SpawnLike>[2] };

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  stdinText = '';
  killed = false;
  constructor(behavior: FakeBehavior) {
    super();
    this.stdin.on('data', (chunk: Buffer) => { this.stdinText += chunk.toString('utf8'); });
    queueMicrotask(() => {
      if (behavior.error) { this.emit('error', behavior.error); return; }
      if (!behavior.hang) this.emit('close', behavior.code ?? 0, behavior.signal ?? null);
    });
  }
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('close', null, 'SIGKILL'));
    return true;
  }
}

function spawnStub(behavior: FakeBehavior = {}): { spawn: SpawnLike; calls: SpawnCall[]; children: FakeChild[] } {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn: SpawnLike = (program, args, options) => {
    calls.push({ program, args, options });
    const child = new FakeChild(behavior);
    children.push(child);
    return child as unknown as SpawnedPlannerProcess;
  };
  return { spawn, calls, children };
}

/** A runs root whose last pass died on cmp's usage limit. */
async function limitedRunsRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'planner-run-'));
  await mkdir(join(dir, 'queue'), { recursive: true });
  await mkdir(join(dir, 'supervisor'));
  await writeFile(join(dir, 'queue/dispatch-events.log'), `${LIMITED_EVENTS}\n`);
  await writeFile(join(dir, 'supervisor/run.20261031-1414.log'), USAGE_LIMIT_LOG);
  await writeFile(join(dir, 'prompt.md'), PROMPT);
  return dir;
}

const baseOpts = (dir: string, spawn: SpawnLike, extra: Record<string, unknown> = {}) => ({
  runsRoot: dir,
  candidates: CANDIDATES,
  lastProvider: 'cmp',
  promptPath: join(dir, 'prompt.md'),
  now,
  spawn,
  env: { FAKE_LOGIN_HOME: join(dir, 'fake-login-home') },
  ...extra,
});
const lastRow = async (dir: string): Promise<string[]> => (await readFile(join(dir, 'queue/dispatch-events.log'), 'utf8')).trim().split('\n');

describe('planPlannerPass', () => {
  it('files the newest health under lastProvider and picks the next login', async () => {
    const dir = await limitedRunsRoot();
    try {
      const { health, choice } = await planPlannerPass(baseOpts(dir, spawnStub().spawn));
      expect(health).toMatchObject({ status: 'failing', reason: 'usage-limit' });
      expect(choice).toEqual({ ok: true, provider: 'sol', argv: ['sol-login', 'run', '--json'] });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('runPlannerPass', () => {
  it('fails over off the usage-limited login and records the real exit code', async () => {
    const dir = await limitedRunsRoot();
    try {
      const stub = spawnStub({ code: 3 });
      const result = await runPlannerPass(baseOpts(dir, stub.spawn));
      expect(result).toMatchObject({
        v: 1, provider: 'sol', outcome: 'ran', exitCode: 3, nextResetAt: null,
        startedAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString(),
      });
      expect(result.logPath).toBe(join(dir, 'supervisor', `run.${new Date(now).toISOString().replace(/:/g, '-')}.log`));
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]!.program).toBe('sol-login');
      expect(stub.calls[0]!.args).toEqual(['run', '--json']);
      expect(stub.calls[0]!.options.shell).toBe(false);
      expect(stub.calls[0]!.options.env['FAKE_LOGIN_HOME']).toBe(join(dir, 'fake-login-home'));
      expect((await lastRow(dir)).at(-1)).toBe('2026-10-31 18:00:00 LEADER sol rc=3');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('records LEADER <provider> ok on a clean pass', async () => {
    const dir = await limitedRunsRoot();
    try {
      const result = await runPlannerPass(baseOpts(dir, spawnStub({ code: 0 }).spawn));
      expect(result).toMatchObject({ outcome: 'ran', provider: 'sol', exitCode: 0 });
      expect((await lastRow(dir)).at(-1)).toBe('2026-10-31 18:00:00 LEADER sol ok');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('skips without spawning when ORCH_OFF is set', async () => {
    const dir = await limitedRunsRoot();
    try {
      await writeFile(join(dir, 'ORCH_OFF'), 'set by test\n');
      const stub = spawnStub();
      const result = await runPlannerPass(baseOpts(dir, stub.spawn));
      expect(result).toMatchObject({ outcome: 'skipped-orch-off', provider: null, exitCode: null, logPath: null });
      expect(stub.calls).toHaveLength(0);
      expect(await lastRow(dir)).toHaveLength(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('returns no-runner with nextResetAt when every candidate is limited', async () => {
    const dir = await limitedRunsRoot();
    try {
      const stub = spawnStub();
      const result = await runPlannerPass(baseOpts(dir, stub.spawn, {
        candidates: [{ provider: 'cmp', argv: ['cmp-login', 'a'] }, { provider: 'cmp', argv: ['cmp-login', 'b'] }],
      }));
      expect(result).toMatchObject({ outcome: 'no-runner', provider: null, exitCode: null, nextResetAt: new Date(2026, 10, 4, 1, 41).toISOString() });
      expect(stub.calls).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('returns spawn-failed on a child error and writes no events row', async () => {
    const dir = await limitedRunsRoot();
    try {
      const stub = spawnStub({ error: new Error('spawn sol-login ENOENT bearer FAKEFAKEFAKEFAKEFAKE12345') });
      const result = await runPlannerPass(baseOpts(dir, stub.spawn));
      expect(result).toMatchObject({ outcome: 'spawn-failed', provider: 'sol', exitCode: null });
      expect(await lastRow(dir)).toHaveLength(2);
      const log = await readFile(result.logPath!, 'utf8');
      expect(log).toContain('spawn-failed');
      expect(log).not.toContain('FAKEFAKEFAKEFAKEFAKE12345');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('pipes the prompt file to the child stdin', async () => {
    const dir = await limitedRunsRoot();
    try {
      const stub = spawnStub({ code: 0 });
      await runPlannerPass(baseOpts(dir, stub.spawn));
      expect(stub.children[0]!.stdinText).toBe(PROMPT);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('kills a hung child at timeoutMs and records rc=124', async () => {
    const dir = await limitedRunsRoot();
    try {
      const stub = spawnStub({ hang: true });
      const result = await runPlannerPass(baseOpts(dir, stub.spawn, { timeoutMs: 50 }));
      expect(stub.children[0]!.killed).toBe(true);
      expect(result).toMatchObject({ outcome: 'ran', exitCode: 124 });
      expect((await lastRow(dir)).at(-1)).toBe('2026-10-31 18:00:00 LEADER sol rc=124');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
