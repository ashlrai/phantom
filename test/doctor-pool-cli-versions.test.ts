/** Per-pool doctor reporting with stubbed rosters and CLI output only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstatSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { readResourceJson } from '../src/core/resources/pool-runtime.js';
import { runVerifySubprocessAsync } from '../src/core/run/verify-commands.js';
import { checkPoolCliVersions } from '../src/core/resources/pool-cli-doctor.js';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), lstatSync: vi.fn() }));
vi.mock('../src/core/resources/pool-runtime.js', () => ({ readResourceJson: vi.fn() }));
vi.mock('../src/core/run/verify-commands.js', () => ({ runVerifySubprocessAsync: vi.fn() }));
const runner = vi.mocked(runVerifySubprocessAsync);
beforeEach(() => { vi.mocked(lstatSync).mockReset(); runner.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });
function roster() {
  return { schemaVersion: 1, intervalMs: 60_000, accounts: [
    { id: 'claude-a', label: 'A', provider: 'claude', command: ['/private/claude-a', '--prefix'] },
    { id: 'claude-b', label: 'B', provider: 'claude', command: ['/private/claude-b'] },
    { id: 'codex-cmp', label: 'CMP', provider: 'codex', command: ['/private/codex-cmp'] },
    { id: 'grok', label: 'Grok', provider: 'grok', command: ['/private/grok'] },
  ] };
}
describe('doctor per-pool CLI floors', () => {
  it('reports each enrolled command independently against the shared floor', async () => {
    vi.mocked(readResourceJson).mockReturnValue(roster());
    runner.mockImplementation(async argv => ({ stdout: argv[0] === '/private/claude-a' ? '2.1.308 (Claude Code)'
      : argv[0] === '/private/claude-b' ? '2.1.309 (Claude Code)' : 'codex-cli 0.164.0',
    stderr: '', exitCode: 0, timedOut: false, cancelled: false, signal: null }));
    const checks = await checkPoolCliVersions('/owned');
    expect(checks.map(({ id, status, detail }) => ({ id, status, detail }))).toEqual([
      { id: 'pool-cli:claude-a', status: 'fail', detail: 'Claude Code 2.1.308; minimum 2.1.309 (outdated)' },
      { id: 'pool-cli:claude-b', status: 'pass', detail: 'Claude Code 2.1.309; minimum 2.1.309 (supported)' },
      { id: 'pool-cli:codex-cmp', status: 'pass', detail: 'Codex 0.164.0; minimum 0.164.0 (supported)' },
    ]);
    expect(runner.mock.calls.map(([argv]) => argv)).toEqual([
      ['/private/claude-a', '--prefix', '--version'], ['/private/claude-b', '--version'], ['/private/codex-cmp', '--version'],
    ]);
    expect(JSON.stringify(checks)).not.toContain('/private');
    expect(checks[0]?.fix).toContain('repin');
  });
  it('reports Codex below its floor as a failure and unknown output as a warning', async () => {
    vi.mocked(readResourceJson).mockReturnValue(roster());
    runner.mockImplementation(async argv => ({ stdout: argv[0] === '/private/codex-cmp' ? 'codex-cli 0.163.0' : 'PRIVATE_DIAGNOSTIC',
      stderr: 'PRIVATE_DIAGNOSTIC', exitCode: 0, timedOut: false, cancelled: false, signal: null }));
    const checks = await checkPoolCliVersions('/owned');
    expect(checks.map(check => check.status)).toEqual(['warn', 'warn', 'fail']);
    expect(checks[0]?.detail).toContain('unknown');
    expect(JSON.stringify(checks)).not.toContain('PRIVATE_DIAGNOSTIC');
  });
  it('checks both PATH defaults when no roster exists', async () => {
    vi.mocked(lstatSync).mockImplementation(() => { throw Object.assign(new Error(), { code: 'ENOENT' }); });
    runner.mockRejectedValue(new Error('PRIVATE_DIAGNOSTIC'));
    const checks = await checkPoolCliVersions('/owned');
    expect(checks.map(check => [check.id, check.status])).toEqual([['pool-cli:claude', 'warn'], ['pool-cli:codex', 'warn']]);
    expect(runner.mock.calls.map(([argv]) => argv)).toEqual([['claude', '--version'], ['codex', '--version']]);
  });
  it('fails closed on an invalid roster without invoking any command', async () => {
    vi.mocked(readResourceJson).mockReturnValue({ accounts: roster().accounts });
    expect(await checkPoolCliVersions('/owned')).toMatchObject([{ id: 'pool-cli-config', status: 'fail' }]);
    expect(runner).not.toHaveBeenCalled();
  });
  it('does not substitute PATH binaries for an unreadable roster', async () => {
    vi.mocked(lstatSync).mockImplementation(() => { throw Object.assign(new Error('PRIVATE_PATH'), { code: 'EACCES' }); });
    expect(await checkPoolCliVersions('/owned')).toMatchObject([{ id: 'pool-cli-config', status: 'fail' }]);
    expect(runner).not.toHaveBeenCalled();
  });
  it('leaves unprobed accounts explicitly unknown after the total deadline', async () => {
    vi.mocked(readResourceJson).mockReturnValue(roster());
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    runner.mockImplementation(async () => {
      now = 10_001;
      return { stdout: '2.1.309 (Claude Code)', stderr: '', exitCode: 0, timedOut: false, cancelled: false, signal: null };
    });
    const checks = await checkPoolCliVersions('/owned');
    expect(checks.map(check => check.status)).toEqual(['pass', 'warn', 'warn']);
    expect(checks[1]?.detail).toContain('unknown');
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
