import { describe, expect, it } from 'vitest';
import { mentionOptions, recallable, recallStep, stepOption } from './composer-assist-model.js';
import { assistSessions, noSessions } from './composer-assist.test-support.js';

describe('mentionOptions', () => {
  it('offers the running sessions that have an RQ id, quiet ones first, with what each last said', () => {
    const options = mentionOptions(assistSessions(), '');
    expect(options.shown.map(option => option.id)).toEqual(['RQ-QUIET', 'RQ-A', 'RQ-CODEX']);
    expect(options.shown[0]).toMatchObject({ lane: 'claude', kind: 'worker', state: 'quiet', when: 'quiet 14m', said: 'Waiting on a review' });
    expect(options.shown[1]).toMatchObject({ state: 'running', said: 'Running the tests' });
    expect(options).toMatchObject({ more: 0, running: 3 });
  });

  it('keeps an unknown last message unknown and counts the session the steer syntax cannot name', () => {
    const options = mentionOptions(assistSessions(), '');
    expect(options.shown.find(option => option.id === 'RQ-CODEX')!.said).toBeNull();
    expect(options.shown.some(option => option.id === 'helper-a' || option.id === 'RQ-FAILED')).toBe(false);
    expect(options.unnamed).toBe(1);
  });

  it('narrows by job id, lane or last message, an id match first, whatever the case', () => {
    expect(mentionOptions(assistSessions(), 'rq-q').shown.map(option => option.id)).toEqual(['RQ-QUIET']);
    expect(mentionOptions(assistSessions(), 'codex').shown.map(option => option.id)).toEqual(['RQ-CODEX']);
    expect(mentionOptions(assistSessions(), 'tests').shown.map(option => option.id)).toEqual(['RQ-A']);
    expect(mentionOptions(assistSessions(), 'nothing-like-this')).toMatchObject({ shown: [], more: 0, running: 3 });
  });

  it('shows the limit and says how many more match', () => {
    expect(mentionOptions(assistSessions(), '', 2)).toMatchObject({ shown: [{ id: 'RQ-QUIET' }, { id: 'RQ-A' }], more: 1 });
  });

  it('is empty, not broken, when nothing is running', () => {
    expect(mentionOptions(noSessions(), '')).toEqual({ shown: [], more: 0, running: 0, unnamed: 0 });
  });
});

describe('stepOption', () => {
  it('wraps both ways and reports an empty list', () => {
    expect(stepOption(3, 2, 1)).toBe(0);
    expect(stepOption(3, 0, -1)).toBe(2);
    expect(stepOption(0, 0, 1)).toBe(-1);
  });
});

describe('recall', () => {
  it('keeps what was said, oldest first, without blanks or back-to-back repeats', () => {
    expect(recallable(['one', ' ', 'two ', 'two', 'one'])).toEqual(['one', 'two', 'one']);
    expect(recallable(['a', 'b', 'c'], 2)).toEqual(['b', 'c']);
  });

  it('starts from an empty box only, walks older and newer, and ends back at empty', () => {
    const sent = ['first', 'second'];
    expect(recallStep(sent, '', null, -1)).toEqual({ at: 1, text: 'second' });
    expect(recallStep(sent, 'second', 1, -1)).toEqual({ at: 0, text: 'first' });
    expect(recallStep(sent, 'first', 0, -1)).toEqual({ at: 0, text: 'first' });
    expect(recallStep(sent, 'first', 0, 1)).toEqual({ at: 1, text: 'second' });
    expect(recallStep(sent, 'second', 1, 1)).toEqual({ at: null, text: '' });
  });

  it('never takes the arrows from words being written', () => {
    expect(recallStep(['first'], 'my draft', null, -1)).toBeNull();
    expect(recallStep(['first'], 'first, edited', 0, -1)).toBeNull();
    expect(recallStep(['first'], '', null, 1)).toBeNull();
    expect(recallStep([], '', null, -1)).toBeNull();
  });
});
