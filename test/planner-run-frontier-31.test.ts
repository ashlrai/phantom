import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { planPlannerPass, runPlannerPass, type SpawnedPlannerProcess, type SpawnLike } from '../src/core/fleet/planner-run.js';
import { DuplicateTaskIdError } from '../src/core/fleet/task-ready-frontier.js';

// Same fixed clock and usage-limited fixture as fleet-planner-run.test.ts:
// cmp's last pass hit its usage limit, so the plan must still pick sol while
// `ready` answers the task-graph frontier alongside the runner choice.
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

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(code = 0) {
    super();
    queueMicrotask(() => this.emit('close', code, null));
  }
  kill(): boolean {
    queueMicrotask(() => this.emit('close', null, 'SIGKILL'));
    return true;
  }
}

function spawnStub(code = 0): { spawn: SpawnLike; calls: string[] } {
  const calls: string[] = [];
  const spawn: SpawnLike = (program) => {
    calls.push(program);
    return new FakeChild(code) as unknown as SpawnedPlannerProcess;
  };
  return { spawn, calls };
}

async function limitedRunsRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'planner-frontier-'));
  await mkdir(join(dir, 'queue'), { recursive: true });
  await mkdir(join(dir, 'supervisor'));
  await writeFile(join(dir, 'queue/dispatch-events.log'), `${LIMITED_EVENTS}\n`);
  await writeFile(join(dir, 'supervisor/run.20261031-1414.log'), USAGE_LIMIT_LOG);
  await writeFile(join(dir, 'prompt.md'), PROMPT);
  return dir;
}

const baseOpts = (dir: string, extra: Record<string, unknown> = {}) => ({
  runsRoot: dir,
  candidates: CANDIDATES,
  lastProvider: 'cmp',
  promptPath: join(dir, 'prompt.md'),
  now,
  ...extra,
});
const lastRow = async (dir: string): Promise<string[]> => (await readFile(join(dir, 'queue/dispatch-events.log'), 'utf8')).trim().split('\n');

describe('planPlannerPass ready frontier', () => {
  it('answers the dispatchable tasks of a diamond graph with one branch done', async () => {
    const dir = await limitedRunsRoot();
    try {
      // a -> {b, c} -> d: with a and b complete, c is the only dispatchable.
      const tasks = [
        { id: 'a' },
        { id: 'b', dependsOn: ['a'] },
        { id: 'c', dependsOn: ['a'] },
        { id: 'd', dependsOn: ['b', 'c'] },
      ];
      const { choice, ready } = await planPlannerPass(baseOpts(dir, { tasks, completed: ['a', 'b'] }));
      expect(ready).toEqual(['c']);
      expect(choice).toEqual({ ok: true, provider: 'sol', argv: ['sol-login', 'run', '--json'] });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('keeps a dependency cycle blocked while independent tasks stay ready', async () => {
    const dir = await limitedRunsRoot();
    try {
      const tasks = [
        { id: 'x', dependsOn: ['y'] },
        { id: 'y', dependsOn: ['x'] },
        { id: 'free' },
      ];
      const { ready } = await planPlannerPass(baseOpts(dir, { tasks, completed: [] }));
      expect(ready).toEqual(['free']);
      expect(ready).not.toContain('x');
      expect(ready).not.toContain('y');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reports an empty frontier when no task graph is supplied', async () => {
    const dir = await limitedRunsRoot();
    try {
      const { ready } = await planPlannerPass(baseOpts(dir));
      expect(ready).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('stops the plan with DuplicateTaskIdError on a duplicate task id', async () => {
    const dir = await limitedRunsRoot();
    try {
      const tasks = [{ id: 'dup' }, { id: 'ok' }, { id: 'dup', dependsOn: ['ok'] }];
      await expect(planPlannerPass(baseOpts(dir, { tasks }))).rejects.toThrow(DuplicateTaskIdError);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('never dispatches on a duplicate task id: plan-failed, no spawn, no LEADER row', async () => {
    const dir = await limitedRunsRoot();
    try {
      const tasks = [{ id: 'dup' }, { id: 'ok' }, { id: 'dup', dependsOn: ['ok'] }];
      const stub = spawnStub(0);
      const result = await runPlannerPass(baseOpts(dir, { tasks, spawn: stub.spawn }));
      expect(result).toMatchObject({
        v: 1, outcome: 'plan-failed', provider: null, exitCode: null, logPath: null, nextResetAt: null,
      });
      expect(result.planError).toContain('Duplicate task IDs');
      expect(stub.calls).toHaveLength(0);
      expect(await lastRow(dir)).toHaveLength(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
