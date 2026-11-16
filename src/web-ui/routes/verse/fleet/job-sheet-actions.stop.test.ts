import { expect, it } from 'vitest';
import { sheetActions } from './job-sheet-actions.js';

it('offers stop only for running jobs, after the other actions', () => {
  const detail = { publish: { prUrl: 'https://github.com/example/repo/pull/12' } };
  expect(sheetActions('job', detail, 'running').map(action => action.id)).toEqual(['log', 'pr', 'steer', 'stop']);
  for (const state of ['queued', 'published', 'archived', undefined]) {
    expect(sheetActions('job', detail, state).map(action => action.id)).toEqual(['log', 'pr', 'steer']);
  }
});
