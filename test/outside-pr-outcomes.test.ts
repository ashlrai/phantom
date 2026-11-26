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
 *   - agent is convention attribution only (recorded branch/login
 *     convention, null when unmatched); model is always null — gh records
 *     no model.
 *   - No path, URL, token or hostname is ever emitted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listOutsidePrOutcomes,
  outsidePrAgentAttribution,
  type ListOutsidePrOutcomesOptions,
} from '../src/core/fleet/outside-pr-outcomes.js';
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
    expect(byNumber.get(7)).toMatchObject({ author: 'ext-dev', agent: null, model: null, reverted: 'no', mergedAt: '2026-11-15T00:00:00.000Z' });
    expect(byNumber.get(11)).toMatchObject({ author: 'other-dev', reverted: 'yes' });
    // A reland clears the standing revert: newest record wins.
    expect(byNumber.get(12)).toMatchObject({ author: 'other-dev', reverted: 'no' });
    expect(byNumber.get(13)).toMatchObject({ author: null, reverted: 'no' });
    // Author rollup stays per-login: agent/model are always null there —
    // one login pushes work for many agents.
    expect(result.authors).toEqual([
      { author: 'other-dev', agent: null, model: null, prs: 2, reverted: 1 },
      { author: null, agent: null, model: null, prs: 1, reverted: 0 },
      { author: 'ext-dev', agent: null, model: null, prs: 1, reverted: 0 },
    ]);
    // Agent rollup: none of these heads/logins match a known convention,
    // so every PR lands in the honest unattributed bucket.
    expect(result.agents).toEqual([
      { agent: null, model: null, prs: 4, reverted: 1 },
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

  it('attributes agent by recorded branch/login convention and rolls up per agent', async () => {
    const rows = [
      { number: 20, title: 'devin session', author: { login: 'ext-dev' }, headRefName: 'devin/1700000000-fix-thing', mergedAt: '2026-11-15T00:00:00Z' },
      { number: 21, title: 'cursor session', author: { login: 'ext-dev' }, headRefName: 'cursor/fix-x-a1b2', mergedAt: '2026-11-14T00:00:00Z' },
      { number: 22, title: 'fleet devin task', author: { login: 'ext-dev' }, headRefName: 'ashlr-devin/task-9', mergedAt: '2026-11-13T00:00:00Z' },
      { number: 23, title: 'devin bot', author: { login: 'devin-ai-integration[bot]' }, headRefName: 'fix/bot-branch', mergedAt: '2026-11-12T00:00:00Z' },
      { number: 24, title: 'human branch', author: { login: 'ext-dev' }, headRefName: 'feat/plain', mergedAt: '2026-11-11T00:00:00Z' },
    ];
    // #21 carries a standing revert so the agents tally shows a nonzero reverted count.
    const ledgerPath = join(scratch, 'improve', 'revert-outcomes.jsonl');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(scratch, 'improve'), { recursive: true });
    await recordRevertOutcomes([revertRecord(21)], { path: ledgerPath, now: NOW });
    const result = await listOutsidePrOutcomes(await fixtureOpts({
      gh: fakeGh(rows), revertLedgerPath: ledgerPath,
    }));
    const byNumber = new Map(result.repos[0]!.prs.map((pr) => [pr.number, pr]));
    expect(byNumber.get(20)).toMatchObject({ agent: 'devin', model: null });
    expect(byNumber.get(21)).toMatchObject({ agent: 'cursor', model: null, reverted: 'yes' });
    expect(byNumber.get(22)).toMatchObject({ agent: 'devin' });
    expect(byNumber.get(23)).toMatchObject({ agent: 'devin' });
    expect(byNumber.get(24)).toMatchObject({ agent: null, model: null });
    // Sort: prs desc, then agent name with the unattributed (null) bucket
    // first on ties — the same convention the authors rollup applies.
    expect(result.agents).toEqual([
      { agent: 'devin', model: null, prs: 3, reverted: 0 },
      { agent: null, model: null, prs: 1, reverted: 0 },
      { agent: 'cursor', model: null, prs: 1, reverted: 1 },
    ]);
  });
});

describe('outsidePrAgentAttribution', () => {
  it('matches known branch namespaces case-insensitively and requires the slash', () => {
    expect(outsidePrAgentAttribution('devin/1700000000-x', 'ext-dev')).toBe('devin');
    expect(outsidePrAgentAttribution('Devin/1700000000-x', 'ext-dev')).toBe('devin');
    expect(outsidePrAgentAttribution('cursor/fix-x-a1b2', null)).toBe('cursor');
    expect(outsidePrAgentAttribution('claude/feat-x', 'ext-dev')).toBe('claude');
    expect(outsidePrAgentAttribution('copilot/fix-x', 'ext-dev')).toBe('copilot');
    // A bare product name is not the namespace convention.
    expect(outsidePrAgentAttribution('devin', 'ext-dev')).toBeNull();
    // Human conventions and unknown prefixes stay unattributed.
    expect(outsidePrAgentAttribution('fix/thing', 'ext-dev')).toBeNull();
    expect(outsidePrAgentAttribution('feat/x', 'some-agent')).toBeNull();
  });

  it('falls back to known agent-bot author logins, branch winning first', () => {
    expect(outsidePrAgentAttribution('fix/x', 'devin-ai-integration[bot]')).toBe('devin');
    expect(outsidePrAgentAttribution('fix/x', 'App/Devin-AI-Integration')).toBe('devin');
    expect(outsidePrAgentAttribution('fix/x', 'chatgpt-codex-connector[bot]')).toBe('codex');
    expect(outsidePrAgentAttribution('fix/x', 'app/dependabot')).toBe('dependabot');
    // Branch evidence outranks the login: a devin bot author on a cursor branch is cursor work.
    expect(outsidePrAgentAttribution('cursor/x-a1b2', 'devin-ai-integration[bot]')).toBe('cursor');
    // Human logins and ghost authors never attribute on their own.
    expect(outsidePrAgentAttribution('fix/x', 'ext-dev')).toBeNull();
    expect(outsidePrAgentAttribution('fix/x', null)).toBeNull();
    expect(outsidePrAgentAttribution('fix/x', 'github-actions[bot]')).toBeNull();
  });
});
