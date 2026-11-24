import { expect, it } from 'vitest';
import { projectAccountsSnapshot } from '../usage/usage-contract.js';
import { elapsedWords, leadWords, startWords, windowPace } from './window-pace-model.js';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const window = (over: Partial<Parameters<typeof windowPace>[0]> = {}) => ({
  usedPercent: 40, resetsAt: '2026-11-24T12:00:00.000Z', limitReached: false, measured: true,
  period: { startsAt: '2026-11-17T12:00:00.000Z', basis: 'weekly' as const }, ...over,
});

it('reads time gone and the distance from an even spend off the window itself', () => {
  // Three of seven days gone: 42.9%. 40% used is 3 points behind.
  const pace = windowPace(window(), NOW)!;
  expect(pace).toEqual({ elapsedPct: 42.9, startsAt: '2026-11-17T12:00:00.000Z', basis: 'weekly', lead: -3 });
  expect(elapsedWords(pace)).toBe('43% of the window gone');
  expect(leadWords(pace)).toBe('use is 3 points behind an even spend');
  expect(leadWords(windowPace(window({ usedPercent: 44 }), NOW)!)).toBe('use is 1 point ahead of an even spend');
  expect(leadWords(windowPace(window({ usedPercent: 43 }), NOW)!)).toBe('use is level with an even spend');
});

it('has no pace without a known start, and none for a window that is not the current one', () => {
  expect(windowPace(window({ period: null }), NOW)).toBeNull();
  expect(windowPace(window({ period: undefined }), NOW)).toBeNull();
  expect(windowPace(window({ resetsAt: null }), NOW)).toBeNull();
  expect(windowPace(window({ resetsAt: '2026-11-20T11:59:00.000Z' }), NOW)).toBeNull();
  expect(windowPace(window({ period: { startsAt: '2026-11-21T00:00:00.000Z', basis: 'reported' } }), NOW)).toBeNull();
  expect(windowPace(window({ period: { startsAt: 'soon', basis: 'reported' } }), NOW)).toBeNull();
});

it('keeps time gone but compares nothing when the use is unread or only a limit flag', () => {
  for (const over of [{ usedPercent: null }, { limitReached: true, measured: false, usedPercent: 100 }]) {
    const pace = windowPace(window(over), NOW)!;
    expect(pace.elapsedPct).toBe(42.9);
    expect(pace.lead).toBeNull();
    expect(leadWords(pace)).toBeNull();
  }
});

it('says whether the start was reported or worked out from a weekly reset', () => {
  const at = (iso: string) => `<${iso.slice(0, 10)}>`;
  expect(startWords(windowPace(window(), NOW)!, at)).toBe('began about <2026-11-17>, seven days before its reset');
  expect(startWords(windowPace(window({ period: { startsAt: '2026-11-01T00:00:00.000Z', basis: 'reported' } }), NOW)!, at)).toBe('began <2026-11-01>, as the provider reported');
});

it('takes a window start only from the reset provenance the accounts read carries', () => {
  const win = (id: string, resetProvenance?: unknown) => ({ id, usedPercent: 10, resetsAt: '2026-11-24T12:00:00.000Z', limitReached: false, measured: true, ...(resetProvenance ? { resetProvenance } : {}) });
  const snapshot = projectAccountsSnapshot({ accounts: [{ id: 'a', provider: 'grok', state: 'observed', windows: [
    win('reported', { kind: 'fixed-period', startsAt: '2026-11-01T00:00:00Z', at: '2026-11-24T12:00:00.000Z' }),
    win('weekly', { kind: 'weekly-deadline', at: '2026-11-24T12:00:00Z' }),
    win('bare'),
    win('other-reset', { kind: 'weekly-deadline', at: '2026-11-25T12:00:00.000Z' }),
    win('rolling', { kind: 'rolling-release', at: '2026-11-24T12:00:00.000Z' }),
    win('backwards', { kind: 'fixed-period', startsAt: '2026-11-30T00:00:00Z', at: '2026-11-24T12:00:00.000Z' }),
  ] }] });
  const periods = Object.fromEntries(snapshot!.accounts[0]!.windows.map(w => [w.id, w.period]));
  expect(periods).toEqual({
    reported: { startsAt: '2026-11-01T00:00:00.000Z', basis: 'reported' },
    weekly: { startsAt: '2026-11-17T12:00:00.000Z', basis: 'weekly' },
    bare: undefined, 'other-reset': undefined, rolling: undefined, backwards: undefined,
  });
  // A window with no provenance is the object it was before this field existed.
  expect(snapshot!.accounts[0]!.windows[2]).not.toHaveProperty('period');
});
