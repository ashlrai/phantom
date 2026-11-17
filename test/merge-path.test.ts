import { describe, expect, it, vi } from 'vitest';
import { probeMergePath } from '../src/core/merge-path.js';

function fixture(classic: string[], rules: string[], emitted: string[], heads = ['abc']) {
  return vi.fn(async (path: string): Promise<unknown> => {
    if (path === 'repos/acme/repo') return { default_branch: 'main' };
    if (path === 'repos/acme/repo/branches/main') return { protected: true };
    if (path === 'repos/acme/repo/branches/main/protection') return { required_status_checks: { contexts: classic, checks: [] } };
    if (path.startsWith('repos/acme/repo/rules/branches/main?')) return [{ type: 'required_status_checks', parameters: { required_status_checks: rules.map(context => ({ context })) } }];
    if (path.startsWith('repos/acme/repo/pulls?')) return heads.map(sha => ({ head: { sha } }));
    if (path.includes('/check-runs?')) return { check_runs: emitted.map(name => ({ name })) };
    if (path.includes('/statuses?')) return [];
    throw new Error(`Unexpected read: ${path}`);
  });
}

describe('merge path sentinel', () => {
  it('matches classic and ruleset contexts against PR heads using reads only', async () => {
    const read = fixture(['CI Gate'], ['Security'], ['CI Gate', 'Security']);
    expect(await probeMergePath('acme/repo', undefined, read)).toMatchObject({ repo: 'acme/repo', branch: 'main', signal: 'MERGE_PATH_OK', missingContexts: [], headsExamined: 1 });
    expect(read.mock.calls.every(([path]) => /^repos\/acme\/repo(?:\/|$)/u.test(path))).toBe(true);
  });
  it('reports a missing ruleset context', async () => {
    expect(await probeMergePath('acme/repo', undefined, fixture([], ['Security'], ['CI Gate']))).toMatchObject({ signal: 'MERGE_PATH_BROKEN', missingContexts: ['Security'] });
  });
  it('detects CI Gate renamed to Merge Gate', async () => {
    expect(await probeMergePath('acme/repo', undefined, fixture(['CI Gate'], [], ['Merge Gate']))).toMatchObject({ repo: 'acme/repo', branch: 'main', signal: 'MERGE_PATH_BROKEN', missingContexts: ['CI Gate'], observedContexts: ['Merge Gate'] });
  });
  it('does not claim missing checks when no PR heads exist', async () => {
    expect(await probeMergePath('acme/repo', undefined, fixture(['CI Gate'], [], [], []))).toMatchObject({ signal: 'MERGE_PATH_UNKNOWN', missingContexts: [] });
  });
  it('propagates unreadable evidence', async () => {
    await expect(probeMergePath('acme/repo', undefined, async () => { throw new Error('unavailable'); })).rejects.toThrow('unavailable');
  });
});
