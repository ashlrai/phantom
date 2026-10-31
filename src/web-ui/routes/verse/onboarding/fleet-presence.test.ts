import { expect, it } from 'vitest';
import { readFleetPresence, whatsNewCopy } from './fleet-presence.js';
import { fleetStepPoints } from './onboarding-model.js';

it.each(['healthy', 'degraded'])('recognizes a %s runs directory as present', runsDir => {
  expect(readFleetPresence({ sources: { runsDir } })).toBe('present');
});

it('recognizes an explicitly missing directory', () => {
  expect(readFleetPresence({ sources: { runsDir: 'missing' } })).toBe('missing');
  expect(fleetStepPoints('missing')).toEqual([{
    label: 'No fleet on this Mac yet (~/.ashlr-runs not found)',
    detail: 'The fleet leaders create it on their first pass; Settings ▸ Connection ▸ Fleet sources shows each source',
  }]);
});

it.each([null, undefined, [], {}, { sources: null }, { sources: [] }, { sources: { runsDir: 'not-landed' } }])('keeps absent or malformed readings unknown: %j', snapshot => {
  expect(readFleetPresence(snapshot)).toBe('unknown');
});

it('offers fleet navigation only with a present fleet', () => {
  expect(whatsNewCopy('present').primary).toEqual({ label: 'Open fleet workspace', action: 'fleet-workspace' });
  expect(whatsNewCopy('missing').primary).toEqual({ label: 'Open Settings ▸ Fleet sources', action: 'fleet-sources' });
  expect(whatsNewCopy('unknown').primary).toEqual({ label: 'Open Settings', action: 'settings' });
  for (const presence of ['missing', 'unknown'] as const) {
    expect(whatsNewCopy(presence).bullets.join(' ')).toMatch(/⌘\/.*Update now in Settings ▸ Desktop/);
    expect(whatsNewCopy(presence).bullets.join(' ')).not.toMatch(/MASON-INBOX|live jobs/);
    expect(fleetStepPoints(presence).map(p => p.detail).join(' ')).not.toMatch(/stop dispatch at once/);
  }
});
