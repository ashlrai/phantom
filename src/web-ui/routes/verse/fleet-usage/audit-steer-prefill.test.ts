import { describe, expect, it } from 'vitest';
import { auditSteerPrefill, auditSteerVisible } from './audit-steer-prefill.js';
import type { AuditLane } from './usage-audit-queries.js';

const lane: AuditLane = {
  lane: 'codex-personal', classification: 'idle', pctUsedFirst: 62, pctUsedLast: 62,
  pctUsedDelta: 0, observedMinutes: 47, reason: 'meter has not moved', nextAction: 'check the worker',
};
const now = '2026-10-31T23:51:00.000Z';

describe('audit steering', () => {
  it('includes the lane evidence and suggested action in one paragraph', () => {
    const text = auditSteerPrefill(lane, now);
    for (const part of [lane.lane, lane.reason, lane.nextAction, 'idle', '47 min', '62% -> 62%', now]) {
      expect(text).toContain(part);
    }
    expect(text).toContain('Decide');
    expect(text).not.toMatch(/[\r\n]/);
    expect(text.length).toBeLessThan(600);
  });

  it.each(['pctUsedFirst', 'pctUsedLast'] as const)('omits percentages when %s is null', field => {
    const text = auditSteerPrefill({ ...lane, [field]: null }, now);
    expect(text).not.toContain('%');
    expect(text).toContain(lane.reason);
  });

  it('identifies incidents and handles absent duration', () => {
    const text = auditSteerPrefill({ ...lane, classification: 'incident', observedMinutes: null }, now);
    expect(text).toContain('incident');
    expect(text).not.toContain(' min');
  });

  it('keeps unusually long evidence to one short paragraph', () => {
    const text = auditSteerPrefill({ ...lane, lane: 'l'.repeat(1000), reason: 'reason\n'.repeat(100), nextAction: 'action '.repeat(100) }, now);
    expect(text.length).toBeLessThan(600);
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain('Reason: reason');
    expect(text).toContain('Suggested: action');
  });

  it.each([
    ['incident', true], ['idle', true], ['moving', false], ['reset-observed', false], ['insufficient-evidence', false],
  ] as const)('shows steering for %s: %s', (classification, visible) => {
    expect(auditSteerVisible({ ...lane, classification })).toBe(visible);
  });
});
