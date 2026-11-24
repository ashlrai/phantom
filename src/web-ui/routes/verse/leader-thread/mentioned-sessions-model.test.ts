import { describe, expect, it } from 'vitest';
import { rosterEmpty, rosterFleet } from './leader-roster.test-support.js';
import { mentionedSessions, splitMentioned } from './mentioned-sessions-model.js';

describe('splitMentioned', () => {
  it('keeps jobs and pull requests apart, in the order they were named', () => {
    expect(splitMentioned(['RQ-A', 'FIX-B', '#42', 'acme/app#7'])).toEqual({ jobs: ['RQ-A', 'FIX-B'], pulls: ['#42', 'acme/app#7'] });
    expect(splitMentioned([])).toEqual({ jobs: [], pulls: [] });
  });
});

describe('mentionedSessions', () => {
  it('says what each named job is doing now, from the session list', () => {
    const rows = mentionedSessions(['RQ-A', 'RQ-QUIET', 'RQ-FAILED', 'RQ-PR'], rosterFleet());
    expect(rows).toEqual([
      { job: 'RQ-A', state: 'running', words: 'running · claude · spoke 2m ago', said: 'Running the tests' },
      { job: 'RQ-QUIET', state: 'quiet', words: 'quiet 14m · claude', said: null },
      { job: 'RQ-FAILED', state: 'failed', words: 'failed · claude', said: null },
      { job: 'RQ-PR', state: 'running', words: 'running · codex-local · spoke 2m ago', said: null },
    ]);
  });

  it('never calls a job the list does not hold finished or idle', () => {
    expect(mentionedSessions(['RQ-GONE'], rosterFleet())).toEqual([{ job: 'RQ-GONE', state: 'absent', words: 'not in the session list', said: null }]);
    expect(mentionedSessions(['RQ-A'], rosterEmpty())).toEqual([{ job: 'RQ-A', state: 'absent', words: 'not in the session list', said: null }]);
  });

  it('keeps an unread list apart from one still being read', () => {
    expect(mentionedSessions(['RQ-A'], null)).toEqual([{ job: 'RQ-A', state: 'unread', words: 'state unknown', said: null }]);
    expect(mentionedSessions(['RQ-A'], undefined)).toEqual([{ job: 'RQ-A', state: 'reading', words: 'reading state', said: null }]);
    expect(mentionedSessions([], rosterFleet())).toEqual([]);
  });
});
