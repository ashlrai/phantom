import { describe, expect, it } from 'vitest';
import { CI_PLAN_COMMAND, deriveCiNeedsYou } from '../src/web-ui/routes/verse/shell/ci-needs-you.js';
import { ciFacts, CI_NOW } from '../src/web-ui/routes/verse/shell/ci-needs-you.test-support.js';

describe('CI Needs-you facts', () => {
  it('reports event counts without double-counting workflow totals and classifies reds', () => {
    expect(deriveCiNeedsYou(ciFacts, CI_NOW)).toEqual([{
      id: 'ci-runs-on-prs', severity: 'attention', target: 'ops',
      title: "CI ran 10 times on PRs today; Mason's order is once a day",
      detail: '4 reds: 2 rebase artifacts (not code), 1 code, 1 unclassified. Apply the once-a-day plan: ashlr fleet ci-plan --patch | git apply (owner change)',
      nextStep: 'Copy the once-a-day plan command', open: { kind: 'copy', command: CI_PLAN_COMMAND },
    }]);
  });
  it('omits unavailable, empty, schedule-only, malformed, stale and future facts', () => {
    for (const facts of [undefined, { ...ciFacts, available: false }, { ...ciFacts, total: 0 },
      { ...ciFacts, byEvent: { ...ciFacts.byEvent, pull_request: 0, push: 0 } },
      { ...ciFacts, generatedAt: 'bad' }, { ...ciFacts, generatedAt: '2026-11-01T09:59:59Z' },
      { ...ciFacts, generatedAt: '2026-11-01T12:00:01Z' }]) {
      expect(deriveCiNeedsYou(facts, CI_NOW)).toEqual([]);
    }
    expect(deriveCiNeedsYou(ciFacts, CI_NOW + 2 * 60 * 60_000)).toHaveLength(1);
  });
});
