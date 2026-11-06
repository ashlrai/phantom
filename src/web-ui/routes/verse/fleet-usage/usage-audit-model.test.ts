import { expect, it } from 'vitest';
import { auditHeadline, auditRows } from './usage-audit-model.js';
import { narrowUsageAudit, type AuditLane, type UsageAuditView } from './usage-audit-queries.js';

export const fixture: UsageAuditView = {
  incidents: 1, sources: { usageJournal: { state: 'healthy' } },
  lanes: (['moving', 'insufficient-evidence', 'idle', 'incident'] as const).map(classification => ({
    lane: classification, classification, pctUsedFirst: classification === 'insufficient-evidence' ? null : 10,
    pctUsedLast: classification === 'insufficient-evidence' ? null : classification === 'moving' ? 13.2 : 10,
    pctUsedDelta: classification === 'insufficient-evidence' ? null : classification === 'moving' ? 3.2 : 0,
    observedMinutes: classification === 'insufficient-evidence' ? null : classification === 'moving' ? 58 : 61,
    reason: `${classification} reason`, nextAction: `${classification} action`,
  })),
};
it('sorts by operational urgency, formats movement and preserves null evidence', () => {
  const rows = auditRows(fixture);
  expect(rows.map(r => r.verdict)).toEqual(['incident', 'idle', 'insufficient-evidence', 'moving']);
  expect(rows.map(r => r.tone)).toEqual(['bad', 'warn', 'neutral', 'ok']);
  expect(rows.map(r => r.deltaText)).toEqual(['no movement in 61 min', 'no movement in 61 min', 'evidence too thin', '+3.2% in 58 min']);
  expect(fixture.lanes[0].lane).toBe('moving');
  expect(auditHeadline(fixture)).toBe('Zero waste: 1 incident · 1 idle · 1 moving');
});
it('puts resets before moving without fabricating a delta', () => {
  const reset: AuditLane = { ...fixture.lanes[0], lane: 'reset', classification: 'reset-observed', pctUsedDelta: null };
  expect(auditRows({ ...fixture, lanes: [fixture.lanes[0], reset] }).map(r => [r.verdict, r.tone, r.deltaText]))
    .toEqual([['reset-observed', 'ok', 'evidence too thin'], ['moving', 'ok', '+3.2% in 58 min']]);
});
it('names missing journal evidence', () => {
  expect(auditHeadline({ ...fixture, sources: { usageJournal: { state: 'missing' } } })).toBe('Zero waste: usage journal missing');
});
it('rejects drifted payloads and accepts null as null', () => {
  expect(narrowUsageAudit({ v: 1, audit: fixture })).toEqual(fixture);
  for (const patch of [{ classification: 'healthy' }, { pctUsedDelta: undefined }, { pctUsedLast: '0' }, { observedMinutes: NaN }, { reason: null }]) {
    expect(narrowUsageAudit({ v: 1, audit: { ...fixture, lanes: [{ ...fixture.lanes[0], ...patch }] } })).toBeNull();
  }
  expect(narrowUsageAudit({ v: 2, audit: fixture })).toBeNull();
});
