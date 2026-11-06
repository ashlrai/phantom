import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGuardianDrain } from '../src/cli/fleet-guardian-drain.js';
import { drainGuardianInfraRetries, type GuardianDrainDeps } from '../src/core/fleet/guardian-retry-drain.js';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-stop-')); dirs.push(dir);
  const sourceState = join(dir, 'source'); const stopFile = join(dir, 'stop');
  await writeFile(sourceState, 'original state');
  const options = { manifest: join(dir, 'manifest'), sourceState, outputDir: dir, stopFile, maxRetries: 2, timeoutMs: 60000, apply: true };
  let n = 0;
  const select = vi.fn(async () => ({ repo: `/fake/repo-${++n}`, sha: String(n).repeat(40) }));
  const prepare = vi.fn(async () => undefined) as unknown as NonNullable<GuardianDrainDeps['prepare']>;
  const ran = { state: 'ran', summary: { deadlineExceeded: false, cancelled: false } } as GuardianVerifyExclusiveResult;
  const verify = vi.fn(async () => ran);
  const args = ['--manifest', options.manifest, '--source-state', sourceState, '--output-dir', dir, '--max-retries', '2', '--timeout-ms', '60000'];
  return { dir, sourceState, stopFile, options, select, prepare, verify, ran, args };
}

describe('guardian drain stop file', () => {
  it.each([true, false])('stops before selection in apply=%s and leaves files untouched', async apply => {
    const o = await setup(); await writeFile(o.stopFile, 'keep stop');
    const result = await drainGuardianInfraRetries({ ...o.options, apply }, o);
    expect(result).toMatchObject({ termination: 'stopped', attempts: 0, planned: [] });
    expect(o.select).not.toHaveBeenCalled(); expect(o.prepare).not.toHaveBeenCalled(); expect(o.verify).not.toHaveBeenCalled();
    expect(await readFile(o.sourceState, 'utf8')).toBe('original state');
    expect(await readFile(o.stopFile, 'utf8')).toBe('keep stop');
    expect((await readdir(o.dir)).sort()).toEqual(['source', 'stop']);
  });
  it('allows a missing stop file and preserves max-retries behavior', async () => {
    const o = await setup();
    expect(await drainGuardianInfraRetries(o.options, o)).toMatchObject({ termination: 'max-retries', attempts: 2, verified: 2 });
    expect(o.verify).toHaveBeenCalledTimes(2);
  });
  it('finishes the current verification and observer before stopping the next admission', async () => {
    const o = await setup(); const events: string[] = [];
    const verify = vi.fn(async () => { await writeFile(o.stopFile, 'stop'); events.push('cleanup'); return o.ran; });
    const onAttempt = vi.fn(async () => { events.push('observer'); });
    const result = await drainGuardianInfraRetries(o.options, { ...o, verify, onAttempt });
    expect(result).toMatchObject({ termination: 'stopped', attempts: 1, verified: 1, latestOutput: join(o.dir, 'guardian-drain-attempt-1.json') });
    expect(events).toEqual(['cleanup', 'observer']);
    expect(o.select).toHaveBeenCalledTimes(1); expect(o.prepare).toHaveBeenCalledTimes(1); expect(verify).toHaveBeenCalledTimes(1);
    expect(await readFile(o.stopFile, 'utf8')).toBe('stop'); expect(await readFile(o.sourceState, 'utf8')).toBe('original state');
  });
  it.each([true, false])('rechecks after an awaited selection in apply=%s', async apply => {
    const o = await setup();
    const select = vi.fn(async () => { await writeFile(o.stopFile, 'stop'); return { repo: '/fake/repo', sha: 'a'.repeat(40) }; });
    const result = await drainGuardianInfraRetries({ ...o.options, apply }, { ...o, select });
    expect(result).toMatchObject({ termination: 'stopped', attempts: 0, attempted: [], planned: [] });
    expect(o.prepare).not.toHaveBeenCalled(); expect(o.verify).not.toHaveBeenCalled();
  });
  it('treats unexpected lookup errors as unsafe', async () => {
    const o = await setup();
    const result = await drainGuardianInfraRetries({ ...o.options, stopFile: join(o.sourceState, 'child') }, o);
    expect(result.termination).toBe('unsafe'); expect(o.select).not.toHaveBeenCalled();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetGuardianDrain([...o.args, '--apply', '--stop-file', join(o.sourceState, 'child')], o)).toBe(3);
  });
  it('rejects invalid and duplicate stop-file arguments before work', async () => {
    const o = await setup(); vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const extra of [['--stop-file'], ['--stop-file', 'relative'], ['--stop-file', '/bad\0path'], ['--stop-file', o.stopFile, '--stop-file', o.stopFile], ['--stop-file', `/${'x'.repeat(4096)}`]]) {
      expect(await cmdFleetGuardianDrain([...o.args, '--apply', ...extra], o)).toBe(2);
    }
    expect(o.select).not.toHaveBeenCalled(); expect(o.prepare).not.toHaveBeenCalled(); expect(o.verify).not.toHaveBeenCalled();
    expect(await readdir(o.dir)).toEqual(['source']);
  });
  it('retains no-stop deadline and max-retries behavior', async () => {
    const o = await setup(); const { stopFile: _stopFile, ...options } = o.options;
    expect(await drainGuardianInfraRetries(options, o)).toMatchObject({ termination: 'max-retries', verified: 2 });
    let time = 0;
    const verify = vi.fn(async () => { time = 60001; return o.ran; });
    expect(await drainGuardianInfraRetries({ ...options, now: () => time }, { ...o, verify })).toMatchObject({ termination: 'deadline', verified: 1 });
  });
});
