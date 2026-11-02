import { expect, it } from 'vitest';
import { isNoFleet, NO_FLEET_TEXT } from './no-fleet.js';

it('identifies only a missing source and provides the shared notice', () => {
  expect(isNoFleet('missing')).toBe(true);
  for (const state of ['healthy', 'degraded', 'not-landed', '', null, undefined, {}, 0]) {
    expect(isNoFleet(state)).toBe(false);
  }
  expect(NO_FLEET_TEXT).toBe('No fleet on this Mac yet (~/.ashlr-runs not found). Panes fill in after the leaders’ first pass.');
});
