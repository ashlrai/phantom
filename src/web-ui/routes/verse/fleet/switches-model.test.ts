import { expect, it } from 'vitest';
import { readSwitches, switchLabel, switchEffect, summary, sinceText } from './switches-model.js';
const pause = { id: 'PAUSE', on: true, since: null, effect: '' };
it('strictly narrows the wire shape', () => {
  expect(readSwitches({ v: 1, switches: [pause], sourceState: 'healthy' })?.switches).toEqual([pause]);
  for (const switches of [{}, [{ id: 'PAUSE', since: null, effect: '' }], [{ ...pause, on: 1 }], [{ ...pause, since: 4 }], [pause, pause]]) {
    expect(readSwitches({ v: 1, switches, sourceState: 'healthy' })).toBeNull();
  }
  expect(readSwitches(null)).toBeNull();
  expect(readSwitches({ v: 2, switches: [], sourceState: 'healthy' })).toBeNull();
  expect(readSwitches({ v: 1, switches: [], sourceState: 'other' })).toBeNull();
});
it('labels known ids and uses server effects before fallbacks', () => {
  const labels = ['Leaders off', 'Opus leader off', 'Pause launches', 'Publish hold', 'Hold dispatcher', 'Queue disabled'];
  const effects = ['stops leader passes', 'stops the hourly Opus leader', 'no new launches', 'no publishes', 'holds the dispatcher', 'queue disabled'];
  ['ORCH_OFF', 'OPUS_LEADER_OFF', 'PAUSE', 'PUBLISH_HOLD', 'HOLD', 'QUEUE_DISABLE'].forEach((id, i) => {
    expect(switchLabel(id)).toBe(labels[i]); expect(switchEffect({ ...pause, id })).toBe(effects[i]);
  });
  expect(switchLabel('CUSTOM')).toBe('CUSTOM');
  expect(switchLabel('constructor')).toBe('constructor');
  expect(switchEffect({ ...pause, id: 'CUSTOM', effect: 'custom effect' })).toBe('custom effect');
  expect(switchEffect({ ...pause, effect: 'server effect' })).toBe('server effect');
});
it('summarizes zero, one, two and untrusted source states', () => {
  expect(summary([])).toBe('All clear');
  expect(summary([{ ...pause, on: false }])).toBe('All clear');
  expect(summary([pause])).toBe('1 on: Pause launches');
  expect(summary([pause, { ...pause, id: 'PUBLISH_HOLD' }])).toBe('2 on: Pause launches, Publish hold');
  expect(summary([], 'degraded')).toBe('Switch state degraded');
  expect(summary([], 'missing')).toBe('Switch state missing');
  expect(sinceText('2026-10-31T12:00:00Z', Date.parse('2026-10-31T12:14:00Z'))).toBe('on for 14 min');
  expect(sinceText(null, 0)).toBe('');
});
