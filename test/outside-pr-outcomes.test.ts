/**
 * outside-pr-outcomes — merged-PR outcome metrics for non-fleet work.
 *
 * Contract:
 *   - Per repo in the fleet repo set (running jobs' repos + workspace),
 *     recently-merged PRs whose head is not `codex-bridge/*` and whose
 *     author is not the fleet App are listed with a reverted verdict joined
 *     against the standing revert ledger (`owner/name#N` keys).
 *   - gh absent → sourceState 'missing'; an unreadable revert ledger marks
 *     every verdict 'unknown', never "not reverted"; a missing ledger is an
 *     honest empty evidence set.
 *   - agent/model are always null — gh records only the author login.
 *   - No path, URL, token or hostname is ever emitted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listOutsidePrOutcomes, type ListOutsidePrOutcomesOptions } from '../src/core/fleet/outside-pr-outcomes.js';
import { recordRevertOutcomes } from '../src/core/improve/revert-ledger.js';
import type { RevertOutcomeRecord } from '../src/core/improve/reverted.js';

let scratch: string;
const NOW = new Date('2026-11-20T12:00:00Z');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'outside-pr-outcomes-'));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function revertRecord(number: number, relandedBy: string | null = null): RevertOutcomeRecord {
  return {
    repository: 'acme/widgets', number, pr: `acme/widgets#${number}`,
    mergeSha: SHA_A, mergedAt: '2026-11-10T00:00:00Z',
    revertedBy: SHA_B, revertedAt: '2026-11-11T00:00:00Z',
    revertLatencyMs: 86_400_000, relandedBy,
  };
}

const MERGED_ROWS = [
  { number: 7, title: 'outside fix', author: { login: 'ext-dev' }, headRefName: 'fix/thing', mergedAt: '2026-11-15T00:00:00Z' },
  { number: 8, title: 'fleet bridge', author: { login: 'ext-dev' }, headRefName: 'codex-bridge/RQ-FAKE-1', mergedAt: '2026-11-16T00:00:00Z' },
  { number: 9, title: 'fleet bot', author: { login: 'ashlr-fleet[bot]' }, headRefName: 'fix/bot', mergedAt: '2026-11-16T00:00:00Z' },
  { number: 10, title: 'old outside', author: { login: 'ext-dev' }, headRefName: 'old/branch', mergedAt: '2026-09-01T00:00:00Z' },
  { number: 11, title: 'reverted outside', author: { login: 'other-dev' }, headRefName: 'feat/x', mergedAt: '2026-11-14T00:00:00Z' },
  { number: 12, title: 'relanded outside', author: { login: 'other-dev' }, headRefName: 'feat/y', mergedAt: '2026-11-13T00:00:00Z' },
  { number: 13, title: 'ghost author', author: null, headRefName: 'feat/z', mergedAt: '2026-11-12T00:00:00Z' },
];

function fakeGh(rows: unknown = MERGED_ROWS): NonNullable<ListOutsidePrOutcomesOptions['gh']> {
  return async (_cwd, args) => {
    const key = args.join(' ');
    if (key === '--version') return 'gh version 2.99.0';
    if (key.startsWith('pr list')) return JSON.stringify(rows);
    return null;
  };
}

async function fixtureOpts(extra: Partial<ListOutsidePrOutcomesOptions> = {}): Promise<ListOutsidePrOutcomesOptions> {
  const ledgerPath = join(scratch, 'improve', 'revert-outcomes.jsonl');
  await recordRevertOutcomes([revertRecord(11), revertRecord(12, SHA_A)], { path: ledgerPath, now: NOW });
  return {
    runsDir: join(scratch, 'runs-empty'),
    homeDir: scratch,
    workspaceDir: scratch,
    gh: fakeGh(),
    runningJobs: () => [],
    repoIdentity: () => 'acme/widgets',
    revertLedgerPath: ledgerPath,
    now: () => NOW,
    ...extra,
  };
}

describe('listOutsidePrOutcomes', () => {
  it('lists merged outside PRs in-window, joined to the standing revert set', async () => {
    const result = await listOutsidePrOutcomes(await fixtureOpts());
    expect(result.v).toBe(1);
    expect(result.sourceState).toBe('healthy');
    expect(result.revertLedger).toBe('read');
    expect(result.windowDays).toBe(30);
    expect(result.since).toBe('2026-10-21T12:00:00.000Z');
    expect(result.repos).toHaveLength(1);
    const repo = result.repos[0]!;
    expect(repo).toMatchObject({ repo: 'acme/widgets', state: 'healthy', listed: 7, hitLimit: false });
    // Fleet-branch, fleet-bot and out-of-window rows are excluded; mergedAt desc.
    expect(repo.prs.map((pr) => pr.number)).toEqual([7, 11, 12, 13]);
    const byNumber = new Map(repo.prs.map((pr) => [pr.number, pr]));
    expect(byNumber.get(7)).toMatchObject({ author: 'ext-dev', reverted: 'no', mergedAt: '2026-11-15T00:00:00.000Z' });
    expect(byNumber.get(11)).toMatchObject({ author: 'other-dev', reverted: 'yes' });
    // A reland clears the standing revert: newest record wins.
    expect(byNumber.get(12)).toMatchObject({ author: 'other-dev', reverted: 'no' });
    expect(byNumber.get(13)).toMatchObject({ author: null, reverted: 'no' });
    // Author rollup: agent/model are always null — gh never records them.
    expect(result.authors).toEqual([
      { author: 'other-dev', agent: null, model: null, prs: 2, reverted: 1 },
      { author: null, agent: null, model: null, prs: 1, reverted: 0 },
      { author: 'ext-dev', agent: null, model: null, prs: 1, reverted: 0 },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/scratch|\/Users\/|github\.com|ghp_|token/i);
  });

  it('returns missing when gh cannot run at all', async () => {
    const result = await listOutsidePrOutcomes(await fixtureOpts({ gh: async () => null }));
    expect(result).toMatchObject({ sourceState: 'missing', repos: [], authors: [], revertLedger: 'read' });
  });

  it('marks every verdict unknown when the revert ledger is unreadable', async () => {
    const bad = join(scratch, 'improve', 'corrupt.jsonl');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(scratch, 'improve'), { recursive: true });
    await writeFile(bad, 'not json\n');
    const result = await listOutsidePrOutcomes(await fixtureOpts({ revertLedgerPath: bad }));
    expect(result.revertLedger).toBe('unreadable');
    expect(result.repos[0]!.prs.every((pr) => pr.reverted === 'unknown')).toBe(true);
    expect(result.authors.every((a) => a.reverted === 0)).toBe(true);
  });

  it('treats a missing revert ledger as honest empty evidence', async () => {
    const result = await listOutsidePrOutcomes(await fixtureOpts({ revertLedgerPath: join(scratch, 'nope.jsonl') }));
    expect(result.revertLedger).toBe('missing');
    expect(result.repos[0]!.prs.every((pr) => pr.reverted === 'no')).toBe(true);
  });

  it('degrades per-repo when gh returns an unparseable list', async () => {
    const gh: NonNullable<ListOutsidePrOutcomesOptions['gh']> = async (_cwd, args) =>
      args.join(' ') === '--version' ? 'gh version 2.99.0' : 'garbage';
    const result = await listOutsidePrOutcomes(await fixtureOpts({ gh }));
    expect(result.sourceState).toBe('degraded');
    expect(result.repos[0]).toMatchObject({ state: 'degraded', prs: [] });
  });

  it('honours --days window and drops malformed rows', async () => {
    const rows = [
      ...MERGED_ROWS,
      { number: 'x', title: 'bad', headRefName: 'a', mergedAt: '2026-11-01T00:00:00Z' },
      { number: 14, title: 'no merge time', headRefName: 'a', mergedAt: null },
    ];
    const result = await listOutsidePrOutcomes(await fixtureOpts({ gh: fakeGh(rows), days: 120 }));
    expect(result.windowDays).toBe(120);
    expect(result.repos[0]!.listed).toBe(7);
    expect(result.repos[0]!.prs.some((pr) => pr.number === 10)).toBe(true);
    expect(result.repos[0]!.prs.every((pr) => typeof pr.number === 'number')).toBe(true);
  });
});
