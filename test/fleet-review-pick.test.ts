import { describe, expect, it } from 'vitest';
import { cmdFleetReviewPick } from '../src/cli/fleet-review-pick.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import {
  pickUnownedReview,
  parseReviewPickPrs,
  readReviewPick,
  type ReviewPickClaims,
  type ReviewPickPr,
} from '../src/core/fleet/review-pick.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import type { BusWorkClaimView } from '../src/core/fleet/bus-work-claims.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const NOW = Date.parse('2026-11-14T16:00:00Z');
const ISO = '2026-11-14T16:00:00.000Z';
const REPO = 'ashlrai/phantom';

let seq = 0;
function pr(over: Partial<ReviewPickPr> = {}): ReviewPickPr {
  seq += 1;
  return {
    number: 900000 + seq,
    headSha: `fakesha${String(seq).padStart(34, '0')}`.slice(0, 40),
    headRef: `codex-bridge/RQ-FAKE-${seq}`,
    title: `bridge: RQ-FAKE-${seq}`,
    isDraft: false,
    mergeStateStatus: 'CLEAN',
    updatedAt: '2026-11-14T10:00:00Z',
    ...over,
  };
}

const emptyBoard = (state: FleetBoard['state'] = 'known'): FleetBoard => ({
  schema: 'fleet.coordination.v1', state, claims: [], messages: [], proposals: [], expiredClaims: 0,
});
const emptyWorkers = (sourceState: LiveWorkersSnapshot['sourceState'] = 'healthy'): LiveWorkersSnapshot => ({
  v: 1, generatedAt: ISO, sourceState, workers: [], leaders: [], orchestratorAgents: 0,
});
const emptyClaims = (): ReviewPickClaims => ({
  claimedTsv: { state: 'healthy', claims: [] },
  busWork: { source: 'available', claims: [] },
  board: emptyBoard(),
  liveWorkers: emptyWorkers(),
});
const tsvClaim = (job: string, lane = 'codex-local') => ({ job, lane, tier: 'work', at: '2026-11-14T15:00:00Z' });
const busClaim = (id: string, over: Partial<BusWorkClaimView> = {}): BusWorkClaimView => ({
  id, cursor: 1, receivedAt: NOW - 60_000, owner: 'devin', leaseUntil: NOW + 60_000, completedAt: null, ...over,
});
const boardClaim = (task: string, over: Partial<FleetClaim> = {}): FleetClaim => ({
  id: 'claim-fake-1', repo: REPO, task, agent: 'claude', claimedAt: NOW - 60_000, expiresAt: NOW + 60_000, ...over,
});

const pick = (prs: ReviewPickPr[], claims: ReviewPickClaims = emptyClaims()) =>
  pickUnownedReview({ repo: REPO, prs, claims, now: NOW });

describe('pickUnownedReview', () => {
  it('picks the only unowned non-draft PR and reports owner none', () => {
    const owned = pr({ number: 900001, headRef: 'codex-bridge/RQ-FAKE-1', title: 'bridge: RQ-FAKE-1' });
    const free = pr({ number: 900002, headRef: 'codex-bridge/RQ-FAKE-2', title: 'bridge: RQ-FAKE-2' });
    const claims = emptyClaims();
    claims.claimedTsv.claims.push(tsvClaim('RQ-FAKE-1'));
    const result = pick([owned, free], claims);
    expect(result.picked).toMatchObject({ repo: REPO, pr: 900002, head: 'codex-bridge/RQ-FAKE-2', owner: 'none' });
    expect(result.skipped).toEqual([{ pr: 900001, owner: 'codex-local', why: "live claim 'RQ-FAKE-1' via claimed-tsv" }]);
  });

  it('returns null when every PR is claimed and names each owner in skipped', () => {
    const a = pr({ number: 900011, headRef: 'codex-bridge/RQ-FAKE-11', title: 'bridge: RQ-FAKE-11' });
    const b = pr({ number: 900012, headRef: 'codex-bridge/RQ-FAKE-12', title: 'bridge: RQ-FAKE-12' });
    const claims = emptyClaims();
    claims.claimedTsv.claims.push(tsvClaim('RQ-FAKE-11'));
    claims.busWork.claims.push(busClaim('RQ-FAKE-12', { owner: 'gemini' }));
    const result = pick([a, b], claims);
    expect(result.picked).toBeNull();
    expect(result.reason).toBe('no unowned non-draft open PRs');
    expect(result.skipped).toEqual([
      { pr: 900011, owner: 'codex-local', why: "live claim 'RQ-FAKE-11' via claimed-tsv" },
      { pr: 900012, owner: 'gemini', why: "live claim 'RQ-FAKE-12' via bus-work-claims" },
    ]);
  });

  it('counts a claim that names only the RQ id found in the branch', () => {
    const row = pr({ number: 900021, headRef: 'codex-bridge/RQ-FAKE-21', title: 'unrelated title' });
    const claims = emptyClaims();
    claims.claimedTsv.claims.push(tsvClaim('RQ-FAKE-21'));
    const result = pick([row], claims);
    expect(result.picked).toBeNull();
    expect(result.skipped[0]).toMatchObject({ pr: 900021, owner: 'codex-local' });
  });

  it('counts a coordination claim naming the PR number, a running worker, and ignores expired claims', () => {
    const byNumber = pr({ number: 900031 });
    const byWorker = pr({ number: 900032, headRef: 'codex-bridge/RQ-FAKE-32', title: 'bridge: RQ-FAKE-32' });
    const stale = pr({ number: 900033, headRef: 'codex-bridge/RQ-FAKE-33', title: 'bridge: RQ-FAKE-33' });
    const claims = emptyClaims();
    claims.board.claims.push(boardClaim('review #900031'));
    claims.liveWorkers.workers.push({ pid: 4321, job: 'RQ-FAKE-32', repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 60 });
    claims.busWork.claims.push(busClaim('RQ-FAKE-33', { leaseUntil: NOW - 1 }));
    const result = pick([byNumber, byWorker, stale], claims);
    expect(result.picked).toMatchObject({ pr: 900033, owner: 'none' });
    expect(result.skipped.map(s => s.pr)).toEqual([900031, 900032]);
    expect(result.skipped[0]).toMatchObject({ owner: 'claude', why: "live claim '#900031' via coordination" });
    expect(result.skipped[1]).toMatchObject({ owner: 'devin', why: "running worker 'RQ-FAKE-32' via live-workers" });
  });

  it('ignores an expired coordination claim and a completed bus claim', () => {
    const a = pr({ number: 900041, headRef: 'codex-bridge/RQ-FAKE-41', title: 'bridge: RQ-FAKE-41' });
    const b = pr({ number: 900042, headRef: 'codex-bridge/RQ-FAKE-42', title: 'bridge: RQ-FAKE-42' });
    const claims = emptyClaims();
    claims.board.claims.push(boardClaim('RQ-FAKE-41', { expiresAt: NOW - 1 }));
    claims.busWork.claims.push(busClaim('RQ-FAKE-42', { completedAt: NOW - 1 }));
    const result = pick([a, b], claims);
    expect(result.picked).not.toBeNull();
    expect(result.skipped).toEqual([]);
  });

  it('refuses to pick when a claims source is unreadable, and never says owner none', () => {
    const row = pr({ number: 900051 });
    const claims = emptyClaims();
    claims.busWork = { source: 'unavailable', claims: [] };
    const result = pick([row], claims);
    expect(result.picked).toBeNull();
    expect(result.reason).toBe('ownership source unavailable');
    expect(result.source.unavailable).toEqual(['bus-work-claims']);
    expect(result.source.claims['bus-work-claims']).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('"none"');
  });

  it('treats an unknown coordination board as unreadable', () => {
    const claims = emptyClaims();
    claims.board = emptyBoard('unknown');
    const result = pick([pr({ number: 900061 })], claims);
    expect(result.picked).toBeNull();
    expect(result.source.unavailable).toContain('coordination');
  });

  it('never picks a draft and prefers CLEAN over DIRTY then oldest update', () => {
    const draft = pr({ number: 900071, isDraft: true, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-10T00:00:00Z' });
    const dirty = pr({ number: 900072, mergeStateStatus: 'DIRTY', updatedAt: '2026-11-01T00:00:00Z' });
    const clean = pr({ number: 900073, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-12T00:00:00Z' });
    const olderClean = pr({ number: 900074, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-11T00:00:00Z' });
    const blocked = pr({ number: 900075, mergeStateStatus: 'BLOCKED', updatedAt: '2026-11-13T00:00:00Z' });
    const result = pick([draft, dirty, clean, olderClean, blocked]);
    expect(result.picked).toMatchObject({ pr: 900074 });
    expect(result.skipped).toEqual([{ pr: 900071, owner: null, why: 'draft' }]);
    expect(result.unowned_candidates).toBe(4);
  });

  it('orders BLOCKED/UNSTABLE ahead of DIRTY', () => {
    const dirty = pr({ number: 900081, mergeStateStatus: 'DIRTY', updatedAt: '2026-11-01T00:00:00Z' });
    const unstable = pr({ number: 900082, mergeStateStatus: 'UNSTABLE', updatedAt: '2026-11-13T00:00:00Z' });
    expect(pick([dirty, unstable]).picked).toMatchObject({ pr: 900082 });
  });
});

describe('readReviewPick', () => {
  const deps = (prs: unknown[], claims: ReviewPickClaims = emptyClaims()) => ({
    gh: async () => ({ ok: true, stdout: JSON.stringify(prs), stderr: '' }),
    readClaimedTsv: async () => ({ state: claims.claimedTsv.state, text: '' }),
    inspectBusWork: () => claims.busWork,
    readBoard: () => claims.board,
    listWorkers: async () => claims.liveWorkers,
    now: () => NOW,
  });

  it('collects gh rows and sources into one report', async () => {
    const rows = [
      { number: 900091, title: 'bridge: RQ-FAKE-91', headRefName: 'codex-bridge/RQ-FAKE-91', headRefOid: 'a'.repeat(40), isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-14T09:00:00Z' },
    ];
    const report = await readReviewPick({ repo: REPO, ...deps(rows) });
    expect(report.source.prs).toBe('read');
    expect(report.picked).toMatchObject({ repo: REPO, pr: 900091, owner: 'none' });
  });

  it('reports pr source unavailable without inventing a pick', async () => {
    const report = await readReviewPick({
      repo: REPO,
      gh: async () => ({ ok: false, stdout: '', stderr: 'boom' }),
      readClaimedTsv: async () => ({ state: 'missing' as const, text: '' }),
      inspectBusWork: () => ({ source: 'missing' as const, claims: [] }),
      readBoard: () => emptyBoard(),
      listWorkers: async () => emptyWorkers(),
      now: () => NOW,
    });
    expect(report.picked).toBeNull();
    expect(report.reason).toBe('pr source unavailable');
    expect(report.source.prs).toBe('unavailable');
  });
});

describe('cmdFleetReviewPick', () => {
  const fakeGhPage = [
    { number: 900101, title: 'bridge: RQ-FAKE-101', headRefName: 'codex-bridge/RQ-FAKE-101', headRefOid: 'b'.repeat(40), isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-14T09:00:00Z' },
    { number: 900102, title: 'bridge: RQ-FAKE-102', headRefName: 'codex-bridge/RQ-FAKE-102', headRefOid: 'c'.repeat(40), isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-14T08:00:00Z' },
  ];
  const cliDeps = (stdoutText: string) => ({
    gh: async (args: string[]) => {
      expect(args).toContain('pr');
      expect(args).toContain(REPO);
      return { ok: true, stdout: stdoutText, stderr: '' };
    },
    readClaimedTsv: async () => ({ state: 'healthy' as const, text: 'RQ-FAKE-101\tcodex-local\twork\t15:00\t1763166000\n' }),
    inspectBusWork: () => ({ source: 'available' as const, claims: [] }),
    readBoard: () => emptyBoard(),
    listWorkers: async () => emptyWorkers(),
    now: () => NOW,
  });

  it('prints one line per field and JSON matching the model', async () => {
    const outs: string[] = [];
    const code = await cmdFleetReviewPick([], { ...cliDeps(JSON.stringify(fakeGhPage)), stdout: t => outs.push(t), stderr: t => outs.push(`ERR:${t}`) });
    expect(code).toBe(0);
    const text = outs.join('');
    expect(text).toContain('repo: ashlrai/phantom');
    expect(text).toContain('pr: 900102');
    expect(text).toContain('owner: none');
    expect(text).toContain('head: codex-bridge/RQ-FAKE-102');

    const jsonOuts: string[] = [];
    const code2 = await cmdFleetReviewPick(['--json'], { ...cliDeps(JSON.stringify(fakeGhPage)), stdout: t => jsonOuts.push(t), stderr: () => undefined });
    expect(code2).toBe(0);
    const report = JSON.parse(jsonOuts.join('')) as ReturnType<typeof pickUnownedReview>;
    expect(report.schema).toBe('fleet.review-pick.v1');
    expect(report.picked).toMatchObject({ pr: 900102, head: 'codex-bridge/RQ-FAKE-102', owner: 'none' });
    expect(report.skipped).toEqual([{ pr: 900101, owner: 'codex-local', why: "live claim 'RQ-FAKE-101' via claimed-tsv" }]);
    expect(report.source.unavailable).toEqual([]);
  });

  it('exits 1 when a source is unavailable and never prints owner none', async () => {
    const outs: string[] = [];
    const code = await cmdFleetReviewPick(['--json'], {
      ...cliDeps(JSON.stringify(fakeGhPage)),
      inspectBusWork: () => ({ source: 'unavailable' as const, claims: [] }),
      stdout: t => outs.push(t), stderr: () => undefined,
    });
    expect(code).toBe(1);
    const report = JSON.parse(outs.join('')) as ReturnType<typeof pickUnownedReview>;
    expect(report.picked).toBeNull();
    expect(report.reason).toBe('ownership source unavailable');
    expect(outs.join('')).not.toContain('"none"');
  });

  it('registers in the fleet subcommand registry and prints usage', async () => {
    expect(typeof FLEET_SUBCOMMAND_LOADERS['review-pick']).toBe('function');
    const loaded = await FLEET_SUBCOMMAND_LOADERS['review-pick']!();
    expect(loaded['cmdFleetReviewPick']).toBe(cmdFleetReviewPick);
    const outs: string[] = [];
    expect(await cmdFleetReviewPick(['--help'], { stdout: t => outs.push(t) })).toBe(0);
    expect(outs.join('')).toContain('review-pick');
    expect(await cmdFleetReviewPick(['--repo', 'not-a-repo'], { stderr: t => outs.push(t) })).toBe(2);
  });
});

describe('parseReviewPickPrs', () => {
  it('drops malformed rows and rejects non-arrays', () => {
    expect(parseReviewPickPrs({})).toBeNull();
    const rows = parseReviewPickPrs([
      { number: 900201, title: 't', headRefName: 'h', headRefOid: 's', isDraft: false, mergeStateStatus: 'clean', updatedAt: 'u' },
      { number: 'nope' },
      null,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows![0]).toMatchObject({ number: 900201, mergeStateStatus: 'CLEAN' });
  });
});
