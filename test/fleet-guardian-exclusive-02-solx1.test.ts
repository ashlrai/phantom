import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGuardianVerify } from '../src/cli/fleet-guardian-verify.js';
import { type GuardianOptions, type GuardianSummary } from '../src/core/fleet/guardian-verify-loop.js';
import { guardianVerifyLockPath, runGuardianVerifyExclusive } from '../src/core/fleet/guardian-verify-exclusive.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock, type LocalStoreLock } from '../src/core/fleet/local-store-lock.js';

const SUMMARY: GuardianSummary = { passes: 1, pass: 1, fail: 0, unknown: 0, cancelled: false, deadlineExceeded: false };
const CANCELLED: GuardianSummary = { passes: 1, pass: 0, fail: 0, unknown: 1, cancelled: true, deadlineExceeded: false };
const ORIGINAL = '{"version":1,"entries":[]}\n';

interface Gate { promise: Promise<void>; open: () => void }
function gate(): Gate {
  let open!: () => void;
  return { promise: new Promise<void>(resolve => { open = resolve; }), open };
}

/** Deferred fake verifier: counts invocations and signals when it has started. */
function deferredRun(hold: Gate, result: GuardianSummary = SUMMARY) {
  let started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const run = vi.fn(async (_options: GuardianOptions) => { started(); await hold.promise; return result; });
  return { run, begun };
}

let dir: string;
let manifest: string;
let state: string;
let options: GuardianOptions;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'guardian-exclusive-'));
  manifest = join(dir, 'manifest.json');
  state = join(dir, 'state.json');
  await writeFile(manifest, '[]');
  await writeFile(state, ORIGINAL);
  options = { manifest, state, maxPasses: 1, intervalMs: 1000 };
});

afterEach(() => { vi.restoreAllMocks(); });

describe('guardian-verify exclusive runner', () => {
  it('overlapping runs on one state target invoke verification once and refuse the competitor without touching state', async () => {
    const hold = gate();
    const { run, begun } = deferredRun(hold);
    const link = join(dir, 'alias');
    await symlink(dir, link);
    const first = runGuardianVerifyExclusive(options, { run });
    await begun;
    const competitor = await runGuardianVerifyExclusive({ ...options, state: join(dir, '..', basename(dir), 'state.json') }, { run });
    const aliased = await runGuardianVerifyExclusive({ ...options, state: join(link, 'state.json') }, { run });
    expect(competitor).toEqual({ state: 'refused', reason: 'already-running' });
    expect(aliased).toEqual({ state: 'refused', reason: 'already-running' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await readFile(state, 'utf8')).toBe(ORIGINAL);
    hold.open();
    expect(await first).toEqual({ state: 'ran', summary: SUMMARY });
  });

  it('different state targets run independently', async () => {
    const other = join(dir, 'other');
    await mkdir(other);
    const hold = gate();
    const { run, begun } = deferredRun(hold);
    const first = runGuardianVerifyExclusive(options, { run });
    await begun;
    const second = runGuardianVerifyExclusive({ ...options, state: join(other, 'state.json') }, { run });
    hold.open();
    expect(await Promise.all([first, second])).toEqual([{ state: 'ran', summary: SUMMARY }, { state: 'ran', summary: SUMMARY }]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('acquires before the verifier runs and releases only after the run settles', async () => {
    const events: string[] = [];
    const hold = gate();
    const run = vi.fn(async () => { events.push('run'); await hold.promise; events.push('run-settled'); return SUMMARY; });
    const pending = runGuardianVerifyExclusive(options, {
      run,
      acquire: path => { events.push('acquire'); return acquireLocalStoreLockWithOutcome(path, 0); },
      release: (lock: LocalStoreLock) => { events.push('release'); return releaseLocalStoreLock(lock); },
    });
    await vi.waitFor(() => expect(events).toContain('run'));
    expect(events).toEqual(['acquire', 'run']);
    hold.open();
    await pending;
    expect(events).toEqual(['acquire', 'run', 'run-settled', 'release']);
  });

  it('a rejected run releases ownership after it settles so a later invocation succeeds', async () => {
    const hold = gate();
    const run = vi.fn(async () => { await hold.promise; throw new Error('verifier exploded'); });
    const first = runGuardianVerifyExclusive(options, { run });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(await runGuardianVerifyExclusive(options, { run })).toEqual({ state: 'refused', reason: 'already-running' });
    hold.open();
    await expect(first).rejects.toThrow('verifier exploded');
    expect(await runGuardianVerifyExclusive(options, { run: vi.fn(async () => SUMMARY) })).toEqual({ state: 'ran', summary: SUMMARY });
  });

  it('cancellation holds ownership until the aborted run settles', async () => {
    const controller = new AbortController();
    const settle = gate();
    let aborted!: () => void;
    const abortedSeen = new Promise<void>(resolve => { aborted = resolve; });
    const run = vi.fn(async (opts: GuardianOptions) => {
      await new Promise<void>(resolve => opts.signal?.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
      await settle.promise;
      return CANCELLED;
    });
    const pending = runGuardianVerifyExclusive({ ...options, signal: controller.signal }, { run });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    controller.abort();
    await abortedSeen;
    expect(await runGuardianVerifyExclusive(options, { run })).toEqual({ state: 'refused', reason: 'already-running' });
    settle.open();
    expect(await pending).toEqual({ state: 'ran', summary: CANCELLED });
    expect(await runGuardianVerifyExclusive(options, { run: vi.fn(async () => SUMMARY) })).toEqual({ state: 'ran', summary: SUMMARY });
  });

  it('invalid state paths fail before any lock file or verifier work', async () => {
    const run = vi.fn(async () => SUMMARY);
    await expect(runGuardianVerifyExclusive({ ...options, state: '' }, { run })).rejects.toThrow('invalid state path');
    await expect(runGuardianVerifyExclusive({ ...options, state: 'relative/state.json' }, { run })).rejects.toThrow('invalid state path');
    await expect(runGuardianVerifyExclusive({ ...options, state: join(dir, 'missing', 'state.json') }, { run })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(expect.arrayContaining(['manifest.json', 'state.json']));
    expect((await readdir(dir)).some(name => name.endsWith('.lock'))).toBe(false);
  });

  it('keys the lock by canonical state target', () => {
    expect(guardianVerifyLockPath(join(dir, 'a', '..', 'state.json'))).toBe(join(realpathSync(dir), 'state.json.guardian-verify.lock'));
  });
});

describe('cmdFleetGuardianVerify exclusive path', () => {
  it('refuses a competing invocation with exit 5, runs no checks and preserves state byte-for-byte', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const hold = gate();
    const { run: first, begun } = deferredRun(hold);
    const running = cmdFleetGuardianVerify(['--manifest', manifest, '--state', state, '--json'], first as never);
    await begun;
    const second = vi.fn(async () => SUMMARY);
    expect(await cmdFleetGuardianVerify(['--manifest', manifest, '--state', state, '--json'], second as never)).toBe(5);
    expect(second).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toEqual({ state: 'refused', reason: 'already-running', ran: false });
    expect(await readFile(state, 'utf8')).toBe(ORIGINAL);
    hold.open();
    expect(await running).toBe(0);
    expect(await cmdFleetGuardianVerify(['--manifest', manifest, '--state', state], vi.fn(async () => SUMMARY) as never)).toBe(0);
  });

  it('rejects invalid arguments with exit 2 and a relative state with exit 3, launching nothing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = vi.fn(async () => SUMMARY);
    expect(await cmdFleetGuardianVerify(['--state', state, '--state', state], run as never)).toBe(2);
    expect(await cmdFleetGuardianVerify(['--manifest', manifest, '--state', state, '--timeout-ms', '0'], run as never)).toBe(2);
    expect(await cmdFleetGuardianVerify(['--manifest', manifest, '--state', 'relative.json'], run as never)).toBe(3);
    expect(run).not.toHaveBeenCalled();
    expect((await readdir(dir)).some(name => name.endsWith('.lock'))).toBe(false);
    expect(err).toHaveBeenCalled();
  });
});

describe('cross-process contention', () => {
  const moduleUrl = pathToFileURL(resolve('src/core/fleet/guardian-verify-exclusive.ts')).href;
  // The holder takes the real lock through the production runner, with a fake verifier that
  // stays in flight until its stdin closes. It prints 'ready' only once it owns the lock.
  const holderScript = (): string => `
const { runGuardianVerifyExclusive } = await import(${JSON.stringify(moduleUrl)});
const outcome = await runGuardianVerifyExclusive({ manifest: ${JSON.stringify(manifest)}, state: ${JSON.stringify(state)}, maxPasses: 1, intervalMs: 1000 }, { run: async () => {
  process.stdout.write('ready\\n');
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('end', resolve));
  return ${JSON.stringify(SUMMARY)};
} });
process.stdout.write(outcome.state + '\\n');
`;
  function spawnHolder(): Promise<{ child: ChildProcess; exited: Promise<number | null>; output: () => string }> {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', holderScript()], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.on('data', chunk => { out += String(chunk); });
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`holder exited before ready (${code}): ${stderr.slice(0, 500)}`)));
      const ready = (): void => { if (out.includes('ready')) { child.stdout!.off('data', ready); resolve({ child, exited, output: () => out }); } };
      child.stdout!.on('data', ready);
    });
  }

  it('a live holder in another process refuses this invocation until it exits', async () => {
    const holderProc = await spawnHolder();
    const run = vi.fn(async () => SUMMARY);
    // A foreign owner is reported 'already-running' only when its start time can be probed via ps.
    // Where that probe is blocked (this sandbox denies /bin/ps) the holder is conservatively
    // 'lock-unavailable'. Both are refusals that never run the verifier; the reason is the only difference.
    const refused = await runGuardianVerifyExclusive(options, { run });
    expect(refused.state).toBe('refused');
    expect(['already-running', 'lock-unavailable']).toContain((refused as { reason: string }).reason);
    expect(run).not.toHaveBeenCalled();
    holderProc.child.stdin!.end();
    expect(await holderProc.exited).toBe(0);
    expect(holderProc.output()).toContain('ready');
    expect(await runGuardianVerifyExclusive(options, { run })).toEqual({ state: 'ran', summary: SUMMARY });
  }, 60_000);

  it('a holder killed with SIGKILL does not block a later invocation', async () => {
    const holderProc = await spawnHolder();
    holderProc.child.kill('SIGKILL');
    await holderProc.exited;
    const run = vi.fn(async () => SUMMARY);
    expect(await runGuardianVerifyExclusive(options, { run })).toEqual({ state: 'ran', summary: SUMMARY });
    expect(run).toHaveBeenCalledTimes(1);
  }, 60_000);
});
