import { describe, expect, it } from 'vitest';
import { sheetActions, steerPrefill } from './job-sheet-actions.js';

describe('job sheet actions', () => {
  it('formats steering context with or without a lane', () => {
    expect(steerPrefill('RQ-PHX-FOO', 'codex-personal')).toBe('Re RQ-PHX-FOO (codex-personal): ');
    expect(steerPrefill('RQ-PHX-FOO', null)).toBe('Re RQ-PHX-FOO: ');
  });

  it('only offers a PR action for a valid HTTPS URL', () => {
    const url = 'https://github.com/example/repo/pull/12';
    expect(sheetActions('RQ-PHX-FOO', { publish: { prUrl: url } })).toEqual([
      { id: 'log', label: 'Open worker log' },
      { id: 'pr', label: 'Open PR #12', href: url },
      { id: 'steer', label: 'Steer this worker' },
    ]);
    for (const prUrl of [null, 'http://github.com/example/repo/pull/12', 'javascript:alert(1)', 'not a url']) {
      expect(sheetActions('RQ-PHX-FOO', { publish: { prUrl } }).map(action => action.id)).toEqual(['log', 'steer']);
    }
    expect(sheetActions('RQ-PHX-FOO', undefined).map(action => action.id)).toEqual(['log', 'steer']);
  });
});
