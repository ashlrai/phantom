import { expect, it } from 'vitest';
import { draftBytes, outcomeText, suggestId, validateDraft, waitingRows } from './drop-job-model.js';
const draft = { id: 'ABC', lane: 'codex-personal', tier: 'mid', body: 'Do useful work' };
it.each([{ id: 'abc' }, { id: 'AB' }, { id: 'A'.repeat(41) }, { id: 'RQ-PHX-ABC' }, { lane: 'other' }, { tier: 'other' }, { body: ' \n' }, { body: 'x'.repeat(8000) }])('rejects invalid draft %j', patch => {
  expect(validateDraft({ ...draft, ...patch }).ok).toBe(false);
});
it('lists all reasons and counts UTF-8 through the exact budget boundary', () => {
  const invalid = validateDraft({ id: '', lane: '', tier: '', body: '' });
  expect(invalid.ok ? [] : invalid.reasons).toHaveLength(4);
  const overhead = draftBytes({ ...draft, body: '' });
  const boundary = { ...draft, body: 'é' + 'x'.repeat(8000 - overhead - 2) };
  expect(validateDraft(boundary)).toEqual({ ok: true, bytes: 8000 });
  expect(validateDraft({ ...boundary, body: boundary.body + 'x' }).ok).toBe(false);
});
it('suggests bounded uppercase ids with a day suffix', () => {
  const now = new Date(2026, 10, 1);
  expect(suggestId('Fix the queue please now extra', now)).toBe('FIXTHEQUEUEPLEASENOW01');
  expect(suggestId('!!!', now)).toBe('JOB01');
  expect(suggestId('a'.repeat(100), now)).toMatch(/^[A-Z0-9]{40}$/);
});
it('sorts oldest first without changing the input and labels seconds, minutes and hours', () => {
  const items = [20, 3600, 120].map(ageSeconds => ({ ...draft, title: 'Title', bytes: 1, ageSeconds }));
  expect(waitingRows(items, 10000000).map(row => row.age)).toEqual(['1 h ago', '2 min ago', '20 s ago']);
  expect(items[0].ageSeconds).toBe(20);
});
it.each([
  [201, { file: '/fake/RQ-PHX-ABC.md', bytes: 42 }, 'Written RQ-PHX-ABC.md (42 bytes)'],
  ['written', { file: 'RQ-PHX-ABC.md', bytes: 42 }, 'Written RQ-PHX-ABC.md (42 bytes)'],
  ['invalid', { reasons: ['Bad id', 'Empty body'] }, 'Invalid draft: Bad id; Empty body'],
  [400, { reasons: ['Bad id'] }, 'Invalid draft: Bad id'],
  [409, {}, 'A job with this id already exists'],
  ['exists', {}, 'A job with this id already exists'],
  [404, {}, 'This server was started without --allow-dispatch, so mutations are disabled.'],
  [401, {}, 'Your session or mutation token was rejected; unlock actions and try again.'],
  [507, {}, 'The drop queue is full; wait for space before trying again.'],
  [500, null, 'The job could not be written; try again.'],
])('explains outcome %s', (status, payload, expected) => expect(outcomeText(status as string | number, payload)).toBe(expected));
