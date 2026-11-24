import { describe, expect, it, vi } from 'vitest';
import { cmdFleetLandedSweep } from '../src/cli/fleet-landed-sweep.js';
import { cmdFleetDirtyLanded } from '../src/cli/fleet-dirty-landed.js';
import { describeGhFailure } from '../src/core/fleet/landed-gh-failure.js';
import { gitOnlyLanded } from '../src/core/fleet/landed-git-only.js';
import type { LandedFromGit } from '../src/core/fleet/landed-from-git.js';

const synthetic = 'SYNTHETIC_PRIVATE_STDERR';
const git: LandedFromGit = {
  schema: 'fleet.landed.v1', source: 'git', ok: true, repo: 'phantom', sinceHours: 24,
  jobs: [{ id: 'RQ-SYNTHETIC', repo: 'phantom', sha: 'a'.repeat(40), at: '2026-01-01' }], repos: [],
};
const cases = [
  [{ stderr: synthetic, missing: true }, 'missing', 'gh not installed'],
  [{ stderr: `gh auth login ${synthetic}` }, 'signed-out', 'gh not signed in'],
  [{ stderr: synthetic, timedOut: true }, 'offline', 'network unreachable'],
  [{ stderr: `could not resolve host ${synthetic}` }, 'offline', 'network unreachable'],
  [{ stderr: synthetic }, 'error', 'gh failed'],
] as const;

describe('original gh failure diagnostics', () => {
  it.each(cases)('classifies failures without returning process output', (failure, kind, reason) => {
    expect(describeGhFailure(failure)).toEqual({ kind, reason });
  });

  it.each(cases)('reports unavailable gh through the real sweep dependency', async (failure, kind, reason) => {
    for (const apply of [false, true]) {
      const output: string[] = [];
      const close = vi.fn();
      const branch = vi.fn(async (refresh: boolean) => refresh
        ? { state: 'unknown' as const, reason: 'synthetic evidence' }
        : gitOnlyLanded());
      const gh = async () => ({ ok: false, stdout: '', ...failure });
      const code = await cmdFleetLandedSweep(['--json', ...(apply ? ['--apply'] : [])], {
        gh, runner: close, landedFromGit: () => git, branchEvidence: branch, output: text => output.push(text),
      });
      const result = JSON.parse(output[0]!);
      expect(code).toBe(0);
      expect(result).toMatchObject({ source: 'git', inspected: 1, landed: 1, closed: 0, ghFailure: { kind, reason } });
      expect(result.branchEvidence).toEqual({ state: 'unknown', reason: apply ? 'synthetic evidence' : 'base not refreshed' });
      expect(branch).toHaveBeenCalledWith(apply);
      expect(close).not.toHaveBeenCalled();
      expect(output.join('')).not.toContain(synthetic);
    }
  });

  it('prints the safe reason in human output', async () => {
    const output: string[] = [];
    await cmdFleetLandedSweep([], { gh: async () => ({ ok: false, stdout: '', stderr: synthetic }),
      landedFromGit: () => git, branchEvidence: async () => ({ state: 'unknown', reason: 'base not refreshed' }),
      output: text => output.push(text) });
    expect(output[0]).toContain('gh failed');
    expect(output.join('')).not.toContain(synthetic);
  });

  it('rejects malformed successful output without classifying it as unavailable or closing', async () => {
    const close = vi.fn();
    const failure = vi.fn();
    const structured = vi.fn();
    const gh = async () => ({ ok: true, stdout: '{', stderr: synthetic });
    expect(await cmdFleetDirtyLanded(['--json'], { gh, onFailure: failure, onGhFailure: structured })).toBe(1);
    expect(failure).toHaveBeenCalledWith('malformed', 'invalid gh response');
    expect(structured).not.toHaveBeenCalled();
    for (const apply of [false, true]) {
      const output: string[] = [];
      expect(await cmdFleetLandedSweep(['--json', ...(apply ? ['--apply'] : [])], { gh, runner: close, output: text => output.push(text) })).toBe(1);
      expect(JSON.parse(output[0]!)).toMatchObject({ error: expect.stringContaining('unreadable') });
      expect(output.join('')).not.toContain(synthetic);
    }
    expect(close).not.toHaveBeenCalled();
  });

  it('retains a valid empty GitHub report', async () => {
    const output: string[] = [];
    expect(await cmdFleetLandedSweep(['--json'], { gh: async () => ({ ok: true, stdout: '[]', stderr: '' }), output: text => output.push(text) })).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ inspected: 0, landed: 0, closed: 0 });
    expect(JSON.parse(output[0]!)).not.toHaveProperty('ghFailure');
  });
});
