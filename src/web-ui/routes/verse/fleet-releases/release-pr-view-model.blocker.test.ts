import { describe, expect, it } from 'vitest';
import { blockerLine, releaseTellPrefill } from './release-pr-view-model.js';

const checks = [
  { name: 'Dependency Audit', state: 'fail' as const, href: null },
  { name: 'Quick typecheck', state: 'pending' as const, href: null },
  { name: 'Build', state: 'pass' as const, href: null },
];

describe('release blocker messaging', () => {
  it('does not report checks for an ok tone', () => {
    expect(blockerLine({ tone: 'ok', checks })).toBeNull();
  });
  it('lists failing and pending checks together', () => {
    expect(blockerLine({ tone: 'danger', checks })).toBe('Blocked by: Dependency Audit · Waiting on: Quick typecheck');
  });
  it('lists pending checks when none fail', () => {
    expect(blockerLine({ tone: 'warn', checks: checks.slice(1) })).toBe('Waiting on: Quick typecheck');
  });
  it('omits the line when no checks explain the tone', () => {
    expect(blockerLine({ tone: 'danger', checks: [] })).toBeNull();
  });
  it('formats the leaders prefill', () => {
    expect(releaseTellPrefill('ashlrai/phantom', 1479, 'Blocked by: Dependency Audit'))
      .toBe('Re release PR #1479 (ashlrai/phantom): Blocked by: Dependency Audit. ');
  });
});
