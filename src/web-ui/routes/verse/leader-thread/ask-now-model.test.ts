import { describe, expect, it } from 'vitest';
import { askGate, isAskChord, putBack, REPLY_LIMIT_SECONDS, waitWords } from './ask-now-model.js';

const key = (over: Partial<Parameters<typeof isAskChord>[0]>) => ({ key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, ...over });

describe('ask-now-model', () => {
  it('reads only Cmd or Ctrl with Shift and Enter as the ask chord', () => {
    expect(isAskChord(key({ metaKey: true, shiftKey: true }))).toBe(true);
    expect(isAskChord(key({ ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isAskChord(key({ metaKey: true }))).toBe(false);
    expect(isAskChord(key({ shiftKey: true }))).toBe(false);
    expect(isAskChord(key({ key: 'a', metaKey: true, shiftKey: true }))).toBe(false);
  });

  it('counts the wait in seconds once it is worth counting, and names the limit when it passes', () => {
    expect(waitWords(0)).toBe('Waiting for the Leader’s reply…');
    expect(waitWords(2_999)).toBe('Waiting for the Leader’s reply…');
    expect(waitWords(12_400)).toBe('Waiting for the Leader’s reply… 12s');
    expect(waitWords((REPLY_LIMIT_SECONDS - 1) * 1_000)).toBe('Waiting for the Leader’s reply… 119s');
    expect(waitWords(REPLY_LIMIT_SECONDS * 1_000)).toContain('No reply after 120s. A reply is cut off at 120 seconds');
    // A clock that ran backwards or an unreadable start is no wait at all, never a negative count.
    expect(waitWords(-5_000)).toBe('Waiting for the Leader’s reply…');
    expect(waitWords(Number.NaN)).toBe('Waiting for the Leader’s reply…');
  });

  it('gives the first reason Ask now is off', () => {
    const open = { draft: 'hi', readOnly: false, threadMissing: false, asking: false };
    expect(askGate(open)).toEqual({ can: true, why: expect.stringContaining('at once') });
    expect(askGate({ ...open, draft: '  \n' })).toEqual({ can: false, why: expect.stringContaining('Write something first') });
    expect(askGate({ ...open, asking: true }).why).toContain('answering your last question');
    expect(askGate({ ...open, threadMissing: true, asking: true }).why).toContain('not available on this server');
    expect(askGate({ ...open, readOnly: true, threadMissing: true })).toEqual({ can: false, why: expect.stringContaining('read-only') });
  });

  it('puts refused words back above what was typed since', () => {
    expect(putBack('', 'first')).toBe('first');
    expect(putBack('  ', 'first')).toBe('first');
    expect(putBack('later', 'first')).toBe('first\n\nlater');
  });
});
