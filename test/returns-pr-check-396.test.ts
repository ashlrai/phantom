import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetReturnsCheck } from '../src/cli/fleet-returns-check.js';
import type { Gh } from '../src/core/autopilot/github.js';
import { claimFleetWork } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { checkReturnPrs, type ReturnEvidenceRow } from '../src/core/fleet/return-pr-check.js';

const HEAD_FULL = 'abc1234def567890abcdef1234567890abcdef12';
const OTHER_FULL = '9'.repeat(40);

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'returns-pr-check-396-'));
  dirs.push(dir);
  const path = join(dir, 'board.jsonl');
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', path);
  return { path };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const row = (over: Partial<ReturnEvidenceRow> = {}): ReturnEvidenceRow => ({
  claimId: 'claim-1', repo: 'example/demo', result: 'VERIFIED', evidenceKind: 'pr',
  pr: 100, head: 'abc1234', ...over,
});

const prBody = (over: Record<string, unknown> = {}): string => JSON.stringify({
  state: 'closed', merged: true, merged_at: '2026-11-10T12:00:00Z',
  head: { sha: HEAD_FULL }, ...over,
});

/** Canned per-`repos/<repo>/pulls/<n>` responses; a value of `null` throws. */
const ghMap = (map: Record<string, string | null>, calls?: string[]): Gh => async (args) => {
  const path = args[args.length - 1]!;
  calls?.push(path);
  const body = map[path];
  if (body === undefined) throw new Error(`unexpected gh call: ${path}`);
  if (body === null) throw new Error('gh api: HTTP 502 at api.github.com (token ghp_SECRETLEAK)');
  return body;
};
const key = (repo: string, pr: number) => `repos/${repo}/pulls/${pr}`;

describe('checkReturnPrs', () => {
  it('labels merged at the claimed head, case-insensitive prefix', async () => {
    const report = await checkReturnPrs([row({ head: 'ABC1234' })], { gh: ghMap({ [key('example/demo', 100)]: prBody() }) });
    expect(report).toMatchObject({ v: 1, authority: 'none', skipped: 0, truncated: false });
    expect(report.checked).toEqual([{ claimId: 'claim-1', repo: 'example/demo', pr: 100, head: 'ABC1234',
      verdict: 'merged-at-head', observedHead: HEAD_FULL, mergedAt: '2026-11-10T12:00:00Z' }]);
  });
  it('labels merged at a different head', async () => {
    const report = await checkReturnPrs([row()], { gh: ghMap({ [key('example/demo', 100)]: prBody({ head: { sha: OTHER_FULL } }) }) });
    expect(report.checked[0]).toMatchObject({ verdict: 'merged-other-head', observedHead: OTHER_FULL });
  });
  it('labels open and closed-unmerged', async () => {
    const report = await checkReturnPrs([row({ claimId: 'a', pr: 1 }), row({ claimId: 'b', pr: 2 })], {
      gh: ghMap({
        [key('example/demo', 1)]: prBody({ state: 'open', merged: false, merged_at: null, head: { sha: HEAD_FULL } }),
        [key('example/demo', 2)]: prBody({ state: 'closed', merged: false, merged_at: null, head: { sha: HEAD_FULL } }),
      }),
    });
    expect(report.checked.map(r => r.verdict)).toEqual(['open', 'closed-unmerged']);
    expect(report.checked[0]).toMatchObject({ mergedAt: null });
  });
  it('skips non-VERIFIED and non-pr rows and dedupes repo#pr', async () => {
    const calls: string[] = [];
    const report = await checkReturnPrs([
      row({ claimId: 'a' }),
      row({ claimId: 'dup-of-a' }),
      row({ claimId: 'blocked', result: 'BLOCKED', pr: 200 }),
      row({ claimId: 'tests', evidenceKind: 'tests', pr: null, head: null }),
    ], { gh: ghMap({ [key('example/demo', 100)]: prBody() }, calls) });
    expect(calls).toEqual([key('example/demo', 100)]);
    expect(report.checked.map(r => r.claimId)).toEqual(['a']);
    expect(report.skipped).toBe(3);
  });
  it('honors limit and reports truncated', async () => {
    const calls: string[] = [];
    const report = await checkReturnPrs([
      row({ claimId: 'a', pr: 1 }), row({ claimId: 'b', pr: 2 }), row({ claimId: 'c', pr: 3 }),
    ], { gh: ghMap({ [key('example/demo', 1)]: prBody(), [key('example/demo', 2)]: prBody() }, calls), limit: 2 });
    expect(calls).toHaveLength(2);
    expect(report.checked.map(r => r.claimId)).toEqual(['a', 'b']);
    expect(report.truncated).toBe(true);
    expect(report.skipped).toBe(1);
  });
  it('marks rows past the total deadline unknown with reason deadline', async () => {
    let t = 1_000;
    const gh: Gh = async () => { t += 30_000; return prBody(); };
    const report = await checkReturnPrs([row({ claimId: 'a' }), row({ claimId: 'b', pr: 2 })],
      { gh, now: () => t, timeoutMs: 20_000 });
    expect(report.checked[0]).toMatchObject({ claimId: 'a', verdict: 'unknown', observedHead: null, mergedAt: null, reason: 'deadline' });
    expect(report.checked[1]).toMatchObject({ claimId: 'b', verdict: 'unknown', observedHead: null, mergedAt: null, reason: 'deadline' });
  });
  it('turns a gh throw into unknown with a fixed reason and no raw error text', async () => {
    const report = await checkReturnPrs([row()], { gh: ghMap({ [key('example/demo', 100)]: null }) });
    expect(report.checked[0]).toMatchObject({ verdict: 'unknown', reason: 'read-failed', observedHead: null, mergedAt: null });
    const text = JSON.stringify(report);
    expect(text).not.toContain('ghp_SECRETLEAK');
    expect(text).not.toContain('502');
    expect(text).not.toContain('unexpected gh call');
  });
  it('turns unparseable gh output into unknown', async () => {
    const report = await checkReturnPrs([row({ claimId: 'a' }), row({ claimId: 'b', pr: 2 })], {
      gh: ghMap({ [key('example/demo', 100)]: 'not json', [key('example/demo', 2)]: prBody({ head: {} }) }),
    });
    expect(report.checked[0]).toMatchObject({ verdict: 'unknown', reason: 'read-failed' });
    expect(report.checked[1]).toMatchObject({ verdict: 'unknown', reason: 'unparseable' });
  });
  it('rejects a repo assertRepo refuses and a claimed head under 7 chars cannot match', async () => {
    const report = await checkReturnPrs([
      row({ claimId: 'bad-repo', repo: 'bad_repo/demo' }),
      row({ claimId: 'short-head', pr: 2, head: 'abc' }),
    ], { gh: ghMap({ [key('example/demo', 2)]: prBody() }) });
    expect(report.checked[0]).toMatchObject({ verdict: 'unknown', reason: 'invalid-repo' });
    expect(report.checked[1]).toMatchObject({ verdict: 'merged-other-head' });
  });
});

describe('ashlr fleet returns-check', () => {
  function seedReturn(opts: { path: string }, pr: number, head: string) {
    const claimed = claimFleetWork({ repo: 'example/demo', task: 'Check returns', agent: 'test-agent' }, opts);
    if (!claimed.ok) throw new Error('fixture claim failed');
    const returned = returnFleetClaim({ id: claimed.value.claim.id, agent: 'test-agent', lease: claimed.value.lease, pr, head }, opts);
    if (!returned.ok) throw new Error('fixture return failed');
    return claimed.value.claim.id;
  }
  it('prints one line per row and exits 0 when every row merged at head', async () => {
    const opts = fixture();
    const claimId = seedReturn(opts, 396, 'abc1234');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const gh = ghMap({ [key('example/demo', 396)]: prBody() });
    expect(await cmdFleetReturnsCheck([], { gh })).toBe(0);
    const lines = log.mock.calls.map(c => String(c[0]));
    expect(lines[0]).toBe('projection coverage: parsed-total=1 omitted=0 unparsed=0');
    expect(lines[1]).toBe(`merged-at-head  example/demo#396  claimed abc1234 observed abc1234 (${claimId})`);
    expect(lines.at(-1)).toMatch(/^checked=1 skipped=0 truncated=no as-of=/);
  });
  it('exits 1 when a checked row is not merged at head, and JSON carries the verdict', async () => {
    const opts = fixture();
    seedReturn(opts, 396, 'abc1234');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const gh = ghMap({ [key('example/demo', 396)]: prBody({ state: 'open', merged: false, merged_at: null }) });
    expect(await cmdFleetReturnsCheck(['--json'], { gh })).toBe(1);
    const out = JSON.parse(log.mock.calls[0]![0] as string);
    expect(out).toMatchObject({ v: 1, authority: 'none', returnsState: 'known',
      checked: [{ repo: 'example/demo', pr: 396, verdict: 'open' }] });
  });
  it('exits 1 with an honest unknown when the ledger cannot be read', async () => {
    fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const gh: Gh = async () => { throw new Error('gh must not be called'); };
    expect(await cmdFleetReturnsCheck(['--json'], { gh })).toBe(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ returnsState: 'unknown', checked: [] });
  });
  it.each([[['--limit', '0']], [['--limit', '51']], [['--bogus']], [['extra']], [['--json', '--json']]])(
    'rejects bad arguments %j with exit 2', async (args) => {
      fixture();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await cmdFleetReturnsCheck(args, { gh: async () => '' })).toBe(2);
      expect(log).not.toHaveBeenCalled();
    });
  it('--help prints usage and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetReturnsCheck(['--help'])).toBe(0);
    expect(String(log.mock.calls[0]![0])).toContain('Usage: ashlr fleet returns-check');
  });
});
