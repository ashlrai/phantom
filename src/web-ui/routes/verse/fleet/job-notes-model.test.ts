import { expect, it } from 'vitest';
import type { FleetJobTextV1 } from '../../../../core/fleet/runs-job-texts.js';
import { closesRefs, notesHeadline, notesPreview } from './job-notes-model.js';

const notes: FleetJobTextV1 = { v: 1, job: 'RQ-PHX-FOO', kind: 'notes', state: 'ok', bytes: 10, truncated: false, text: 'First\nSecond\n\n' };

it('finds distinct closing references in order without partial numbers or URLs', () => {
  expect(closesRefs('Closes #1234\nfixes: #7\nRESOLVES #1234\nCloses #12abc\nhttps://example.com/Closes#42')).toEqual([1234, 7]);
  expect(closesRefs(Array.from({ length: 12 }, (_, index) => `Closes #${index + 1}`).join('\n'))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

it('describes each notes state and counts nonblank trailing lines', () => {
  expect(notesHeadline(null)).toBe('Notes not in this build');
  expect(notesHeadline(undefined)).toBe('Notes not in this build');
  expect(notesHeadline({ ...notes, state: 'missing' })).toBe('No bridge notes yet');
  expect(notesHeadline({ ...notes, state: 'unreadable' })).toBe('Bridge notes unreadable');
  expect(notesHeadline(notes)).toBe('Bridge notes · 2 lines');
  expect(notesHeadline({ ...notes, truncated: true })).toBe('Bridge notes · 2 lines · truncated');
  expect(notesHeadline({ ...notes, text: '\n ' })).toBe('Bridge notes · 0 lines');
});

it('limits the preview to 40 lines after trimming trailing blank lines', () => {
  const lines = Array.from({ length: 43 }, (_, index) => `Line ${index + 1}`);
  expect(notesPreview(`${lines.join('\n')}\n  \n`)).toEqual({ lines: lines.slice(0, 40), more: 3 });
  expect(notesPreview('one\ntwo', 1)).toEqual({ lines: ['one'], more: 1 });
});
