import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendLedger, rankByLeverage, readLedger, scoreOutcomes, summarizeBySource, validateMetricSpec, validateSource,
  type LedgerEvent, type MetricSpec, type ProposalOutcome } from '../src/core/improve/outcomes.js';
import { measureAt, metricEnv, parseMetricOutput } from '../src/core/improve/measure.js';
import { evaluatePromotion, normalizeChecks, queueMerge, type PrSnapshot } from '../src/core/improve/promote.js';
import { cmdImprove } from '../src/cli/improve.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const metric: MetricSpec = { name: 'eval-pass-rate', direction: 'increase', runner: { kind: 'node', path: 'scripts/metric.mjs' } };
let dir: string;
let ledger: string;
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'phm-outcomes-')); ledger = join(dir, 'outcomes.jsonl'); });
afterEach(() => { vi.restoreAllMocks(); delete process.env.ASHLR_HOME; fs.rmSync(dir, { recursive: true, force: true }); });

const reg = (id: string, over: Partial<Extract<LedgerEvent, { type: 'registered' }>> = {}): LedgerEvent =>
  ({ type: 'registered', proposalId: id, title: `Proposal ${id}`, proposalKind: 'team-feedback', source: { kind: 'deterministic', rule: 'team-feedback' }, metric, predictedDelta: null, ...over });
const m = (id: string, phase: 'base' | 'head', sha: string, value: number | null): LedgerEvent =>
  ({ type: 'measured', proposalId: id, phase, sha, value, reason: value === null ? 'script failed' : null });
const write = (...events: LedgerEvent[]) => { for (const e of events) appendLedger(e, { path: ledger }); return scoreOutcomes(readLedger(ledger).records); };

describe('outcome ledger', () => {
  it('chains records and stops at the first tampered line', () => {
    write(reg('0123456789'), m('0123456789', 'base', A, 1));
    expect(readLedger(ledger)).toMatchObject({ intact: true });
    const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n');
    fs.writeFileSync(ledger, `${lines[0]}\n${lines[1]!.replace('"value":1', '"value":9')}\n`);
    const read = readLedger(ledger);
    expect(read.intact).toBe(false);
    expect(read.records).toHaveLength(1);
    expect(() => appendLedger(m('0123456789', 'head', B, 2), { path: ledger })).toThrow(/not intact/);
  });

  it('refuses short SHAs, unknown values without a reason, unsafe runners and alias models', () => {
    expect(() => appendLedger(m('0123456789', 'base', 'abc123', 1), { path: ledger })).toThrow(/40-hex/);
    expect(() => appendLedger({ type: 'measured', proposalId: '0123456789', phase: 'base', sha: A, value: null, reason: null }, { path: ledger })).toThrow(/reason/);
    for (const path of ['../x.mjs', '/abs.mjs', '-r.mjs', 'a//b.mjs', 'x.sh']) expect(() => validateMetricSpec({ ...metric, runner: { kind: 'node', path } })).toThrow();
    expect(() => validateMetricSpec({ ...metric, runner: { kind: 'npm', script: 'test; rm -rf /' } })).toThrow();
    expect(() => validateSource({ kind: 'model', engine: 'claude', model: 'auto' })).toThrow(/exact model/);
    expect(validateSource({ kind: 'model', engine: 'codex', model: 'gpt-5.5-codex' })).toEqual({ kind: 'model', engine: 'codex', model: 'gpt-5.5-codex' });
  });
});

describe('scoring', () => {
  it('signs effect by direction and requires distinct exact commits', () => {
    const [up] = write(reg('1111111111'), m('1111111111', 'base', A, 0.5), m('1111111111', 'head', B, 0.75));
    expect(up).toMatchObject({ status: 'improved', effect: 0.25, relativeEffect: 0.5 });
    const [down] = write(reg('2222222222', { metric: { ...metric, direction: 'decrease' } }), m('2222222222', 'base', A, 10), m('2222222222', 'head', B, 12)).filter((o) => o.proposalId === '2222222222');
    expect(down).toMatchObject({ status: 'regressed', effect: -2 });
    const [same] = write(reg('3333333333'), m('3333333333', 'base', A, 1), m('3333333333', 'head', A, 2)).filter((o) => o.proposalId === '3333333333');
    expect(same.status).toBe('unknown');
  });

  it('keeps missing, failed and nondeterministic measurements unknown, never zero', () => {
    const out = write(
      reg('4444444444'), m('4444444444', 'base', A, 1),
      reg('5555555555'), m('5555555555', 'base', A, 1), m('5555555555', 'head', B, null),
      reg('6666666666'), m('6666666666', 'base', A, 1), m('6666666666', 'head', B, 2), m('6666666666', 'head', B, 3),
      m('7777777777', 'base', A, 1), m('7777777777', 'head', B, 2));
    const by = Object.fromEntries(out.map((o) => [o.proposalId, o]));
    expect(by['4444444444']).toMatchObject({ status: 'unknown', effect: null, reasons: ['head-not-measured'] });
    expect(by['5555555555']!.reasons[0]).toMatch(/head-unknown/);
    expect(by['6666666666']!.reasons).toContain('head-nondeterministic');
    expect(by['7777777777']).toBeUndefined(); // no registered hypothesis, no credit
  });

  it('compares model proposers against the deterministic baseline only with enough samples', () => {
    const events: LedgerEvent[] = [];
    const add = (id: string, src: ProposalOutcome['source'], head: number) => events.push(reg(id, { source: src }), m(id, 'base', A, 1), m(id, 'head', B, head));
    const det = { kind: 'deterministic', rule: 'team-feedback' } as const;
    const model = { kind: 'model', engine: 'claude', model: 'claude-opus-5-5' } as const;
    add('a000000001', det, 2); add('a000000002', det, 1); add('a000000003', det, 0); add('a000000004', det, 2);
    add('b000000001', model, 2); add('b000000002', model, 2); add('b000000003', model, 2);
    add('c000000001', { kind: 'model', engine: 'codex', model: 'gpt-5.5' }, 2);
    const s = Object.fromEntries(summarizeBySource(write(...events)).map((r) => [r.key, r]));
    expect(s.deterministic).toMatchObject({ measured: 4, improved: 2, regressed: 1, improvementRate: 0.5, versusDeterministic: null });
    expect(s['model:claude/claude-opus-5-5']).toMatchObject({ improvementRate: 1, versusDeterministic: 0.5 });
    expect(s['model:codex/gpt-5.5']).toMatchObject({ measured: 1, improvementRate: null, versusDeterministic: null });
  });

  it('ranks proven kinds first, unmeasured kinds next, losing kinds last', () => {
    const outcomes = write(
      reg('d000000001', { proposalKind: 'steward-retention' }), m('d000000001', 'base', A, 1), m('d000000001', 'head', B, 0),
      reg('d000000002', { proposalKind: 'declined-handoffs' }), m('d000000002', 'base', A, 1), m('d000000002', 'head', B, 2));
    const ranked = rankByLeverage([{ kind: 'steward-retention', n: 1 }, { kind: 'team-feedback', n: 2 }, { n: 3 }, { kind: 'declined-handoffs', n: 4 }], outcomes);
    expect(ranked.map((p) => p.n)).toEqual([4, 2, 3, 1]);
  });
});

describe('promotion gate', () => {
  const pr = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({ number: 7, state: 'OPEN', isDraft: true, isCrossRepository: false,
    headRefName: 'improve/0123456789-x', headRefOid: B, baseRefName: 'main', checks: [{ name: 'ci', state: 'success' }], ...over });
  const improved = () => write(reg('0123456789'), { type: 'pr', proposalId: '0123456789', repository: 'acme/p', number: 7 },
    m('0123456789', 'base', A, 1), m('0123456789', 'head', B, 2))[0]!;

  const clean = { guards: { killSwitch: false, paused: false }, diff: { paths: ['src/core/run/fast-path.ts'], patch: '' }, remeasured: { base: 1, head: 2, reasons: [] } };

  it('admits only green exact-head checks plus a measured improvement at the current merge base', () => {
    const outcome = improved();
    expect(evaluatePromotion({ outcome, pr: pr(), defaultBranch: 'main', mergeBase: A, ledgerIntact: true, ...clean })).toEqual({ admit: true, reasons: [] });
    const refuse = (o: Partial<Parameters<typeof evaluatePromotion>[0]>) =>
      evaluatePromotion({ outcome, pr: pr(), defaultBranch: 'main', mergeBase: A, ledgerIntact: true, ...clean, ...o }).reasons.join(' | ');
    expect(refuse({ pr: pr({ checks: [{ name: 'ci', state: 'pending' }] }) })).toMatch(/pending: ci/);
    expect(refuse({ pr: pr({ checks: [] }) })).toMatch(/no checks/);
    expect(refuse({ pr: pr({ checks: [{ name: 'Merge Gate', state: 'failure' }] }) })).toMatch(/not green: Merge Gate/);
    expect(refuse({ pr: pr({ headRefOid: C }) })).toMatch(/different head/);
    expect(refuse({ mergeBase: C })).toMatch(/base branch moved/);
    expect(refuse({ pr: pr({ headRefName: 'codex/memory-foundation' }) })).toMatch(/not owned/);
    expect(refuse({ pr: pr({ isCrossRepository: true }) })).toMatch(/another repository/);
    expect(refuse({ pr: pr({ baseRefName: 'release' }) })).toMatch(/not the default branch/);
    expect(refuse({ pr: pr({ number: 8 }) })).toMatch(/linked to PR #7/);
    expect(refuse({ ledgerIntact: false })).toMatch(/not intact/);
    expect(refuse({ outcome: undefined })).toMatch(/no registered proposal/);
  });

  it('refuses unchanged and unknown outcomes', () => {
    const unchanged = write(reg('0123456789'), m('0123456789', 'base', A, 1), m('0123456789', 'head', B, 1))[0]!;
    expect(evaluatePromotion({ outcome: unchanged, pr: pr(), defaultBranch: 'main', mergeBase: A, ledgerIntact: true, ...clean, remeasured: { base: 1, head: 1, reasons: [] } }).reasons[0]).toMatch(/is unchanged/);
  });

  it('normalizes check runs and status contexts conservatively', () => {
    expect(normalizeChecks([
      { __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'b', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'CheckRun', name: 'c', status: 'IN_PROGRESS', conclusion: null },
      { __typename: 'CheckRun', name: 'd', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { __typename: 'StatusContext', context: 'e', state: 'PENDING' },
      { __typename: 'StatusContext', context: 'f', state: 'ERROR' },
    ]).map((c) => c.state)).toEqual(['success', 'skipped', 'pending', 'failure', 'pending', 'failure']);
    expect(normalizeChecks(null)).toEqual([]);
  });

  it('queues GitHub auto-merge pinned to the exact head and never uses admin', () => {
    const calls: string[][] = [];
    queueMerge('acme/p', pr(), '/repo', (cmd, args) => { calls.push([cmd, ...args]); return ''; });
    expect(calls).toEqual([
      ['gh', 'pr', 'ready', '7', '--repo', 'acme/p'],
      ['gh', 'pr', 'merge', '7', '--repo', 'acme/p', '--squash', '--auto', '--match-head-commit', B],
    ]);
    expect(calls.flat()).not.toContain('--admin');
  });
});

describe('measurement', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();

  it('measures the declared metric at two exact commits of a real repository', () => {
    const repo = join(dir, 'repo');
    fs.mkdirSync(join(repo, 'scripts'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'commit.gpgsign', 'false');
    const commit = (value: number) => {
      fs.writeFileSync(join(repo, 'scripts', 'metric.mjs'), `console.log('noise');\nconsole.log(JSON.stringify({ metric: 'eval-pass-rate', value: ${value}, token: process.env.GITHUB_TOKEN ?? null }));\n`);
      git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', `v${value}`);
      return git(repo, 'rev-parse', 'HEAD');
    };
    const base = commit(0.6);
    const head = commit(0.8);
    process.env.GITHUB_TOKEN = 'ghp_should_not_reach_metric';
    try {
      const b = measureAt(repo, base, metric);
      const h = measureAt(repo, head, metric);
      expect(b).toEqual({ sha: base, value: 0.6, reason: null });
      expect(h).toEqual({ sha: head, value: 0.8, reason: null });
      expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
      const [o] = write(reg('0123456789'), m('0123456789', 'base', base, b.value), m('0123456789', 'head', head, h.value));
      expect(o).toMatchObject({ status: 'improved' });
      expect(o!.effect).toBeCloseTo(0.2);
      expect(measureAt(repo, head, { ...metric, runner: { kind: 'node', path: 'scripts/missing.mjs' } }).reason).toMatch(/missing/);
      expect(measureAt(repo, 'f'.repeat(40), metric).value).toBeNull();
    } finally { delete process.env.GITHUB_TOKEN; }
  });

  it('parses only a final JSON line naming the metric and strips credentials from the environment', () => {
    expect(parseMetricOutput('x\n{"metric":"m","value":3}\n\n', 'm')).toBe(3);
    expect(() => parseMetricOutput('{"metric":"other","value":3}', 'm')).toThrow();
    expect(() => parseMetricOutput('{"metric":"m","value":"3"}', 'm')).toThrow();
    expect(() => parseMetricOutput('{"metric":"m","value":3}\ndone', 'm')).toThrow();
    const env = metricEnv({ PATH: '/bin', GITHUB_TOKEN: 'x', GH_TOKEN: 'x', ANTHROPIC_API_KEY: 'x', NPM_TOKEN: 'x', CLAUDECODE: '1' });
    expect(env).toEqual({ CI: '1', NO_COLOR: '1', PATH: '/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  });
});

describe('phm improve CLI', () => {
  it('registers a proposal file and reports unknown outcomes and baselines', async () => {
    process.env.ASHLR_HOME = dir;
    const file = join(dir, 'p.json');
    fs.writeFileSync(file, JSON.stringify({ id: '0123456789', title: 'Faster gate', kind: 'team-feedback', predictedDelta: 0.1,
      source: { kind: 'model', engine: 'claude', model: 'claude-opus-5-5' }, metric, pr: { repository: 'acme/p', number: 7 } }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdImprove(['register', file])).toBe(0);
    expect(await cmdImprove(['outcomes', '--json'])).toBe(0);
    const report = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(report.outcomes[0]).toMatchObject({ proposalId: '0123456789', status: 'unknown', pr: { repository: 'acme/p', number: 7 }, predictedDelta: 0.1 });
    expect(report.sources[0]).toMatchObject({ key: 'model:claude/claude-opus-5-5', improvementRate: null });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(file, JSON.stringify({ title: 'x', kind: 'k', source: { kind: 'deterministic', rule: 'k' }, metric: { ...metric, runner: { kind: 'node', path: '../escape.mjs' } } }));
    expect(await cmdImprove(['register', file])).toBe(1);
    expect(await cmdImprove(['measure', '0123456789'])).toBe(2);
    expect(await cmdImprove(['bogus'])).toBe(2);
  });
});
