import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROPOSAL_OUTCOME_BACKLOG_MAX_ITEMS,
  PROPOSAL_OUTCOME_RECURRING,
  proposalOutcomeBacklogItems,
} from '../src/core/improve/proposal-outcome-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  appendLedger,
  readLedger,
  type LedgerEvent,
} from '../src/core/improve/outcomes.js';
import {
  appendUserBacklogItems,
  readUserBacklogItems,
  validBacklogItem,
} from '../src/core/cloud/backlog.js';

vi.mock('../src/core/improve/proposal-outcome-backlog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/improve/proposal-outcome-backlog.js')>();
  return { ...actual, proposalOutcomeBacklogItems: vi.fn(actual.proposalOutcomeBacklogItems) };
});

const realFeed = (await vi.importActual<typeof import('../src/core/improve/proposal-outcome-backlog.js')>(
  '../src/core/improve/proposal-outcome-backlog.js',
)).proposalOutcomeBacklogItems;
const feedMock = vi.mocked(proposalOutcomeBacklogItems);

const REPO = 'ashlrai/phantom';
const NOW = new Date('2026-11-23T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const METRIC = { name: 'test-pass-rate', direction: 'increase' as const, runner: { kind: 'npm' as const, script: 'test' } };
const SOURCE = { kind: 'deterministic' as const, rule: 'cloud-backlog' };

const pid = (n: number): string => n.toString(16).padStart(10, '0');
const at = (daysAgo: number): Date => new Date(NOW.getTime() - daysAgo * DAY);

function registered(proposalId: string, title: string): LedgerEvent {
  return { type: 'registered', proposalId, title, proposalKind: 'test-kind', source: SOURCE, metric: METRIC, predictedDelta: null };
}
function withPr(proposalId: string, number: number): LedgerEvent {
  return { type: 'pr', proposalId, repository: 'ashlrai/phantom', number };
}
function measured(proposalId: string, phase: 'base' | 'head', sha: string, value: number | null, reason: string | null): LedgerEvent {
  return { type: 'measured', proposalId, phase, sha, value, reason };
}
function observed(proposalId: string, observation: 'merged' | 'reverted'): LedgerEvent {
  return { type: 'observed', proposalId, observation, sha: SHA_C };
}

/** Append a sequence of (event, daysAgo) pairs to the ledger at `path`. */
function seed(path: string, rows: Array<[LedgerEvent, number]>): void {
  for (const [event, daysAgo] of rows) appendLedger(event, { path, now: at(daysAgo) });
}

let previousAshlrHome: string | undefined;
let home: string;
let ledgerPath: string;

beforeEach(() => {
  feedMock.mockReset();
  feedMock.mockImplementation(realFeed);
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-proposal-outcome-backlog-'));
  process.env.ASHLR_HOME = home;
  ledgerPath = join(home, 'improve', 'outcomes.jsonl');
});

afterEach(() => {
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('proposalOutcomeBacklogItems', () => {
  it('emits nothing for a missing, empty or not-intact ledger', async () => {
    expect(await proposalOutcomeBacklogItems({ repo: REPO, now: NOW })).toEqual([]);
    expect(readLedger(ledgerPath).records).toEqual([]);
    // A broken chain marks the read not intact — degraded evidence stays quiet.
    appendLedger(registered(pid(1), 'one'), { path: ledgerPath, now: at(2) });
    const broken = readLedger(ledgerPath);
    expect(broken.intact).toBe(true);
    expect(await proposalOutcomeBacklogItems({
      repo: REPO,
      ledger: { records: broken.records, intact: false, reasons: ['chain-broken-at-line-1'] },
      now: NOW,
    })).toEqual([]);
  });

  it('gates on the fleet repository', async () => {
    seed(ledgerPath, [
      [registered(pid(1), 'stalled one'), 3], [withPr(pid(1), 101), 3],
      [registered(pid(2), 'stalled two'), 3], [withPr(pid(2), 102), 3],
      [registered(pid(3), 'stalled three'), 3], [withPr(pid(3), 103), 3],
    ]);
    expect(await proposalOutcomeBacklogItems({ repo: 'ashlrai/other-repo', now: NOW })).toEqual([]);
    const items = await proposalOutcomeBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.area).toBe('outcome-stall');
  });

  it('emits one stall item at the recurring bar of distinct unmeasured proposals', async () => {
    seed(ledgerPath, [
      [registered(pid(1), 'stalled one'), 3], [withPr(pid(1), 101), 3],
      [registered(pid(2), 'stalled two'), 4], [withPr(pid(2), 102), 4],
      [registered(pid(3), 'stalled three'), 2], [withPr(pid(3), 103), 2],
    ]);
    const items = await proposalOutcomeBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.id).toMatch(/^improve-outcome-[0-9a-f]{16}$/);
    expect(item.title).toBe('Improve outcome ledger: registered proposals never get measured');
    expect(item.area).toBe('outcome-stall');
    expect(item.priority).toBe(3);
    expect(item.repo).toBe(REPO);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain('3 registered proposal(s)');
    expect(item.prompt).toContain('no \'measured\' event');
    expect(item.prompt).toContain('syncCloudBacklogOutcomes');
    expect(item.prompt).toContain('improve/outcomes.jsonl');
    expect(item.prompt).toContain('no-change');
  });

  it('does not count fresh registrations, measured proposals, PR-less registrations or reverted observations as stalls', async () => {
    seed(ledgerPath, [
      // Two real stalls — below the bar.
      [registered(pid(1), 'stalled one'), 3], [withPr(pid(1), 101), 3],
      [registered(pid(2), 'stalled two'), 3], [withPr(pid(2), 102), 3],
      // Fresh registration inside the grace window — not yet stalled.
      [registered(pid(3), 'fresh'), 0.5], [withPr(pid(3), 103), 0.5],
      // Measured — not stalled.
      [registered(pid(4), 'measured'), 3], [withPr(pid(4), 104), 3],
      [measured(pid(4), 'base', SHA_A, 10, null), 1], [measured(pid(4), 'head', SHA_B, 12, null), 1],
      // Registered without a PR — cannot be measured yet, different stall.
      [registered(pid(5), 'no pr'), 5],
      // Reverted after merge — dead evidence, not a measurement stall.
      [registered(pid(6), 'reverted'), 5], [withPr(pid(6), 106), 5],
      [observed(pid(6), 'reverted'), 1],
    ]);
    expect(await proposalOutcomeBacklogItems({ repo: REPO, now: NOW })).toEqual([]);
  });

  it('emits one unknown-evidence item for recurring null measurements across proposals', async () => {
    seed(ledgerPath, [
      [registered(pid(1), 'runner one'), 5],
      [measured(pid(1), 'base', SHA_A, null, 'metric script test is missing at this commit'), 1],
      [measured(pid(1), 'head', SHA_B, null, 'metric script test is missing at this commit'), 1],
      [registered(pid(2), 'runner two'), 5],
      [measured(pid(2), 'base', SHA_A, null, 'checkout did not land on the requested commit'), 2],
      [measured(pid(2), 'head', SHA_B, 7, null), 2],
      [registered(pid(3), 'runner three'), 5],
      [measured(pid(3), 'base', SHA_A, null, 'standing confinement refused the run'), 1],
    ]);
    const items = await proposalOutcomeBacklogItems({ repo: REPO, now: NOW });
    const unknown = items.find((i) => i.area === 'outcome-unknown');
    expect(unknown).toBeDefined();
    expect(unknown!.title).toBe('Improve metric runners keep returning unknown');
    expect(unknown!.prompt).toContain('4 \'measured\' event(s)');
    expect(unknown!.prompt).toContain('3 distinct proposal(s)');
    expect(unknown!.prompt).toContain('metric script test is missing');
    expect(unknown!.prompt).toContain('confinement');
    expect(unknown!.prompt).toContain('measureAt');
    expect(unknown!.prompt).toContain('no-change');
  });

  it('never counts ledger records stamped past the evaluation-time future skew', async () => {
    // Null measurements all stamped beyond now + skew: corrupt or replayed
    // evidence — the unknown-measurement signal stays quiet.
    seed(ledgerPath, [
      [registered(pid(1), 'runner one'), 5],
      [measured(pid(1), 'base', SHA_A, null, 'future failure'), -1],
      [measured(pid(1), 'head', SHA_B, null, 'future failure'), -1],
      [registered(pid(2), 'runner two'), 5],
      [measured(pid(2), 'base', SHA_A, null, 'future failure'), -2],
      [registered(pid(3), 'runner three'), 5],
      [measured(pid(3), 'base', SHA_A, null, 'future failure'), -3],
    ]);
    expect(await proposalOutcomeBacklogItems({ repo: REPO, now: NOW })).toEqual([]);
    // Inside the one-minute skew the stamp still counts as same-host drift.
    seed(ledgerPath, [
      [measured(pid(1), 'head', SHA_B, null, 'skewed failure'), -0.0004],
      [measured(pid(2), 'head', SHA_B, null, 'skewed failure'), -0.0004],
      [measured(pid(3), 'head', SHA_B, null, 'skewed failure'), -0.0004],
    ]);
    const items = await proposalOutcomeBacklogItems({ repo: REPO, now: NOW });
    const unknown = items.find((i) => i.area === 'outcome-unknown');
    expect(unknown).toBeDefined();
    expect(unknown!.prompt).toContain('3 \'measured\' event(s)');
    expect(unknown!.prompt).toContain('3 distinct proposal(s)');
  });

  it('stays quiet on unknown measurements outside the window or below the proposal bar', async () => {
    seed(ledgerPath, [
      // Three null events but all older than the 7-day window.
      [registered(pid(1), 'old one'), 12],
      [measured(pid(1), 'base', SHA_A, null, 'old failure'), 10],
      [measured(pid(1), 'head', SHA_B, null, 'old failure'), 10],
      [registered(pid(2), 'old two'), 12],
      [measured(pid(2), 'base', SHA_A, null, 'old failure'), 9],
      // Three in-window null events but all on ONE proposal — below the proposal bar.
      [registered(pid(3), 'single'), 5],
      [measured(pid(3), 'base', SHA_A, null, 'runner exploded'), 1],
      [measured(pid(3), 'head', SHA_B, null, 'runner exploded'), 1],
      [measured(pid(3), 'base', SHA_C, null, 'runner exploded again'), 1],
    ]);
    expect(await proposalOutcomeBacklogItems({ repo: REPO, now: NOW })).toEqual([]);
  });

  it('emits one regressed item at the recurring bar of fresh measured regressions', async () => {
    const rows: Array<[LedgerEvent, number]> = [];
    for (const [i, title] of [[1, 'one'], [2, 'two'], [3, 'three']] as const) {
      const id = pid(i);
      rows.push(
        [registered(id, `regressed ${title}`), 6],
        [measured(id, 'base', SHA_A, 10, null), 2],
        [measured(id, 'head', SHA_B, 4, null), 2],
      );
    }
    // A fourth proposal regressed but measured outside the window — stale, never emits.
    rows.push(
      [registered(pid(9), 'stale regression'), 20],
      [measured(pid(9), 'base', SHA_A, 10, null), 10],
      [measured(pid(9), 'head', SHA_B, 4, null), 10],
    );
    // A fifth proposal improved — success needs no work.
    rows.push(
      [registered(pid(8), 'improved'), 6],
      [measured(pid(8), 'base', SHA_A, 10, null), 2],
      [measured(pid(8), 'head', SHA_B, 14, null), 2],
    );
    seed(ledgerPath, rows);
    const items = await proposalOutcomeBacklogItems({ repo: REPO, now: NOW });
    const regressed = items.filter((i) => i.area === 'outcome-regressed');
    expect(regressed).toHaveLength(1);
    expect(regressed[0]!.title).toBe('Registered improvement proposals keep regressing on their metric');
    expect(regressed[0]!.prompt).toContain('3 registered proposal(s)');
    expect(regressed[0]!.prompt).toContain('regressed one');
    expect(regressed[0]!.prompt).toContain('promote gate');
    expect(regressed[0]!.prompt).toContain('no-change');
  });

  it('emits one reverted item at the recurring bar of in-window reverts and honors the re-land rule', async () => {
    seed(ledgerPath, [
      [registered(pid(1), 'reverted one'), 8], [observed(pid(1), 'merged'), 6], [observed(pid(1), 'reverted'), 1],
      [registered(pid(2), 'reverted two'), 8], [observed(pid(2), 'reverted'), 2],
      [registered(pid(3), 'reverted three'), 8], [observed(pid(3), 'merged'), 5], [observed(pid(3), 'reverted'), 3],
      // Re-landed: a later merge observation clears the revert — never emits.
      [registered(pid(4), 'relanded'), 8], [observed(pid(4), 'reverted'), 4], [observed(pid(4), 'merged'), 1],
      // Reverted but stale — outside the window.
      [registered(pid(5), 'stale revert'), 20], [observed(pid(5), 'reverted'), 10],
    ]);
    const items = await proposalOutcomeBacklogItems({ repo: REPO, now: NOW });
    const reverted = items.filter((i) => i.area === 'outcome-reverted');
    expect(reverted).toHaveLength(1);
    expect(reverted[0]!.title).toBe('Registered improvement proposals keep merging then reverting');
    expect(reverted[0]!.prompt).toContain('3 registered proposal(s)');
    expect(reverted[0]!.prompt).toContain('reverted one');
    expect(reverted[0]!.prompt).toContain('post-merge-observations.jsonl');
    expect(reverted[0]!.prompt).toContain('no-change');
  });

  it('derives stable ids so a refresh re-adds nothing and respects the limit', async () => {
    seed(ledgerPath, [
      [registered(pid(1), 'stalled one'), 3], [withPr(pid(1), 101), 3],
      [registered(pid(2), 'stalled two'), 3], [withPr(pid(2), 102), 3],
      [registered(pid(3), 'stalled three'), 3], [withPr(pid(3), 103), 3],
    ]);
    const first = await proposalOutcomeBacklogItems({ repo: REPO, now: NOW });
    const second = await proposalOutcomeBacklogItems({ repo: REPO, now: NOW });
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const limited = await proposalOutcomeBacklogItems({ repo: REPO, now: NOW, limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it('scrubs secret-shaped text out of quoted titles and reasons', async () => {
    seed(ledgerPath, [
      [registered(pid(1), 'stalled with ghp_' + 'a'.repeat(36)), 3], [withPr(pid(1), 101), 3],
      [registered(pid(2), 'stalled two'), 3], [withPr(pid(2), 102), 3],
      [registered(pid(3), 'stalled three'), 3], [withPr(pid(3), 103), 3],
      [registered(pid(4), 'runner'), 5],
      [measured(pid(4), 'base', SHA_A, null, 'token ghp_' + 'b'.repeat(36) + ' leaked'), 1],
      [measured(pid(4), 'head', SHA_B, null, 'token ghp_' + 'b'.repeat(36) + ' leaked'), 1],
      [registered(pid(5), 'runner two'), 5],
      [measured(pid(5), 'base', SHA_A, null, 'plain failure'), 1],
    ]);
    const items = await proposalOutcomeBacklogItems({ repo: REPO, now: NOW });
    const all = items.map((i) => i.title + i.prompt).join('\n');
    expect(all).not.toContain('ghp_');
    expect(all).toContain('[REDACTED]');
  });
});

describe('proposalOutcomeBacklogItems constants', () => {
  it('exposes the documented bounds', () => {
    expect(PROPOSAL_OUTCOME_BACKLOG_MAX_ITEMS).toBeGreaterThan(0);
    expect(PROPOSAL_OUTCOME_RECURRING).toBeGreaterThanOrEqual(2);
  });
});

describe('discoverBacklog wiring', () => {
  const greenGh = async (args: string[]) => {
    const path = args[4] ?? '';
    if (path === 'repos/ashlrai/phantom') {
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
    }
    return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
  };

  it('appends feed items through discovery and dedupes on refresh', async () => {
    const sentinel = {
      id: 'improve-outcome-deadbeefdeadbeef',
      title: 'Improve outcome ledger sentinel keeps stalling',
      prompt: 'Sentinel prompt naming the outcome-ledger evidence.',
      area: 'outcome-stall',
      priority: 3 as const,
      repo: REPO,
    };
    feedMock.mockResolvedValueOnce([sentinel]);
    const first = await discoverBacklog(REPO, { gh: greenGh });
    expect(feedMock).toHaveBeenCalledWith({ repo: REPO });
    const fed = first.items.filter((item) => item.id === sentinel.id);
    expect(fed).toHaveLength(1);
    expect(first.items.every((item) => validBacklogItem(item) !== null)).toBe(true);
    expect(appendUserBacklogItems(fed)).toBe(1);
    feedMock.mockResolvedValueOnce([sentinel]);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((item) => item.id === sentinel.id))).toBe(0);
    expect(readUserBacklogItems().filter((item) => item.id === sentinel.id)).toHaveLength(1);
  });
});
