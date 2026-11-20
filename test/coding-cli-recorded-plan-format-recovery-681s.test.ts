import { describe, expect, it } from 'vitest';
import {
  RECORDED_PLAN_BANNER,
  formatRecordedPlan,
  type RecordedPlan,
} from '../src/core/providers/coding-cli/recorded-plan-format.js';

const full: RecordedPlan = {
  dryRun: false,
  meteredEnabled: true,
  steps: [
    {
      number: 7, title: 'Fix widget', action: 'run', reason: 'route:codex ready',
      backend: 'codex', billing: 'subscription', role: 'implement', accountId: 'acct-a',
      poolId: 'pool-1', model: 'model-x', worktree: '/tmp/synthetic/wt-7', pullRequest: 'draft',
    },
    { number: 3, title: 'Docs', action: 'skip', reason: 'no capacity' },
  ],
};

// Source formatPlan output for the same input, minus the banner line.
const sourceText = [
  'worker plan (execute)', 'metered: enabled', 'steps: 2',
  '#7 Fix widget', '  action: run', '  reason: route:codex ready', '  backend: codex',
  '  billing: subscription', '  role: implement', '  account: acct-a', '  pool: pool-1',
  '  model: model-x', '  worktree: /tmp/synthetic/wt-7', '  pr: draft',
  '#3 Docs', '  action: skip', '  reason: no capacity',
].join('\n');

describe('formatRecordedPlan (recovered from #5952 formatPlan)', () => {
  it('matches the pinned source text after the historical banner, keeping step order', () => {
    const out = formatRecordedPlan(full);
    expect(out).toBe(`${RECORDED_PLAN_BANNER}\n${sourceText}`);
    expect(out.indexOf('#7 ')).toBeLessThan(out.indexOf('#3 '));
  });

  it('labels recorded execute/metered as non-authorizing', () => {
    const [first] = formatRecordedPlan(full).split('\n');
    expect(first).toContain('grants no execution or spend authority');
  });

  it('renders an empty plan', () => {
    expect(formatRecordedPlan({ dryRun: true, meteredEnabled: false, steps: [] })).toBe(
      [RECORDED_PLAN_BANNER, 'worker plan (dry-run)', 'metered: disabled', 'steps: 0'].join('\n'),
    );
  });

  it('omits absent, null and empty optional rows', () => {
    const out = formatRecordedPlan({
      dryRun: true, meteredEnabled: false,
      steps: [{ number: 1, title: 'T', action: 'skip', reason: 'r', backend: null, model: '', pullRequest: null }],
    });
    expect(out.split('\n').slice(4)).toEqual(['#1 T', '  action: skip', '  reason: r']);
  });

  it('does not mutate the input', () => {
    const copy = structuredClone(full);
    formatRecordedPlan(full);
    expect(full).toEqual(copy);
  });

  it.each([
    ['null plan', null, /plan must be an object/],
    ['dryRun', { dryRun: 'yes', meteredEnabled: true, steps: [] }, /dryRun must be a boolean/],
    ['meteredEnabled', { dryRun: true, steps: [] }, /meteredEnabled must be a boolean/],
    ['steps', { dryRun: true, meteredEnabled: true, steps: {} }, /steps must be an array/],
    ['step shape', { dryRun: true, meteredEnabled: true, steps: [null] }, /steps\[0\] must be an object/],
    ['number', { dryRun: true, meteredEnabled: true, steps: [{ number: 1.5, title: 't', action: 'run', reason: 'r' }] }, /steps\[0\]\.number/],
    ['action', { dryRun: true, meteredEnabled: true, steps: [{ number: 1, title: 't', action: 'go', reason: 'r' }] }, /action must be/],
    ['missing reason', { dryRun: true, meteredEnabled: true, steps: [{ number: 1, title: 't', action: 'run' }] }, /reason must be a string/],
    ['optional type', { dryRun: true, meteredEnabled: true, steps: [{ number: 1, title: 't', action: 'run', reason: 'r', model: 5 }] }, /model must be a string/],
    ['pr value', { dryRun: true, meteredEnabled: true, steps: [{ number: 1, title: 't', action: 'run', reason: 'r', pullRequest: 'ready' }] }, /pullRequest must be/],
    ['row forgery', { dryRun: true, meteredEnabled: true, steps: [{ number: 1, title: 'a\n  backend: x', action: 'run', reason: 'r' }] }, /line breaks/],
  ])('rejects malformed %s', (_n, input, re) => {
    expect(() => formatRecordedPlan(input as unknown as RecordedPlan)).toThrow(re);
  });
});
