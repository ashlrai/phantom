import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendLedger, kindLeverage, readLedger, scoreOutcomes, type MetricSpec } from '../src/core/improve/outcomes.js';
import { observeCloudReverts, observeOutcomes, revertOf, type ObserveExec } from '../src/core/improve/observe.js';
import type { CloudTaskV1 } from '../src/core/cloud/types.js';

const metric: MetricSpec = { name: 'gate-ms', direction: 'decrease', runner: { kind: 'npm', script: 'bench:gate' } };
let home: string, repo: string;
let saved: { HOME?: string; ASHLR_HOME?: string };
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  delete process.env.ASHLR_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-observe-')));
  process.env.HOME = home;
  repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

function register(id: string, pr: number, head: number) {
  appendLedger({ type: 'registered', proposalId: id, title: id, proposalKind: 'perf', source: { kind: 'deterministic', rule: 'test' }, metric, predictedDelta: null });
  appendLedger({ type: 'pr', proposalId: id, repository: 'ashlrai/phantom', number: pr });
  appendLedger({ type: 'measured', proposalId: id, phase: 'base', sha: 'a'.repeat(40), value: 100, reason: null });
  appendLedger({ type: 'measured', proposalId: id, phase: 'head', sha: 'b'.repeat(40), value: head, reason: null });
}

describe('post-merge observation', () => {
  it('recognises git and GitHub revert messages', () => {
    const m = 'c'.repeat(40), r = 'd'.repeat(40);
    expect(revertOf(`${r}\x1fRevert "x"\n\nThis reverts commit ${m}.\x1e`, m, 'ashlrai/phantom', 5)).toBe(r);
    expect(revertOf(`${r}\x1fRevert "x" (#9)\n\nReverts ashlrai/phantom#5\x1e`, m, 'ashlrai/phantom', 5)).toBe(r);
    expect(revertOf(`${r}\x1fReverts ashlrai/phantom#55\x1e`, m, 'ashlrai/phantom', 5)).toBeNull();
  });

  it('records merges, then turns a reverted improvement into a regression', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'base');
    fs.writeFileSync(path.join(repo, 'a.txt'), '2'); git('commit', '-qam', 'faster gate (#5)');
    const merge5 = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'b.txt'), '1'); git('add', '.'); git('commit', '-qm', 'other (#6)');
    const merge6 = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    register('1111111111', 5, 80);
    register('2222222222', 6, 80);
    const exec: ObserveExec = (cmd, args, cwd) => {
      if (cmd === 'gh') return JSON.stringify({ state: 'MERGED', mergeCommit: { oid: args[2] === '5' ? merge5 : merge6 } });
      if (args.includes('fetch')) return '';
      return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
    };
    const first = observeOutcomes(scoreOutcomes(readLedger().records), repo, 'main', exec);
    expect(first.errors).toEqual([]);
    for (const e of first.events) appendLedger(e);
    expect(scoreOutcomes(readLedger().records).map((o) => [o.status, o.merged?.sha])).toEqual([['improved', merge5], ['improved', merge6]]);

    git('revert', '--no-edit', merge5);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const second = observeOutcomes(scoreOutcomes(readLedger().records), repo, 'main', exec);
    expect(second.events).toEqual([{ type: 'observed', proposalId: '1111111111', observation: 'reverted', sha: git('rev-parse', 'HEAD') }]);
    for (const e of second.events) appendLedger(e);
    const scored = scoreOutcomes(readLedger().records);
    expect(scored[0]).toMatchObject({ status: 'regressed', effect: 20, reasons: ['reverted-after-merge'] });
    expect(kindLeverage(scored).get('perf')).toBe(0);
    expect(observeOutcomes(scored, repo, 'main', exec).events).toEqual([]);

    // A revert of the revert re-lands the change and gives the credit back.
    const revertSha = git('rev-parse', 'HEAD');
    git('revert', '--no-edit', revertSha);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const reland = git('rev-parse', 'HEAD');
    const third = observeOutcomes(scoreOutcomes(readLedger().records), repo, 'main', exec);
    expect(third.events).toEqual([{ type: 'observed', proposalId: '1111111111', observation: 'merged', sha: reland }]);
    for (const e of third.events) appendLedger(e);
    expect(scoreOutcomes(readLedger().records)[0]).toMatchObject({ status: 'improved', merged: { sha: reland }, reverted: null });
  });

  it('does not count a merge into a feature branch until it reaches the default branch', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(repo, 'a.txt'), '2'); git('commit', '-qam', 'into feature (#5)');
    const intoFeature = git('rev-parse', 'HEAD');
    register('1111111111', 5, 80);
    const exec: ObserveExec = (cmd, args, cwd) => {
      if (cmd === 'gh') return JSON.stringify({ state: 'MERGED', mergeCommit: { oid: intoFeature } });
      if (args.includes('fetch')) return '';
      return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    };
    expect(observeOutcomes(scoreOutcomes(readLedger().records), repo, 'main', exec)).toEqual({ events: [], errors: [] });
    git('update-ref', 'refs/remotes/origin/main', intoFeature);
    expect(observeOutcomes(scoreOutcomes(readLedger().records), repo, 'main', exec).events)
      .toEqual([{ type: 'observed', proposalId: '1111111111', observation: 'merged', sha: intoFeature }]);
  });

  it('records reverts and re-lands of merged cloud tasks from their recorded merge sha', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'base');
    fs.writeFileSync(path.join(repo, 'a.txt'), '2'); git('commit', '-qam', 'cloud change (#12)');
    const merge = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const exec: ObserveExec = (cmd, args, cwd) => (args.includes('fetch') ? '' : execFileSync(cmd, args, { cwd, encoding: 'utf8' }));
    const outcome = { observedAt: '2026-10-17T00:00:00.000Z', headSha: 'e'.repeat(40), mergeSha: merge, ci: 'success' as const, failedChecks: [], reviewDecision: null, changesRequested: 0 };
    const task = (over: Partial<CloudTaskV1>) => ({ id: 'ct_a', repo: 'AshlrAI/Phantom', state: 'merged', pr: { number: 12 }, outcome, ...over }) as unknown as CloudTaskV1;
    const noSha = task({ id: 'ct_b', outcome: { ...outcome, mergeSha: null } });
    const other = task({ id: 'ct_c', repo: 'ashlrai/locus' });
    expect(observeCloudReverts([task({}), noSha, other], 'ashlrai/phantom', repo, 'main', exec)).toEqual({ changes: [], errors: [] });

    git('revert', '--no-edit', merge);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const revert = git('rev-parse', 'HEAD');
    expect(observeCloudReverts([task({}), noSha, other], 'ashlrai/phantom', repo, 'main', exec).changes).toEqual([{ taskId: 'ct_a', revertedBy: revert }]);
    const reverted = task({ outcome: { ...outcome, revertedBy: revert } });
    expect(observeCloudReverts([reverted], 'ashlrai/phantom', repo, 'main', exec).changes).toEqual([]);

    git('revert', '--no-edit', revert);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(observeCloudReverts([reverted], 'ashlrai/phantom', repo, 'main', exec).changes).toEqual([{ taskId: 'ct_a', revertedBy: null }]);
  });
});
