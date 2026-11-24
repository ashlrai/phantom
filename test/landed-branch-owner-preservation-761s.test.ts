import { expect, it, vi } from 'vitest';
import { cmdFleetLandedSweep } from '../src/cli/fleet-landed-sweep.js';
import type { LandedFromGit } from '../src/core/fleet/landed-from-git.js';

it('preserves job evidence and never closes when gh is unavailable', async () => {
  const close = vi.fn();
  const jobs = { ok: true, repo: 'ashlrai/phantom', sinceHours: 24, jobs: [{ repo: 'ashlrai/phantom' }] } as LandedFromGit;
  for (const evidence of [
    { state: 'ok' as const, baseSha: 'a'.repeat(40), branches: [{ name: 'contained', ahead: 0, contained: true }, { name: 'pending', ahead: 1, contained: false }] },
    { state: 'unknown' as const, reason: 'branch comparison failed' },
  ]) {
    let text = '';
    const code = await cmdFleetLandedSweep(['--json', '--apply'], {
      gh: async () => ({ ok: false, stdout: '', stderr: 'gh not installed' }),
      landedFromGit: () => jobs, branchEvidence: async () => evidence,
      runner: close, output: value => { text = value; },
    });
    const report = JSON.parse(text);
    expect(code).toBe(0); expect(report.source).toBe('git'); expect(report.landed).toBe(1);
    expect(report.branchEvidence).toEqual(evidence); expect(report.skippedReason).toContain('No PRs closed');
  }
  expect(close).not.toHaveBeenCalled();
});
