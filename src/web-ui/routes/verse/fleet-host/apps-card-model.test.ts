import { expect, it } from 'vitest';
import { narrowFleetApps, appRows, appActionsFor, appActionConfirmLabel, appActionOutcomeText } from './apps-card-model.js';

const row = { app: 'Codex', running: true, checkedAt: '2026-11-02T00:00:00Z' };
const fixture = { v: 1 as const, generatedAt: row.checkedAt, available: true, apps: [row] };
it('narrows the complete contract and rejects malformed fields', () => {
  expect(narrowFleetApps(fixture)).toEqual(fixture);
  for (const raw of [null, [], {}, { ...fixture, v: 2 }, { ...fixture, generatedAt: null },
    { ...fixture, available: 'yes' }, { ...fixture, apps: {} },
    ...[null, {}, { ...row, app: 3 }, { ...row, app: '' }, { ...row, running: 0 },
      { ...row, running: undefined }, { ...row, checkedAt: null }].map((bad) => ({ ...fixture, apps: [bad] })),
    { ...fixture, apps: [row, row] }]) expect(narrowFleetApps(raw)).toBeNull();
});
it('sorts running first then names without mutating the response; preserves unknown', () => {
  const resp = { ...fixture, apps: [{ ...row, app: 'Safari', running: null },
    { ...row, app: 'Claude', running: false }, row, { ...row, app: 'Chrome' }] };
  expect(appRows(resp).map(({ app, state }) => [app, state])).toEqual([
    ['Chrome', 'running'], ['Codex', 'running'], ['Claude', 'not running'], ['Safari', 'unknown'],
  ]);
  expect(resp.apps[0].app).toBe('Safari');
});
it('offers actions for running, stopped and unknown apps', () => {
  expect(appActionsFor(row)).toEqual(['focus', 'restart']);
  expect(appActionsFor({ ...row, running: false })).toEqual(['launch']);
  expect(appActionsFor({ ...row, running: null })).toEqual(['launch']);
});
it('labels confirmation and displays the accepted outcome code', () => {
  expect(appActionConfirmLabel('Codex', 'restart', false)).toBe('Restart');
  expect(appActionConfirmLabel('Codex', 'restart', true)).toBe('Restart Codex? click again');
  expect(appActionOutcomeText({ app: 'Codex', action: 'launch', code: 'accepted', at: row.checkedAt }))
    .toBe('Codex: launch — accepted');
});
