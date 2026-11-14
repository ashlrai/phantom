import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), rpc: vi.fn(), home: '', check: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => mocks.home }));
vi.mock('../src/core/drive/script-bridge.js', () => ({ checkDriveExecutable: mocks.check }));
vi.mock('../src/core/drive/nodes/capacity.js', () => ({ readNodeCapacity: () => ({ held: null, slots: 1 }) }));
vi.mock('../src/core/drive/nodes/worker.js', () => ({ nodeStopped: () => false, probeNodeLanes: () => ['codex'] }));
vi.mock('../src/core/drive/nodes/pool-host.js', () => ({ callPool: mocks.rpc,
  readPoolConfig: () => ({ node: 'worker', owner: 'team' }) }));
import { openSessionRunner, runHostSessionPool } from '../src/core/fleet/session-pool-host.js';
import { cmdFleetSession } from '../src/cli/fleet-session.js';
const task = { job: { id: 'job', owner: 'team', state: 'running' as const, requires: ['codex'], secrets: [] },
  claim: { jobId: 'job', nodeId: 'worker', session: 1, token: 3, leaderToken: 2, expiresAt: 999999 } };
class Child extends EventEmitter {
  pid = 0;
  stdin = new PassThrough();
  stdout = new PassThrough();
  kill = vi.fn(() => true);
}
let child: Child;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.home = realpathSync(mkdtempSync(join(tmpdir(), 'session-host-')));
  child = new Child(); mocks.spawn.mockReturnValue(child);
  let pulled = false;
  mocks.rpc.mockImplementation((_config, verb) => ({ demoted: false, result:
    verb === 'join' ? { session: 1 } : verb === 'pull' ? (pulled ? { pulled: false } : (pulled = true, { pulled: true, ...task })) :
      verb === 'renew' ? { expiresAt: Date.now() + 30000 } : verb === 'complete' ? { completed: true } : {} }));
});
afterEach(() => { vi.restoreAllMocks(); rmSync(mocks.home, { recursive: true, force: true }); });
it('runs through the CLI, writes actual JSONL metrics and retains the single-slot witness identity', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  child.stdin.on('data', raw => {
    const row = JSON.parse(raw.toString());
    child.stdout.write(JSON.stringify({ protocol: row.protocol, jobId: row.job.id, token: row.claim.token, resultRef: 'artifact' }) + '\n');
  });
  expect(await cmdFleetSession(['run', '--runner', '/trusted/runner', '--json', '--tasks', '10'])).toBe(0);
  expect(log).toHaveBeenCalledWith(JSON.stringify({ completed: 1, contexts: 1, reason: 'empty' }));
  expect(mocks.spawn).toHaveBeenCalledWith('/trusted/runner', ['session'], expect.objectContaining({ shell: false, detached: true }));
  expect(mocks.rpc.mock.calls[0]?.[2]).toEqual(['--node', 'worker', '--caps', 'codex', '--slots', '1']);
  expect(mocks.rpc.mock.calls.at(-1)?.[1]).toBe('leave');
  const rows = readFileSync(join(mocks.home, '.ashlr-runs/metrics/jobs.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
  expect(rows.map(r => r.event)).toEqual(['session_start', 'launch', 'finish', 'session_stop']);
});
it.each(['wrong-fence', 'oversized', 'death', 'abort'])('kills the persistent runner on %s', async kind => {
  const runner = openSessionRunner('/trusted/runner'), controller = new AbortController();
  const result = runner.run(task, controller.signal);
  const rejected = expect(result).rejects.toThrow();
  if (kind === 'wrong-fence') child.stdout.write('{"protocol":"phm-session-worker/v1","jobId":"job","token":4,"resultRef":"late"}\n');
  if (kind === 'oversized') child.stdout.write('x'.repeat(4097));
  if (kind === 'death') child.emit('close', 1);
  if (kind === 'abort') controller.abort();
  await rejected;
  expect(child.kill).toHaveBeenCalledOnce();
});
it('accepts fragmented replies and reuses the same process for the next task', async () => {
  const runner = openSessionRunner('/trusted/runner');
  for (let i = 0; i < 2; i++) {
    const result = runner.run(task, new AbortController().signal);
    child.stdout.write('{"protocol":"phm-session-worker/v1","jobId":"job",');
    child.stdout.write('"token":3,"resultRef":"artifact"}\n');
    expect(await result).toBe('artifact');
  }
  expect(mocks.spawn).toHaveBeenCalledOnce(); runner.close();
});
it('rejects invalid CLI policies before contacting the authority', async () => {
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  for (const extra of [['--tasks', '101'], ['--tasks', '-1'], ['--rotate-after', '0'], ['--json'], ['--typo']]) {
    expect(await cmdFleetSession(['run', '--runner', '/trusted/runner', '--json', ...extra])).toBe(2);
  }
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('rejects demoted pool responses before starting an executor', async () => {
  mocks.rpc.mockReturnValue({ demoted: true, result: {} });
  await expect(runHostSessionPool('/trusted/runner', {})).rejects.toThrow();
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it('honors the global KILL sentinel before joining the node pool', async () => {
  mkdirSync(join(mocks.home, '.ashlr'));
  writeFileSync(join(mocks.home, '.ashlr', 'KILL'), '');
  await expect(runHostSessionPool('/trusted/runner', {})).rejects.toThrow('Session admission held');
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});
