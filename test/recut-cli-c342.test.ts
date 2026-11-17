import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/merge-path.js', () => ({
  probeMergePath: vi.fn(async (repo: string, branch?: string) => ({
    repo,
    branch: branch ?? 'main',
    signal: 'MERGE_PATH_OK',
    missingContexts: [],
    requiredContexts: ['CI Gate'],
    observedContexts: ['CI Gate'],
    headsExamined: 2,
  })),
}));
import { cmdDoctorMergePath } from '../src/cli/doctor-merge-path.js';

afterEach(() => vi.restoreAllMocks());

describe('cmdDoctorMergePath (RQ-PHX-RECUTCLIOLDC342)', () => {
  it('prints a human-readable line per repo and exits 0 when all signals are OK', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDoctorMergePath(['--repo', 'acme/widgets'])).toBe(0);
    expect(out).toHaveBeenCalledWith('acme/widgets main: MERGE_PATH_OK');
  });
  it('emits JSON results honoring an explicit branch', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDoctorMergePath(['--repo', 'acme/widgets', '--branch', 'release', '--json'])).toBe(0);
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({ results: [{ repo: 'acme/widgets', branch: 'release', signal: 'MERGE_PATH_OK' }] });
  });
  it('prints usage and exits 0 on --help', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDoctorMergePath(['--help'])).toBe(0);
    expect(String(out.mock.calls[0]?.[0])).toContain('phm doctor merge-path');
  });
  it('exits 2 with usage on stderr when no repo is given', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdDoctorMergePath([])).toBe(2);
    expect(String(err.mock.calls[0]?.[0])).toContain('Usage: phm doctor merge-path');
  });
});
