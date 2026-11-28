import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendLedger,
  readLedger,
  scoreOutcomes,
  type LedgerEvent,
  type LedgerRecord,
  type MetricSpec,
} from '../src/core/improve/outcomes.js';
import { fetchPrMergeBase, syncImproveMeasurements, IMPROVE_MEASURE_RETRY_MS } from '../src/core/improve/measure-sync.js';
import type { PrSnapshot } from '../src/core/improve/promote.js';

const BASE = 'a'.repeat(40);
const HEAD1 = 'b'.repeat(40);
const HEAD2 = 'c'.repeat(40);
const metric: MetricSpec = { name: 'gate-ms', direction: 'decrease', runner: { kind: 'npm', script: 'bench:gate' } };
const REPO = 'ashlrai/phantom';

let dir: string;
let ledgerPath: string;
let repoDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'phm-measure-sync-'));
  ledgerPath = join(dir, 'outcomes.jsonl');
  // A real git checkout whose origin is the proposal repository: assertOriginIs
  // runs for real inside the pass, everything else is injected.
  fs.mkdirSync(join(dir, 'checkout'));
  repoDir = fs.realpathSync(join(dir, 'checkout'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  git(['init', '-q', '-b', 'master']);
  git(['remote', 'add', 'origin', `https://github.com/${REPO}.git`]);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const records = (): LedgerRecord[] => readLedger(ledgerPath).records;
const reg = (id: string, pr = 5): LedgerEvent[] => [
  { type: 'registered', proposalId: id, title: `Proposal ${id}`, proposalKind: 'perf', source: { kind: 'deterministic', rule: 'test' }, metric, predictedDelta: null },
  { type: 'pr', proposalId: id, repository: REPO, number: pr },
];
const write = (...events: LedgerEvent[]) => { for (const e of events) appendLedger(e, { path: ledgerPath }); };

const snap = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  number: 5, state: 'OPEN', isDraft: false, isCrossRepository: false,
  headRefName: 'improve/x', headRefOid: HEAD1, baseRefName: 'master', checks: [], ...over,
});

const sync = (deps: Parameters<typeof syncImproveMeasurements>[0] = {}) =>
  syncImproveMeasurements({
    ledger: () => readLedger(ledgerPath),
    append: (e) => appendLedger(e, { path: ledgerPath }),
    checkoutFor: () => repoDir,
    readPr: () => snap(),
    defaultBranch: () => 'master',
    mergeBase: async () => BASE,
    measure: async (_repoDir, sha) => ({ sha, value: sha === BASE ? 100 : 40, reason: null }),
    repeat: 1,
    ...deps,
  });

describe('syncImproveMeasurements', () => {
  it('measures a registered proposal with a live PR at base and head, once', async () => {
    write(...reg('1111111111'));
    const first = await sync();
    expect(first).toMatchObject({ intact: true, measured: 1, appended: 2, looked: 1 });
    const measured = records().filter((r): r is LedgerRecord & { type: 'measured' } => r.type === 'measured');
    expect(measured.map((m) => [m.phase, m.sha, m.value])).toEqual([['base', BASE, 100], ['head', HEAD1, 40]]);
    // A second pass over unchanged evidence appends nothing.
    const second = await sync();
    expect(second).toMatchObject({ measured: 0, appended: 0, skipped: { current: 1 } });
    expect(scoreOutcomes(records()).find((o) => o.proposalId === '1111111111')?.status).toBe('improved');
  });

  it('skips a proposal with no fleet checkout', async () => {
    write(...reg('1111111111'));
    const res = await sync({ checkoutFor: () => null });
    expect(res).toMatchObject({ measured: 0, appended: 0, looked: 0, skipped: { noCheckout: 1 } });
  });

  it('skips a closed PR and a proposal standing reverted', async () => {
    write(...reg('1111111111'), ...reg('2222222222', 6));
    write({ type: 'observed', proposalId: '2222222222', observation: 'merged', sha: HEAD1 },
      { type: 'observed', proposalId: '2222222222', observation: 'reverted', sha: HEAD2 });
    const res = await sync({ readPr: () => snap({ state: 'CLOSED' }) });
    // 1111111111's PR closed before measuring; 2222222222 stands reverted and never reaches the lookup.
    expect(res).toMatchObject({ measured: 0, appended: 0, looked: 1, skipped: { closed: 1 } });
  });

  it('re-measures only the head when the PR head moved and base still scores', async () => {
    write(...reg('1111111111'),
      { type: 'measured', proposalId: '1111111111', phase: 'base', sha: BASE, value: 100, reason: null },
      { type: 'measured', proposalId: '1111111111', phase: 'head', sha: HEAD1, value: 40, reason: null });
    const res = await sync({ readPr: () => snap({ headRefOid: HEAD2 }) });
    expect(res).toMatchObject({ measured: 1, appended: 1 });
    expect(records().at(-1)).toMatchObject({ type: 'measured', phase: 'head', sha: HEAD2, value: 40 });
  });

  it('re-measures a scored-unknown phase only after the retry window', async () => {
    const unknowns = (): LedgerEvent[] => [
      ...reg('1111111111'),
      { type: 'measured', proposalId: '1111111111', phase: 'base', sha: BASE, value: null, reason: 'npm ci failed' },
      { type: 'measured', proposalId: '1111111111', phase: 'head', sha: HEAD1, value: null, reason: 'npm ci failed' },
    ];
    // Fresh unknowns are not retried inside the window.
    write(...unknowns());
    const fresh = await sync();
    expect(fresh).toMatchObject({ measured: 0, appended: 0, skipped: { current: 1 } });
    // The same evidence stamped past the retry window is tried again.
    fs.rmSync(ledgerPath);
    write(...reg('1111111111'));
    const staleAt = new Date(Date.now() - IMPROVE_MEASURE_RETRY_MS - 60_000);
    for (const e of unknowns().slice(2)) appendLedger(e, { path: ledgerPath, now: staleAt });
    const stale = await sync();
    expect(stale).toMatchObject({ measured: 1, appended: 2 });
  });

  it('honours the per-pass proposal and lookup bounds', async () => {
    write(...reg('1111111111'), ...reg('2222222222', 6), ...reg('3333333333', 7));
    const res = await sync({ maxPerPass: 2 });
    expect(res.measured).toBe(2);
    expect(res.appended).toBe(4);
    expect(res.looked).toBe(2);
  });

  it('degrades without throwing: broken ledger, dead sources, failed appends', async () => {
    write(...reg('1111111111'));
    fs.appendFileSync(ledgerPath, '{"v":1,"at":"2026-11-25T00:00:00Z","prev":"bad","digest":"bad","type":"measured","proposalId":"1111111111","phase":"base","sha":"' + BASE + '","value":1,"reason":null}\n');
    const broken = await sync();
    expect(broken).toMatchObject({ intact: false, appended: 0 });
    expect(broken.reasons.length).toBeGreaterThan(0);

    fs.rmSync(ledgerPath);
    write(...reg('1111111111'));
    expect(await sync({ ledger: () => { throw new Error('store down'); } })).toMatchObject({ reason: 'source-unavailable', appended: 0 });
    expect(await sync({ append: () => { throw new Error('disk full'); } })).toMatchObject({ reason: 'append-failed' });
    // A candidate whose PR facts cannot be read is skipped, not fatal.
    const failed = await sync({ readPr: () => { throw new Error('gh down'); } });
    expect(failed).toMatchObject({ measured: 0, appended: 0, skipped: { failed: 1 } });
  });
});

describe('fetchPrMergeBase', () => {
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

  it('fetches the PR head through safe-git and resolves the exact merge base', () => {
    // A local "remote" with a master tip and a PR head ref.
    fs.mkdirSync(join(dir, 'origin'));
    const origin = fs.realpathSync(join(dir, 'origin'));
    git(origin, ['init', '-q', '-b', 'master']);
    fs.writeFileSync(join(origin, 'f.txt'), 'base\n');
    git(origin, ['add', 'f.txt']);
    git(origin, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']);
    const baseSha = git(origin, ['rev-parse', 'HEAD']).trim();
    git(origin, ['checkout', '-qb', 'feature']);
    fs.writeFileSync(join(origin, 'f.txt'), 'head\n');
    git(origin, ['commit', '-qam', 'head']);
    const headSha = git(origin, ['rev-parse', 'HEAD']).trim();
    git(origin, ['update-ref', 'refs/pull/5/head', headSha]);
    // The checkout knows the remote only as file:// — allowed solely via allowFileRemote.
    fs.mkdirSync(join(dir, 'mirror'));
    const checkout = fs.realpathSync(join(dir, 'mirror'));
    git(checkout, ['init', '-q', '-b', 'master']);
    git(checkout, ['remote', 'add', 'origin', `file://${origin}`]);
    git(checkout, ['fetch', '-q', 'origin', '+refs/heads/master:refs/remotes/origin/master']);

    expect(fetchPrMergeBase(checkout, { number: 5, headRefOid: headSha }, 'master', null, { allowFileRemote: true })).toBe(baseSha);
    // https-only by default: the same file:// remote is refused.
    expect(() => fetchPrMergeBase(checkout, { number: 5, headRefOid: headSha }, 'master', null)).toThrow(/fetch failed/);
  });
});
