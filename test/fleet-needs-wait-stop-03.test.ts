import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetNeedsWait } from '../src/cli/fleet-needs-wait.js';
import { waitNeedsMason } from '../src/core/fleet/needs-mason-wait.js';

const item = 'Approve the fake deploy';
const id = `nm-${createHash('sha256').update(item).digest('hex').slice(0, 12)}`;
const dirs: string[] = [];
// A resolved marker proves the ledger was consulted: if the stop file were ignored, the wait would return resolved.
const resolvedLedger = `- [x] resolved ${id} timestamp\n`;
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'needs-wait-stop-')); dirs.push(dir); return dir;
}
function ledger(text = `- [ ] ${item}\n`): { dir: string; file: string } {
  const dir = scratch();
  const file = join(dir, 'NEEDS-MASON.md'); writeFileSync(file, text); return { dir, file };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('fleet needs-wait stop file', () => {
  it('cancels on a pre-existing sentinel without inspecting the ledger', async () => {
    const { dir } = ledger(resolvedLedger); const stop = join(dir, 'STOP'); writeFileSync(stop, '');
    const sleep = vi.fn();
    expect(await waitNeedsMason({ id, timeoutMs: 10, pollMs: 1, runsDir: dir, stopFile: stop, sleep })).toBe('cancelled');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('cancels when the sentinel appears during a sleep', async () => {
    const { dir } = ledger(); const stop = join(dir, 'STOP'); const sleep = vi.fn(async () => { writeFileSync(stop, ''); });
    expect(await waitNeedsMason({ id, timeoutMs: 100, pollMs: 10, runsDir: dir, stopFile: stop, now: () => 0, sleep })).toBe('cancelled');
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('permits real fake-ledger resolution while the sentinel is missing', async () => {
    const { dir, file } = ledger(); const stop = join(dir, 'STOP'); let clock = 0;
    const sleep = vi.fn(async (ms: number) => { clock += ms; appendFileSync(file, resolvedLedger); });
    expect(await waitNeedsMason({ id, timeoutMs: 100, pollMs: 10, runsDir: dir, stopFile: stop, now: () => clock, sleep })).toBe('resolved');
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('cancels on a dangling symlink without following or reading its target', async () => {
    const { dir } = ledger(); const target = join(dir, 'missing-target'); const stop = join(dir, 'STOP');
    symlinkSync(target, stop); const sleep = vi.fn();
    expect(await waitNeedsMason({ id, timeoutMs: 10, pollMs: 1, runsDir: dir, stopFile: stop, sleep })).toBe('cancelled');
    expect(sleep).not.toHaveBeenCalled();
    expect(existsSync(target)).toBe(false);
  });

  it('reports an inaccessible sentinel as unavailable, not success', async () => {
    if (process.getuid?.() === 0) return; // root bypasses directory permissions, so the lock cannot be observed.
    const { dir } = ledger(resolvedLedger); const locked = join(dir, 'locked'); mkdirSync(locked);
    const stop = join(locked, 'STOP'); writeFileSync(stop, ''); chmodSync(locked, 0o000);
    const sleep = vi.fn();
    try {
      expect(await waitNeedsMason({ id, timeoutMs: 10, pollMs: 1, runsDir: dir, stopFile: stop, sleep })).toBe('unavailable');
      expect(sleep).not.toHaveBeenCalled();
    } finally { chmodSync(locked, 0o755); }
  });

  it('rejects an empty stop file path', async () => {
    const { dir } = ledger();
    await expect(waitNeedsMason({ id, timeoutMs: 10, pollMs: 1, runsDir: dir, stopFile: '' })).rejects.toThrow(RangeError);
  });

  it('keeps the no-option behavior and removes signal listeners on every stop path', async () => {
    const { dir } = ledger(resolvedLedger); const stop = join(dir, 'STOP'); writeFileSync(stop, '');
    const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
    expect(await waitNeedsMason({ id, timeoutMs: 10, pollMs: 1, runsDir: dir, stopFile: stop, sleep: vi.fn() })).toBe('cancelled');
    expect(await waitNeedsMason({ id, timeoutMs: 10, pollMs: 1, runsDir: dir, sleep: vi.fn() })).toBe('resolved');
    expect(process.listenerCount('SIGINT')).toBe(beforeInt); expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });

  it('passes --stop-file through the CLI and exits 1 on cancellation', async () => {
    const { dir } = ledger(resolvedLedger); const stop = join(dir, 'STOP'); writeFileSync(stop, '');
    const emit = vi.fn();
    const code = await cmdFleetNeedsWait([id, '--timeout-ms', '50', '--poll-ms', '10', '--runs-dir', dir, '--stop-file', stop, '--json'], { emit, sleep: vi.fn() });
    expect(code).toBe(1); expect(JSON.parse(emit.mock.calls[0]![0])).toEqual({ status: 'cancelled', id });
  });

  it('rejects duplicate, missing or flag-shaped --stop-file arguments', async () => {
    const { dir } = ledger(); const stop = join(dir, 'STOP');
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const args of [
      [id, '--timeout-ms', '2', '--runs-dir', dir, '--stop-file', stop, '--stop-file', stop],
      [id, '--timeout-ms', '2', '--runs-dir', dir, '--stop-file'],
      [id, '--timeout-ms', '2', '--runs-dir', dir, '--stop-file', '--json'],
    ]) {
      expect(await cmdFleetNeedsWait(args)).toBe(2);
    }
    expect(error).toHaveBeenCalledTimes(3);
  });
});
