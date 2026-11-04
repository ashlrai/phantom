import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetNeedsWait } from '../src/cli/fleet-needs-wait.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { waitNeedsMason } from '../src/core/fleet/needs-mason-wait.js';

const item = 'Approve the fake deploy';
const id = `nm-${createHash('sha256').update(item).digest('hex').slice(0, 12)}`;
const dirs: string[] = [];
function ledger(text = `- [ ] ${item}\n`): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'needs-wait-')); dirs.push(dir);
  const file = join(dir, 'NEEDS-MASON.md'); writeFileSync(file, text); return { dir, file };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('fleet needs-wait', () => {
  it('waits for an explicit marker and preserves the requested root through the CLI', async () => {
    const { dir, file } = ledger(); let clock = 0;
    const emit = vi.fn();
    const code = await cmdFleetNeedsWait([id, '--timeout-ms', '50', '--poll-ms', '10', '--runs-dir', dir, '--json'], {
      emit, now: () => clock, sleep: async ms => { clock += ms; appendFileSync(file, `- [x] resolved ${id} timestamp\n`); },
    });
    expect(code).toBe(0); expect(JSON.parse(emit.mock.calls[0]![0])).toEqual({ status: 'resolved', id });
  });
  it('accepts a marker at entry even when the item is gone', async () => {
    const { dir } = ledger(`- [x] resolved ${id} timestamp\n`);
    expect(await waitNeedsMason({ id, timeoutMs: 10, pollMs: 1, runsDir: dir })).toBe('resolved');
  });
  it('reports removal without a marker as unknown', async () => {
    const { dir, file } = ledger(); let clock = 0;
    expect(await waitNeedsMason({ id, timeoutMs: 10, pollMs: 1, runsDir: dir, now: () => clock,
      sleep: async ms => { clock += ms; writeFileSync(file, '# empty\n'); } })).toBe('unknown');
  });
  it('clamps sleeps to the monotonic deadline', async () => {
    const { dir } = ledger(); let clock = 0; const sleeps: number[] = [];
    expect(await waitNeedsMason({ id, timeoutMs: 25, pollMs: 10, runsDir: dir, now: () => clock,
      sleep: async ms => { sleeps.push(ms); clock += ms; } })).toBe('timeout');
    expect(sleeps).toEqual([10, 10, 5]);
  });
  it('cancels during sleep and removes signal listeners', async () => {
    const { dir } = ledger(); const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
    const result = await waitNeedsMason({ id, timeoutMs: 100, pollMs: 10, runsDir: dir,
      sleep: async (_ms, signal) => { process.emit('SIGTERM'); expect(signal.aborted).toBe(true); } });
    expect(result).toBe('cancelled'); expect(process.listenerCount('SIGINT')).toBe(beforeInt); expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });
  it('fails promptly for an unknown id', async () => {
    const { dir } = ledger(); const sleep = vi.fn();
    expect(await waitNeedsMason({ id: 'nm-000000000000', timeoutMs: 10, pollMs: 1, runsDir: dir, sleep })).toBe('unknown'); expect(sleep).not.toHaveBeenCalled();
  });
  it('treats missing, oversized, nonregular and symlink ledgers as unavailable', async () => {
    const { dir, file } = ledger(); const opts = { id, timeoutMs: 10, pollMs: 1, runsDir: dir };
    rmSync(file); expect(await waitNeedsMason(opts)).toBe('unavailable');
    writeFileSync(file, 'a'.repeat(32769)); expect(await waitNeedsMason(opts)).toBe('unavailable');
    rmSync(file); mkdirSync(file); expect(await waitNeedsMason(opts)).toBe('unavailable');
    rmSync(file, { recursive: true }); symlinkSync('/dev/null', file); expect(await waitNeedsMason(opts)).toBe('unavailable');
  });
  it('validates arguments and exposes help under the convention export', async () => {
    expect(resolveFleetSubcommand('needs-wait')).toEqual({ module: './fleet-needs-wait.js', exportName: 'cmdFleetNeedsWait' });
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const args of [[], [id], [id, '--timeout-ms', '0'], [id, '--timeout-ms', 'Infinity'], [id, '--timeout-ms', '2147483648'], [id, '--timeout-ms', '2', '--poll-ms', '0'], ['bad', '--timeout-ms', '2'], [id, '--timeout-ms', '2', '--json', '--json']]) {
      expect(await cmdFleetNeedsWait(args)).toBe(2);
    }
    expect(error).toHaveBeenCalled(); const emit = vi.fn();
    expect(await cmdFleetNeedsWait(['--help'], { emit })).toBe(0); expect(emit).toHaveBeenCalledOnce();
  });
});
