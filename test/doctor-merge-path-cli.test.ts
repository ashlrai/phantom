import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/merge-path.js', () => ({
  probeMergePath: vi.fn(async (repo: string) => ({ repo, branch: 'main', signal: 'MERGE_PATH_BROKEN', missingContexts: ['CI Gate'], requiredContexts: ['CI Gate'], observedContexts: ['Merge Gate'], headsExamined: 1 })),
}));
import { cmdDoctor } from '../src/cli/doctor-init.js';

afterEach(() => vi.restoreAllMocks());
describe('doctor merge-path CLI', () => {
  it('routes JSON and a failing exit status with actionable context', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDoctor(['merge-path', '--repo', 'acme/repo', '--json'])).toBe(1);
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({ results: [{ repo: 'acme/repo', branch: 'main', signal: 'MERGE_PATH_BROKEN', missingContexts: ['CI Gate'] }] });
  });
  it('rejects write-like or malformed options', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdDoctor(['merge-path', '--repo', 'acme/repo', '--fix'])).toBe(2);
  });
});
