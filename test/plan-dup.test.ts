import { describe, expect, it } from 'vitest';
import { cmdPlan } from '../src/cli/plan.js';
import { checkPlan } from '../src/core/plan/check.js';
import { checkDup, cleanSubject, PLAN_DUP_SCHEMA, type DupSources } from '../src/core/plan/dup.js';

const sources: DupSources = {
  verbs: [{ kind: 'verb', ref: 'phm worktrees reclaim', title: 'phm worktrees reclaim', text: 'Free stale worktrees.' }],
  changes: [
    { kind: 'pr', ref: '#101', title: 'Speed up merge latency checks' },
    { kind: 'pr', ref: '#102', title: 'Add merge latency alerts' },
    { kind: 'commit', ref: 'abc1234', title: 'Fix lint in the parser' },
  ],
  docs: [{ kind: 'doc', ref: 'Merge latency', title: 'Merge latency', text: 'docs/MERGE.md' }],
};

describe('plan dup', () => {
  it('says new for an idea nothing matches', () => {
    const r = checkDup('teleport sandwiches across regions', sources);
    expect(r).toMatchObject({ schema: PLAN_DUP_SCHEMA, verdict: 'new', matches: [], unknown: [] });
  });
  it('says shipped and names the verb when one covers the bet', () => {
    const r = checkDup('reclaim stale worktrees', sources);
    expect(r.verdict).toBe('shipped');
    expect(r.matches[0]).toMatchObject({ kind: 'verb', ref: 'phm worktrees reclaim' });
    expect(r.matches[0]!.score).toBeGreaterThan(0.7);
    expect(r.matches[0]!.why).toContain('"reclaim"');
  });
  it('says partly-shipped and lists both merged PRs', () => {
    const r = checkDup('merge latency dashboard with alerts and weekly digest', sources);
    expect(r.verdict).toBe('partly-shipped');
    expect(r.matches.filter(m => m.kind === 'pr').map(m => m.ref).sort()).toEqual(['#101', '#102']);
    expect(r.matches.every(m => m.score > 0 && m.why.length > 0)).toBe(true);
  });
  it('lists unknown sources instead of guessing', () => {
    expect(checkDup('anything at all', { ...sources, changes: [], unknown: ['changes'] }).unknown).toEqual(['changes']);
  });
  it('strips bridge prefixes, repeated job ids and the PR number', () => {
    expect(cleanSubject('bridge(RQ-ABC-1): RQ-ABC-1: `phm plan check` (#7328)')).toEqual({ title: '`phm plan check`', pr: '7328' });
    expect(cleanSubject('bridge(RQ-ABC-1): (#7344)').title).toBe('');
  });
});

describe('plan check + dup', () => {
  const plan = '- READY RQ-A (P1, pool=claude, repo=phantom, size<=200): reclaim stale worktrees. Acceptance: ok.\n- READY RQ-B (P1, pool=claude, repo=phantom, size<=200): teleport sandwiches. Acceptance: ok.\n';
  const dup = (bet: string) => checkDup(bet, sources);
  it('flags only the shipped line', () => {
    const r = checkPlan(plan, { minBets: 2, dup });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.objectContaining({ line: 1, kind: 'already-shipped' })]);
    expect(r.bets.map(b => b.dup?.verdict)).toEqual(['shipped', 'new']);
  });
});

describe('phm plan dup', () => {
  const run = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await cmdPlan(args, { out: l => out.push(l), err: l => err.push(l), dup: bet => checkDup(bet, sources) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  it('prints typed JSON and exits 3 on shipped', async () => {
    const r = await run(['dup', 'reclaim', 'stale', 'worktrees', '--json']);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out)).toMatchObject({ schema: 'plan.dup.v1', verdict: 'shipped' });
  });
  it('exits 0 on new and 2 on bad usage', async () => {
    expect((await run(['dup', 'teleport sandwiches'])).code).toBe(0);
    expect((await run(['dup'])).code).toBe(2);
    expect((await run(['dup', 'x', '--repo'])).code).toBe(2);
  });
});
