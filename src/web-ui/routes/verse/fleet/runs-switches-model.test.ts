import { describe, expect, it } from 'vitest';
import { sinceText, switchLabel, switchSummary } from './runs-switches-model.js';
import type { RunsSwitch } from './runs-switches-queries.js';

describe('fleet switches model', () => {
  it.each([
    ['ORCH_OFF', 'Leader passes'], ['OPUS_LEADER_OFF', 'Opus leader'], ['PAUSE', 'Launches'],
    ['PUBLISH_HOLD', 'Publishing'], ['HOLD', 'Dispatcher'], ['QUEUE_DISABLE', 'Queue'], ['NEW_FLAG', 'NEW_FLAG'], ['toString', 'toString'],
  ])('labels %s', (id, label) => expect(switchLabel(id)).toBe(label));

  it('summarizes the disabled running states', () => {
    const row = (id: string, on: boolean): RunsSwitch => ({ id, on, since: null, effect: '' });
    expect(switchSummary([row('PAUSE', false)])).toBe('All on');
    expect(switchSummary([row('PAUSE', true)])).toBe('1 switch off: Launches');
    expect(switchSummary([row('PAUSE', true), row('PUBLISH_HOLD', true)])).toBe('2 switches off: Launches, Publishing');
  });

  it('formats known elapsed times and omits invalid or future dates', () => {
    const now = Date.parse('2026-01-02T00:00:00Z');
    expect(sinceText('2026-01-01T23:48:00Z', now)).toBe('off since 12 m');
    expect(sinceText('2026-01-01T23:59:30Z', now)).toBe('off since <1 m');
    expect(sinceText('2026-01-01T22:00:00Z', now)).toBe('off since 2 h');
    expect(sinceText('2025-12-31T00:00:00Z', now)).toBe('off since 2 d');
    expect(sinceText(null, now)).toBeNull();
    expect(sinceText('invalid', now)).toBeNull();
    expect(sinceText('2026-01-03T00:00:00Z', now)).toBeNull();
  });
});
