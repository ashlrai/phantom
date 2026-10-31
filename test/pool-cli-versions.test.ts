/** Stubbed version output only. No real vendor process, credential or network access. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runVerifySubprocessAsync, type VerifySubprocessResult } from '../src/core/run/verify-commands.js';
import { assessPoolCliVersion, POOL_CLI_MIN_VERSIONS, probePoolCliVersion } from '../src/core/resources/pool-cli-versions.js';

vi.mock('../src/core/run/verify-commands.js', () => ({ runVerifySubprocessAsync: vi.fn() }));
const runner = vi.mocked(runVerifySubprocessAsync);
const options = { cwd: '/owned', env: {}, timeoutMs: 30_000 };
function result(stdout: string, patch: Partial<VerifySubprocessResult> = {}): VerifySubprocessResult {
  return { stdout, stderr: '', exitCode: 0, timedOut: false, cancelled: false, signal: null, ...patch };
}
beforeEach(() => { runner.mockReset(); });

describe('shared pool CLI security manifest', () => {
  it('declares both immutable floors', () => {
    expect(POOL_CLI_MIN_VERSIONS).toEqual({ claude: { label: 'Claude Code', minimum: '2.1.311' },
      codex: { label: 'Codex', minimum: '0.164.0' } });
    expect(Object.isFrozen(POOL_CLI_MIN_VERSIONS)).toBe(true);
    expect(Object.isFrozen(POOL_CLI_MIN_VERSIONS.claude)).toBe(true);
  });
  it.each([
    ['claude', '2.1.308 (Claude Code)', 'outdated'],
    ['claude', '2.1.310 (Claude Code)', 'outdated'],
    ['claude', '2.1.311 (Claude Code)', 'supported'],
    ['claude', '2.1.312 (Claude Code)', 'supported'],
    ['claude', '2.2.0 (Claude Code)', 'supported'],
    ['claude', '2.1.99 (Claude Code)', 'outdated'],
    ['claude', '2.1.311-rc.1 (Claude Code)', 'outdated'],
    ['claude', '2.1.311--candidate (Claude Code)', 'outdated'],
    ['claude', '2.1.311+build.1 (Claude Code)', 'supported'],
    ['codex', 'codex-cli 0.163.0', 'outdated'],
    ['codex', 'codex-cli 0.164.0', 'supported'],
    ['codex', 'codex-cli 0.165.0', 'supported'],
    ['codex', 'codex-cli 0.164.0-alpha.1', 'outdated'],
    ['codex', 'codex-cli 0.164.0+build.1', 'supported'],
  ] as const)('compares %s output %s as %s', (provider, output, status) => {
    expect(assessPoolCliVersion(provider, output).status).toBe(status);
  });
  it.each(['', 'PRIVATE_DIAGNOSTIC', '2.1.311', '2.1.311 (Other Client)',
    '2.1.311 (Claude Code)\nPRIVATE_DIAGNOSTIC', '02.1.311 (Claude Code)', '9999999.0.0 (Claude Code)',
    '\u001b[32m2.1.311 (Claude Code)', '2.1.311-rc..1 (Claude Code)',
    'codex-cli 0.164.0'])('never guesses or echoes unknown output %#', output => {
    expect(assessPoolCliVersion('claude', output)).toEqual({ status: 'unknown', version: null });
  });
  it('probes the exact wrapper prefix with a bounded no-input invocation', async () => {
    runner.mockResolvedValue(result('2.1.311 (Claude Code)\r\n'));
    expect(await probePoolCliVersion('claude', ['/node', '/private/launcher.mjs', '--owner'], options))
      .toEqual({ status: 'supported', version: '2.1.311' });
    expect(runner).toHaveBeenCalledExactlyOnceWith(['/node', '/private/launcher.mjs', '--owner', '--version'],
      { ...options, timeoutMs: 5_000, maxOutputChars: 4_096 });
  });
  it.each([{ exitCode: 1 }, { error: 'PRIVATE_DIAGNOSTIC' },
    { signal: 'SIGTERM' as const }, { outputTruncated: true }])('withholds evidence on process failure %#', async patch => {
    runner.mockResolvedValue(result('2.1.311 (Claude Code)', patch));
    expect(await probePoolCliVersion('claude', ['/wrapper'], options)).toEqual({ status: 'unknown', version: null });
  });
  it('contains thrown diagnostics', async () => {
    runner.mockRejectedValue(new Error('PRIVATE_DIAGNOSTIC'));
    expect(await probePoolCliVersion('claude', ['/wrapper'], options)).toEqual({ status: 'unknown', version: null });
  });
  it.each([
    [{ timedOut: true }, 'timed-out'], [{ cancelled: true }, 'cancelled'],
    [{ error: 'termination authority lost: PRIVATE_DIAGNOSTIC', cancelled: true }, 'termination-uncertain'],
    [{ error: 'termination deadline elapsed with process-group exit unconfirmed', timedOut: true }, 'termination-uncertain'],
  ] as const)('preserves bounded subprocess settlement %#', async (patch, failure) => {
    runner.mockResolvedValue(result('2.1.311 (Claude Code)', patch));
    expect(await probePoolCliVersion('claude', ['/wrapper'], options)).toEqual({ status: 'unknown', version: null, failure });
  });
  it('does not start a cancelled or empty command', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await probePoolCliVersion('claude', ['/wrapper'], { ...options, signal: controller.signal }))
      .toEqual({ status: 'unknown', version: null });
    expect(await probePoolCliVersion('codex', [], options)).toEqual({ status: 'unknown', version: null });
    expect(runner).not.toHaveBeenCalled();
  });
});
