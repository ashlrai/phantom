import { describe, expect, it } from 'vitest';
import { classifyOutboxText } from '../src/core/fleet/outbox-kind.js';

describe('classifyOutboxText', () => {
  it.each([
    ['Needs Mason to choose', 'decision'], ['Service FAILED', 'alert'],
    ['The change shipped', 'done'], ['The report is ready', 'fyi'],
    ['redo the copy', 'fyi'], ['undone', 'fyi'], ['approve? it failed', 'decision'],
    ['', 'fyi'], ['Mason, can this proceed?', 'decision'], ['Can you check?', 'decision'],
    ['Is the service ready?', 'fyi'],
  ] as const)('classifies %s as %s', (text, kind) => {
    expect(classifyOutboxText(text)).toBe(kind);
  });
});
