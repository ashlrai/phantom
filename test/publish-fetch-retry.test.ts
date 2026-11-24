import { describe, expect, it, vi } from 'vitest';
import type { Gh } from '../src/core/autopilot/github.js';
import { cmdPublish } from '../src/cli/publish.js';
import { isTransientGhError, retryReads } from '../src/core/publish/retry.js';
import { resumePublish } from '../src/core/publish/resume.js';

const SHA = 'a'.repeat(40);
const BRANCH = 'codex-bridge/RQ-DEMO';
const instant = { sleep: async () => {} };

/** Fake GitHub; `fail(line, n)` returns an error message for the nth call to a matching read, or null. */
function world(fail: (line: string, n: number) => string | null) {
  const calls: string[][] = [];
  const seen = new Map<string, number>();
  const gh: Gh = async (args) => {
    calls.push(args);
    const line = args.join(' ');
    const n = (seen.get(line) ?? 0) + 1;
    seen.set(line, n);
    const err = fail(line, n);
    if (err) throw new Error(err);
    if (args[0] === 'pr') return '';
    if (args.includes('POST')) return JSON.stringify({ number: 42 });
    if (line.endsWith(' user')) return JSON.stringify({ login: 'mine' });
    if (line.includes('/git/matching-refs/')) return JSON.stringify([{ ref: `refs/heads/${BRANCH}`, object: { sha: SHA } }]);
    if (line.includes('/pulls?')) return '[]';
    if (line.includes('/compare/')) return JSON.stringify({ ahead_by: 1, files: [{ filename: 'a.ts' }], commits: [{ commit: { message: 'Add it' } }] });
    if (line.endsWith('repos/ashlrai/phantom')) return JSON.stringify({ default_branch: 'master' });
    throw new Error(`unexpected call: ${line}`);
  };
  return { gh, calls };
}
const posts = (calls: string[][]) => calls.filter((c) => c.includes('POST')).length;

describe('transient error classification', () => {
  it.each(['gh api: HTTP 502', 'gh api: timed out after 60s', 'gh api: HTTP 403: API rate limit exceeded', 'dial tcp: ECONNRESET', 'could not resolve host'])('retries %s', (m) => {
    expect(isTransientGhError(new Error(m))).toBe(true);
  });
  it.each(['gh api: HTTP 401: Bad credentials', 'gh api: HTTP 404: Not Found', 'gh api: HTTP 422: Validation Failed', 'HTTP 403: Resource not accessible by integration'])('does not retry %s', (m) => {
    expect(isTransientGhError(new Error(m))).toBe(false);
  });
});

describe('retryReads', () => {
  it('waits between tries with the bounded backoff', async () => {
    const sleep = vi.fn(async () => {});
    let n = 0;
    const gh = retryReads(async () => { if (++n < 3) throw new Error('HTTP 503'); return 'ok'; }, { sleep, backoffMs: [5, 9] });
    expect(await gh(['api', 'user'])).toBe('ok');
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5, 9]);
  });
  it('never retries writes', async () => {
    const inner = vi.fn(async () => { throw new Error('HTTP 502'); });
    const gh = retryReads(inner, instant);
    await expect(gh(['api', '-X', 'POST', 'repos/a/b/pulls'])).rejects.toThrow('502');
    await expect(gh(['pr', 'merge', '1'])).rejects.toThrow('502');
    expect(inner).toHaveBeenCalledTimes(2);
  });
});

describe('publish resume: default-branch fetch recovery', () => {
  it('recovers from a transient failure on the default-branch lookup and opens one PR', async () => {
    const w = world((line, n) => (line.endsWith('repos/ashlrai/phantom') && n < 3 ? 'gh api: HTTP 502: Bad Gateway' : null));
    const r = await resumePublish({ branch: BRANCH, retry: instant }, w.gh);
    expect(r).toMatchObject({ status: 'opened', pr_url: 'https://github.com/ashlrai/phantom/pull/42' });
    expect(posts(w.calls)).toBe(1);
    expect(w.calls.filter((c) => c.join(' ').endsWith('repos/ashlrai/phantom'))).toHaveLength(3);
  });
  it('a persistent outage defers: bounded tries, plain reason, retry command, no write', async () => {
    const w = world((line) => (line.includes('/compare/') ? 'gh api: timed out after 60s' : null));
    const r = await resumePublish({ branch: BRANCH, retry: instant }, w.gh);
    expect(r).toMatchObject({ status: 'deferred', pr_url: null, branch: BRANCH, deferred: { attempts: 3, retry: `phm publish resume --branch ${BRANCH}` } });
    expect(r.deferred!.reason).toContain('timed out');
    expect(w.calls.filter((c) => c.join(' ').includes('/compare/'))).toHaveLength(3);
    expect(posts(w.calls)).toBe(0);
    expect(w.calls.some((c) => c[0] === 'pr')).toBe(false);
  });
  it('a deferred run can be rerun to completion', async () => {
    let down = true;
    const w = world((line) => (down && line.includes('/compare/') ? 'HTTP 503' : null));
    expect((await resumePublish({ branch: BRANCH, retry: instant }, w.gh)).status).toBe('deferred');
    down = false;
    expect((await resumePublish({ branch: BRANCH, retry: instant }, w.gh)).status).toBe('opened');
  });
  it('auth and permission failures are not retried or deferred, so security gates stay put', async () => {
    const w = world((line) => (line.endsWith(' user') ? 'gh api: HTTP 401: Bad credentials' : null));
    await expect(resumePublish({ branch: BRANCH, retry: instant }, w.gh)).rejects.toThrow('Bad credentials');
    expect(w.calls).toHaveLength(1);
  });
  it('a failed PR create is not retried (no duplicate PRs) and auto-merge is never admin', async () => {
    const w = world((line) => (line.includes('POST') ? 'gh api: HTTP 502' : null));
    await expect(resumePublish({ branch: BRANCH, retry: instant }, w.gh)).rejects.toThrow('502');
    expect(posts(w.calls)).toBe(1);
    expect(w.calls.flat().join(' ')).not.toContain('--admin');
  });
  it('CLI reports the reason and the command, exits 1, JSON keeps the schema', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const down = () => world((line) => (line.includes('/compare/') ? 'HTTP 504' : null)).gh;
    expect(await cmdPublish(['resume', '--branch', BRANCH], down(), instant)).toBe(1);
    const text = String(out.mock.calls[0]![0]);
    expect(text).toContain('Your branch is safe on your fork');
    expect(text).toContain('HTTP 504');
    expect(text).toContain(`phm publish resume --branch ${BRANCH}`);
    expect(await cmdPublish(['resume', '--branch', BRANCH, '--json'], down(), instant)).toBe(1);
    expect(JSON.parse(String(out.mock.calls[1]![0]))).toMatchObject({ schema: 'publish.resume.v1', status: 'deferred', deferred: { attempts: 3 } });
    out.mockRestore();
  });
});
