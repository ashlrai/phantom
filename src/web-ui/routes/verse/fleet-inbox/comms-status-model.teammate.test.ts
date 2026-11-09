import { expect, it } from 'vitest';
import { readCommsStatus, teammateLatencyLine, type TeammateLatency } from './comms-status-model.js';

const base: TeammateLatency = {
  windowHours: 24, targetMinutes: 5, texts: 6, answered: 5, unanswered: 1, medianMinutes: 2, withinTarget: 5,
  oldestUnanswered: { ageMinutes: 14 }, sourceState: 'healthy',
};
const response = (teammate: unknown) => ({
  version: 1, generatedAt: '2026-11-09T12:00:00.000Z', drafts: null, emailOutbox: null,
  sources: { drafts: 'healthy', emailOutbox: 'healthy', teammate: 'healthy' }, teammate,
});

it('summarizes a normal window', () => {
  expect(teammateLatencyLine(base)).toBe('Dot: 6 texts in 24h, median 2 min, 5 of 6 within 5 min, 1 waiting 14 min');
});
it('says no texts, never zero speed', () => {
  expect(teammateLatencyLine({ ...base, texts: 0, answered: 0, unanswered: 0, medianMinutes: null, withinTarget: 0, oldestUnanswered: null }))
    .toBe('Dot: no texts in 24h');
});
it('handles one waiting text with nothing answered', () => {
  expect(teammateLatencyLine({ ...base, texts: 1, answered: 0, unanswered: 1, medianMinutes: null, withinTarget: 0, oldestUnanswered: { ageMinutes: 3 } }))
    .toBe('Dot: 1 text in 24h, 0 of 1 within 5 min, 1 waiting 3 min');
});
it('reads unknown for an unhealthy source', () => {
  expect(teammateLatencyLine({ ...base, texts: 0, sourceState: 'degraded' })).toBe('Dot reply speed unknown (teammate log unreadable)');
  expect(teammateLatencyLine({ ...base, texts: 0, sourceState: 'missing' })).toBe('Dot reply speed unknown (teammate log not found)');
});
it('parses a valid teammate block', () => {
  expect(readCommsStatus(response(base))?.teammate).toEqual(base);
});
it('gives null for missing or malformed teammate input', () => {
  expect(readCommsStatus(response(undefined))?.teammate).toBeNull();
  expect(readCommsStatus(response('nope'))?.teammate).toBeNull();
  expect(readCommsStatus(response({ ...base, texts: -1 }))?.teammate).toBeNull();
  expect(readCommsStatus(response({ ...base, sourceState: 'fast' }))?.teammate).toBeNull();
  expect(readCommsStatus(response({ ...base, oldestUnanswered: { ageMinutes: 'x' } }))?.teammate).toBeNull();
});
