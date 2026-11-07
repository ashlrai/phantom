/**
 * Coverage for `phm daily-fix` (src/cli/daily-fix.ts) — exit codes and
 * validation wiring over src/core/ci-fix-filter.ts. No stdin, no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdDailyFix } from '../src/cli/daily-fix.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('daily-fix dispatch', () => {
  it('prints help and exits 0 on no args or --help', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDailyFix([])).toBe(0);
    expect(await cmdDailyFix(['--help'])).toBe(0);
    expect(out.mock.calls.flat().join('\n')).toContain('daily-fix');
  });

  it('rejects missing and invalid inputs with exit 2/1', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdDailyFix(['dispatch'])).toBe(2);
    expect(await cmdDailyFix(['validate', '--jobs', 'bogus-job'])).toBe(1);
    expect(await cmdDailyFix(['nosuchsub'])).toBe(2);
  });

  it('validates allowlisted inputs and emits the gh command as JSON', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDailyFix(['validate', '--jobs', 'ci,docs', '--json'])).toBe(0);
    const payload = JSON.parse(out.mock.calls.flat().join('\n')) as {
      valid: boolean;
      inputs: { onlyJobs?: string };
    };
    expect(payload.valid).toBe(true);
    expect(payload.inputs.onlyJobs).toBe('ci,docs');
  });

  it('dispatch prints a workflow run command without shell interpolation', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDailyFix(['dispatch', '--jobs', 'ci', '--tests', 'hop rollup', '--mac-shard', '2', '--json'])).toBe(0);
    const text = out.mock.calls.flat().join('\n');
    expect(text).toContain('gh workflow run ci.yml');
    expect(text).toContain('only_jobs=ci');
    expect(text).toContain('mac_shard=2');
  });
});
