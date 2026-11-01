import { afterEach, expect, it } from 'vitest';
import { buildSteering } from './steering-model.js';
import { matchSteeringEntry, requestSteeringFocus, takeSteeringFocus } from './steering-focus.js';

const entries = buildSteering({ inbox: [
  { at: '2026-10-31 00:13', source: 'desktop', text: 'One shared context for every message' },
  { at: '2026-10-30 23:49', source: 'desktop', text: 'Live view of real jobs' },
] });
afterEach(() => { takeSteeringFocus(); });

it('prefers the exact timestamp even when the label matches another order', () => {
  expect(matchSteeringEntry(entries, { at: '2026-10-30 23:49', label: 'One shared context' })).toBe(1);
});

it('matches a normalized label within five naive clock minutes across midnight', () => {
  expect(matchSteeringEntry(entries, { at: '2026-10-31T00:17:59Z', label: '  ONE\n shared   CONTEXT ' })).toBe(0);
  expect(matchSteeringEntry(entries, { at: '2026-10-31T00:01:00Z', label: 'live view' })).toBeNull();
  expect(matchSteeringEntry(entries, { at: '2026-10-30T23:54:00Z', label: 'live view' })).toBe(1);
});

it('does not match missing labels, invalid clocks, or unrelated orders', () => {
  expect(matchSteeringEntry(entries, { at: 'invalid', label: 'live view' })).toBeNull();
  expect(matchSteeringEntry(entries, { at: '2026-10-31T00:13:00Z', label: ' ' })).toBeNull();
  expect(matchSteeringEntry(entries, { at: '2026-10-31T00:13:00Z', label: 'other order' })).toBeNull();
});

it('consumes the latest request once', () => {
  requestSteeringFocus({ at: 'first', label: 'first' });
  requestSteeringFocus({ at: 'second', label: 'second' });
  expect(takeSteeringFocus()).toEqual({ at: 'second', label: 'second' });
  expect(takeSteeringFocus()).toBeNull();
});
