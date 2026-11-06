import { expect, it } from 'vitest';
import { entryIdFromSource, plannerAckLabel } from './planner-ack-model.js';
it('extracts channel ids and rejects missing, legacy and invalid ids', () => {
  expect(entryIdFromSource('telegram (msg:1-a.b_c)')).toBe('msg:1-a.b_c');
  for (const source of ['telegram', 'Phantom desktop', 'terminal', 'telegram (bad id)', `telegram (${'x'.repeat(65)})`]) expect(entryIdFromSource(source)).toBeNull();
});
it('labels acknowledged, skipped and missing rows', () => {
  const entry = { source: 'desktop (one)' };
  expect(plannerAckLabel(entry, [{ entryId: 'one', status: 'acked' }])).toBe('Acked by planner');
  expect(plannerAckLabel(entry, [{ entryId: 'one', status: 'skipped' }])).toBe('Not routable');
  expect(plannerAckLabel(entry, [])).toBeNull();
  expect(plannerAckLabel(entry, null)).toBeNull();
  expect(plannerAckLabel({ source: 'legacy' }, [{ entryId: 'one', status: 'acked' }])).toBeNull();
});
