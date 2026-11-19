import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cmdPlan } from '../src/cli/plan.js';
import { checkPlan, PLAN_CHECK_SCHEMA } from '../src/core/plan/check.js';

const fx = (name: string): string => new URL(`./fixtures/plan/${name}`, import.meta.url).pathname;
const text = (name: string): string => readFileSync(fx(name), 'utf8');
const kinds = (name: string, opts = {}): string[] => checkPlan(text(name), opts).problems.map(p => p.kind);

describe('plan check', () => {
  it('passes a good 6-bet plan with typed bets', () => {
    const r = checkPlan(text('good.md'));
    expect(r).toMatchObject({ schema: PLAN_CHECK_SCHEMA, ok: true, problems: [] });
    expect(r.bets).toHaveLength(6);
    expect(r.bets[0]).toEqual({ id: 'RQ-ALPHA', pool: 'claude', repo: 'phantom', size: 200, has_acceptance: true });
  });
  it('flags a truncated 2-line plan', () => expect(kinds('truncated.md')).toEqual(['too-few-bets']));
  it('honours --min-bets', () => expect(kinds('truncated.md', { minBets: 2 })).toEqual([]));
  it('flags a bet with no Acceptance', () => {
    const r = checkPlan(text('no-acceptance.md'));
    expect(r.problems).toEqual([expect.objectContaining({ line: 3, kind: 'missing-acceptance' })]);
    expect(r.bets[1]!.has_acceptance).toBe(false);
  });
  it('flags a duplicate id', () => expect(checkPlan(text('duplicate.md')).problems).toEqual([expect.objectContaining({ line: 4, kind: 'duplicate-id' })]));
  it('flags a bet on a drained pool', () => {
    expect(checkPlan(text('drained.md'), { drained: ['gemini', 'zai'] }).problems).toEqual([expect.objectContaining({ line: 3, kind: 'pool-drained' })]);
    expect(kinds('drained.md')).toEqual([]);
  });
  it('flags malformed READY lines', () => {
    expect(kinds('good.md').length).toBe(0);
    const r = checkPlan('- READY RQ-X no parens here\n- READY RQ-Y (P1, tier=work): task Acceptance: ok.\n', { minBets: 0 });
    expect(r.problems.map(p => p.kind)).toEqual(['malformed-ready-line', 'malformed-ready-line']);
  });
});

describe('phm plan check', () => {
  const run = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await cmdPlan(args, { out: l => out.push(l), err: l => err.push(l), dup: null });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  it('exits 0 with JSON for a good plan', async () => {
    const r = await run(['check', fx('good.md'), '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).schema).toBe('plan.check.v1');
  });
  it('exits 2 with one plain line per problem', async () => {
    const r = await run(['check', fx('drained.md'), '--drained', 'gemini']);
    expect(r.code).toBe(2);
    expect(r.out.split('\n')).toHaveLength(1);
    expect(r.out).toContain('pool-drained');
  });
  it('exits 1 on an unreadable file and 2 on bad usage', async () => {
    expect((await run(['check', fx('nope.md')])).code).toBe(1);
    expect((await run(['check'])).code).toBe(2);
    expect((await run(['check', fx('good.md'), '--min-bets', 'x'])).code).toBe(2);
  });
});
