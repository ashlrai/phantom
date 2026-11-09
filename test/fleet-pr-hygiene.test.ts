import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetPrHygiene, type FleetPrHygieneDeps } from '../src/cli/fleet-pr-hygiene.js';
import {
  auditPrHygiene,
  failedPrHygieneReport,
  parsePrHygieneOpenPr,
  type PrHygieneOpenPr,
} from '../src/core/fleet/pr-hygiene.js';

const NOW = new Date('2026-11-07T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const pr = (number: number, overrides: Partial<PrHygieneOpenPr> = {}): PrHygieneOpenPr => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/ashlrai/phantom/pull/${number}`,
  headRef: `branch-${number}`,
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  createdAt: daysAgo(30),
  updatedAt: daysAgo(1),
  files: [],
  ...overrides,
});

const ghRow = (number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/ashlrai/phantom/pull/${number}`,
  headRefName: `branch-${number}`,
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  createdAt: daysAgo(30),
  updatedAt: daysAgo(1),
  files: [],
  ...overrides,
});

const audit = (input: Partial<Parameters<typeof auditPrHygiene>[0]> & { open: PrHygieneOpenPr[] }) =>
  auditPrHygiene({ repo: 'ashlrai/phantom', staleDays: 7, limit: 500, now: NOW, ...input });

describe('parsePrHygieneOpenPr', () => {
  it('accepts a well-formed row and keeps normalized file paths', () => {
    expect(parsePrHygieneOpenPr(ghRow(12, { files: [{ path: 'src/a.ts' }, { path: './src/b.ts' }, { path: '../evil' }, 'junk'] })))
      .toMatchObject({ number: 12, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', files: ['src/a.ts', 'src/b.ts'] });
  });

  it.each([null, [], 'x', {}, { number: 0 }, { number: 'x' }, { number: -1 }])('rejects %j', row => {
    expect(parsePrHygieneOpenPr(row)).toBeNull();
  });

  it('defaults unreadable fields instead of guessing', () => {
    const parsed = parsePrHygieneOpenPr(ghRow(5, { mergeable: 'WEIRD', mergeStateStatus: 4, url: 'ftp://x', updatedAt: 'not-a-date' }));
    expect(parsed).toMatchObject({ number: 5, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', url: null, updatedAt: null });
  });
});

describe('auditPrHygiene', () => {
  it('flags stale, conflicted, overlap and draft; clean PRs stay ok', () => {
    const report = audit({
      open: [
        pr(1, { updatedAt: daysAgo(20) }),                                            // stale
        pr(2, { mergeable: 'CONFLICTING' }),                                          // conflicted
        pr(3, { files: ['src/shared.ts'] }),                                          // overlap with 4
        pr(4, { files: ['src/shared.ts'] }),                                          // overlap with 3
        pr(5, { isDraft: true, mergeStateStatus: 'DRAFT' }),                          // draft only → ok
        pr(6),                                                                        // clean → ok
      ],
    });
    const byNumber = new Map(report.items.map(item => [item.number, item]));
    expect(byNumber.get(1)).toMatchObject({ triage: 'review', reason: 'stale-no-update', idleDays: 20 });
    expect(byNumber.get(1)!.flags).toContain('stale');
    expect(byNumber.get(2)).toMatchObject({ triage: 'refix', reason: 'merge-conflict' });
    expect(byNumber.get(3)).toMatchObject({ triage: 'review', reason: 'file-overlap', overlap: { count: 1, prs: [4] } });
    expect(byNumber.get(5)).toMatchObject({ triage: 'ok' });
    expect(byNumber.get(5)!.flags).toEqual(['draft']);
    expect(byNumber.get(6)).toMatchObject({ triage: 'ok', flags: [] });
    expect(report.counts).toMatchObject({ open: 6, flagged: 4 });
    expect(report.counts.triage).toEqual({ 'close-candidate': 0, 'refix': 1, 'review': 3, 'ok': 2 });
  });

  it('marks a merged-job prompt reference a close candidate even when it also conflicts', () => {
    const report = audit({
      open: [pr(10, { mergeStateStatus: 'DIRTY' })],
      merged: [{ number: 99, title: 'recut RQ-FAKE-1' }],
      prompts: new Map([['RQ-FAKE-1', 'Rebuild PR #10.']]),
    });
    const item = report.items[0]!;
    expect(item).toMatchObject({ triage: 'close-candidate', reason: 'superseded-by-merged-pr' });
    expect(item.supersededBy).toEqual({ number: 99, title: 'recut RQ-FAKE-1', jobId: 'RQ-FAKE-1' });
    expect(item.flags).toEqual(expect.arrayContaining(['superseded', 'conflicted']));
    expect(report.reads).toEqual({ open: 'ok', merged: 'ok', prompts: 'ok' });
  });

  it('conflict outranks stale, and stale outranks overlap', () => {
    const report = audit({
      open: [
        pr(1, { mergeStateStatus: 'DIRTY', updatedAt: daysAgo(40), files: ['src/x.ts'] }),
        pr(2, { files: ['src/x.ts'], updatedAt: daysAgo(30) }),
      ],
    });
    expect(report.items.find(i => i.number === 1)).toMatchObject({ triage: 'refix', reason: 'merge-conflict' });
    expect(report.items.find(i => i.number === 2)).toMatchObject({ triage: 'review', reason: 'stale-no-update' });
  });

  it('never infers supersession without prompt evidence and records degraded reads', () => {
    const report = audit({
      open: [pr(10)],
      merged: 'failed',
      prompts: new Map([['RQ-FAKE-1', 'Rebuild PR #10.']]),
    });
    expect(report.items[0]).toMatchObject({ triage: 'ok', flags: [] });
    expect(report.reads).toEqual({ open: 'ok', merged: 'failed', prompts: 'ok' });
    const noPrompts = audit({ open: [pr(10)], merged: [{ number: 99, title: 'RQ-FAKE-1' }], prompts: 'unavailable' });
    expect(noPrompts.reads).toEqual({ open: 'ok', merged: 'ok', prompts: 'unavailable' });
    expect(noPrompts.items[0]!.flags).not.toContain('superseded');
  });

  it('leaves missing or future timestamps unknown rather than flagging stale', () => {
    const report = audit({
      open: [
        pr(1, { createdAt: null, updatedAt: null }),
        pr(2, { updatedAt: new Date(NOW.getTime() + 86_400_000).toISOString() }),
      ],
    });
    expect(report.items.find(i => i.number === 1)).toMatchObject({ ageDays: null, idleDays: null, triage: 'ok' });
    expect(report.items.find(i => i.number === 2)).toMatchObject({ idleDays: 0, triage: 'ok' });
  });

  it('dedupes observations, reports dropped rows and caps overlap detail at five', () => {
    const report = audit({
      open: [pr(1, { files: ['src/hot.ts'] }), pr(1), ...[2, 3, 4, 5, 6, 7, 8].map(n => pr(n, { files: ['src/hot.ts'] }))],
      observedOpen: 10,
    });
    expect(report.counts).toMatchObject({ open: 8, unreadable: 2 });
    expect(report.items.find(i => i.number === 1)!.overlap).toEqual({ count: 7, prs: [2, 3, 4, 5, 6] });
  });

  it('sorts flagged lanes first then oldest idle', () => {
    const report = audit({
      open: [
        pr(1),
        pr(2, { updatedAt: daysAgo(9) }),
        pr(3, { mergeable: 'CONFLICTING', updatedAt: daysAgo(5) }),
        pr(4, { updatedAt: daysAgo(30) }),
      ],
    });
    expect(report.items.map(i => i.number)).toEqual([3, 4, 2, 1]);
    expect(report.complete).toBe(true);
  });

  it('page at the limit is not complete', () => {
    const report = audit({ open: [pr(1), pr(2)], limit: 2 });
    expect(report.complete).toBe(false);
  });

  it('emits a failed report shape for an unread open list', () => {
    const report = failedPrHygieneReport({ repo: 'a/b', staleDays: 7, limit: 500, reason: 'gh-pr-list-failed', now: NOW });
    expect(report).toMatchObject({
      schema: 'fleet.pr-hygiene.v1', v: 1, repo: 'a/b', complete: false, error: 'gh-pr-list-failed',
      reads: { open: 'failed', merged: 'skipped', prompts: 'unavailable' },
      counts: { open: 0, flagged: 0 }, items: [],
    });
  });
});

describe('fleet pr-hygiene', () => {
  let output: string[];
  let errors: string;
  beforeEach(() => {
    output = []; errors = '';
    vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { errors += String(chunk); return true; });
  });
  afterEach(() => vi.restoreAllMocks());

  const ghOk = (openRows: unknown[], mergedRows: unknown[] = []): NonNullable<FleetPrHygieneDeps['gh']> =>
    async args => ({
      ok: true, stderr: '',
      stdout: JSON.stringify(args.includes('open') ? openRows : mergedRows),
    });

  it('rejects bad usage with exit 2', async () => {
    expect(await cmdFleetPrHygiene(['--repo', 'not a repo'])).toBe(2);
    expect(await cmdFleetPrHygiene(['--stale-days', '0'])).toBe(2);
    expect(await cmdFleetPrHygiene(['--limit', '99999'])).toBe(2);
    expect(await cmdFleetPrHygiene(['--bogus'])).toBe(2);
    expect(await cmdFleetPrHygiene(['--json', '--json'])).toBe(2);
    expect(errors).toContain('Usage: ashlr fleet pr-hygiene');
  });

  it('prints usage on --help and exits 0', async () => {
    expect(await cmdFleetPrHygiene(['--help'])).toBe(0);
    expect(output[0]).toContain('Usage: ashlr fleet pr-hygiene');
  });

  it('emits the v1 report and only ever lists PRs', async () => {
    const gh = vi.fn(ghOk(
      [ghRow(10, { mergeStateStatus: 'DIRTY' }), ghRow(11, { updatedAt: daysAgo(30) }), ghRow(12)],
      [{ number: 99, title: 'recut RQ-FAKE-1' }],
    ));
    const result = await cmdFleetPrHygiene(['--json'], {
      gh,
      prompts: async () => new Map([['RQ-FAKE-1', 'Rebuild PR #77.']]),
      now: () => NOW,
    });
    expect(result).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report).toMatchObject({
      schema: 'fleet.pr-hygiene.v1', v: 1, repo: 'ashlrai/phantom', complete: true,
      generatedAt: NOW.toISOString(), staleDays: 7,
      reads: { open: 'ok', merged: 'ok', prompts: 'ok' },
      counts: { open: 3, flagged: 2 },
    });
    expect(report.items[0]).toMatchObject({ number: 10, triage: 'refix', reason: 'merge-conflict' });
    expect(report.items[1]).toMatchObject({ number: 11, triage: 'review', reason: 'stale-no-update' });
    expect(gh).toHaveBeenCalledTimes(2);
    for (const [args] of gh.mock.calls) {
      expect(args.slice(0, 2)).toEqual(['pr', 'list']);
      expect(args).toContain('--repo');
      expect(args).not.toContain('close');
      expect(args).not.toContain('merge');
      expect(args).not.toContain('edit');
    }
  });

  it('still exits 0 and degrades the superseded leg when merged or prompts fail', async () => {
    const gh: NonNullable<FleetPrHygieneDeps['gh']> = async args =>
      args.includes('open')
        ? { ok: true, stderr: '', stdout: JSON.stringify([ghRow(10)]) }
        : { ok: false, stdout: '', stderr: 'boom' };
    expect(await cmdFleetPrHygiene(['--json'], { gh, prompts: async () => { throw new Error('no dir'); }, now: () => NOW })).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report.reads).toEqual({ open: 'ok', merged: 'failed', prompts: 'unavailable' });
    expect(report.items[0]).toMatchObject({ number: 10, triage: 'ok' });
  });

  it('reports an unreadable open list as failed, never a clean backlog', async () => {
    const gh: NonNullable<FleetPrHygieneDeps['gh']> = async () => ({ ok: false, stdout: '', stderr: 'boom' });
    expect(await cmdFleetPrHygiene(['--json'], { gh, now: () => NOW })).toBe(1);
    const report = JSON.parse(output[0]!);
    expect(report).toMatchObject({ schema: 'fleet.pr-hygiene.v1', reads: { open: 'failed' }, items: [], error: 'gh-pr-list-failed' });
    expect(await cmdFleetPrHygiene([], { gh, now: () => NOW })).toBe(1);
    expect(errors).toContain('fleet pr-hygiene: could not read open PRs');
    expect(output).toHaveLength(1); // text mode writes only stderr on failure — no fake-clean report
  });

  it('prints flagged PRs in text mode with their triage lane', async () => {
    const gh = ghOk([ghRow(10, { mergeStateStatus: 'DIRTY' }), ghRow(11)]);
    expect(await cmdFleetPrHygiene([], {
      gh,
      prompts: async () => new Map([['RQ-FAKE-1', 'Rebuild PR #10.']]),
      now: () => NOW,
    })).toBe(0);
    expect(output[0]).toContain('2 open, 1 flagged');
    expect(output[1]).toContain('refix');
    expect(output[1]).toContain('#10');
    expect(output.at(-1)).toBe('Unflagged: 1');
  });
});
