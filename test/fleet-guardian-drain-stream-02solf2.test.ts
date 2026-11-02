import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGuardianDrain } from '../src/cli/fleet-guardian-drain.js';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drain-stream-')); dirs.push(dir);
  const args = ['--manifest', join(dir, 'manifest'), '--source-state', join(dir, 'source'), '--output-dir', dir,
    '--max-retries', '2', '--timeout-ms', '60000'];
  let selected = 0;
  const select = vi.fn(async () => ({ repo: join(process.env.HOME!, `fake-${++selected}`), sha: String(selected).repeat(40) }));
  const prepare = vi.fn(async () => undefined) as unknown as NonNullable<Parameters<typeof cmdFleetGuardianDrain>[1]>['prepare'];
  const ran = { state: 'ran', summary: { deadlineExceeded: false, cancelled: false, sensitive: 'private synthetic detail' } } as unknown as GuardianVerifyExclusiveResult;
  return { dir, args, select, prepare, ran };
}
function capture() {
  const lines: string[] = [];
  return { lines, writeLine: (line: string) => { lines.push(line); } };
}

describe('guardian drain streaming', () => {
  it('delivers each sanitized attempt before the next verification settles, then one summary', async () => {
    const o = await setup(); const { lines, writeLine } = capture();
    let release!: (result: GuardianVerifyExclusiveResult) => void;
    let started!: () => void;
    const secondStarted = new Promise<void>(resolve => { started = resolve; });
    const verify = vi.fn().mockResolvedValueOnce(o.ran).mockImplementationOnce(() => {
      started(); return new Promise<GuardianVerifyExclusiveResult>(resolve => { release = resolve; });
    });
    const pending = cmdFleetGuardianDrain([...o.args, '--apply', '--stream'], { select: o.select, prepare: o.prepare, verify, writeLine });
    await secondStarted;
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ record: 'attempt', attempt: 1, repo: '~/fake-1', outcome: 'verified' });
    expect(lines[0]).not.toContain('private synthetic detail');
    release(o.ran);
    expect(await pending).toBe(0);
    const records = lines.map(line => JSON.parse(line));
    expect(records.map(r => r.record)).toEqual(['attempt', 'attempt', 'summary']);
    expect(records[2]).toMatchObject({ attempts: 2, verified: 2, termination: 'max-retries' });
  });
  it('emits a refusal and stops', async () => {
    const o = await setup(); const { lines, writeLine } = capture();
    const verify = vi.fn(async () => ({ state: 'refused' as const, reason: 'already-running' as const }));
    expect(await cmdFleetGuardianDrain([...o.args, '--apply', '--stream'], { select: o.select, prepare: o.prepare, verify, writeLine })).toBe(5);
    expect(lines.map(line => JSON.parse(line))).toMatchObject([
      { record: 'attempt', outcome: 'refused', refusal: 'already-running', latestOutput: null },
      { record: 'summary', termination: 'refused', refused: 1 },
    ]);
    expect(verify).toHaveBeenCalledTimes(1);
  });
  it('stops after an observer fails and cleans up signal listeners and timer', async () => {
    const o = await setup(); const { lines, writeLine } = capture();
    let first = true;
    const failingSink = async (line: string) => { if (first) { first = false; throw new Error('synthetic failure'); } writeLine(line); };
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const verify = vi.fn(async () => o.ran);
    expect(await cmdFleetGuardianDrain([...o.args, '--apply', '--stream'], { select: o.select, prepare: o.prepare, verify, writeLine: failingSink })).toBe(3);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(o.select).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ record: 'summary', termination: 'observer-error', attempts: 1, verified: 1 });
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
    expect(clear).toHaveBeenCalled();
  });
  it('rejects conflicting flags before work and keeps JSON and preview behavior', async () => {
    const o = await setup(); const { lines, writeLine } = capture();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdFleetGuardianDrain([...o.args, '--stream', '--json'], { select: o.select })).toBe(2);
    expect(o.select).not.toHaveBeenCalled();
    expect(await cmdFleetGuardianDrain([...o.args, '--stream'], { select: o.select, writeLine })).toBe(0);
    expect(lines.map(line => JSON.parse(line))).toMatchObject([{ record: 'summary', mode: 'preview', attempts: 0 }]);
    expect(await readdir(o.dir)).toEqual([]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetGuardianDrain([...o.args, '--json'], { select: o.select })).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ mode: 'preview', termination: 'planned' });
  });
});
