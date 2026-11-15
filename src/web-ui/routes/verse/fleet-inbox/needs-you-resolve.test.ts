import { expect, it } from 'vitest';
import { needsYouLedgerId, needsYouResolveOutcome } from './needs-you-resolve.js';

it('accepts only valid Needs-you ledger ids', () => {
  const item = (id: string, kind: 'needs-you' | 'teammate-text' = 'needs-you') => ({ id, kind });
  expect(needsYouLedgerId(item('needs-you:A._:-9'))).toBe('A._:-9');
  expect(needsYouLedgerId(item(`needs-you:${'a'.repeat(128)}`))).toHaveLength(128);
  for (const id of ['needs-you:', 'needs-you:a b', 'needs-you:a/b', `needs-you:${'a'.repeat(129)}`, 'other:a']) {
    expect(needsYouLedgerId(item(id))).toBeNull();
  }
  expect(needsYouLedgerId(item('needs-you:a', 'teammate-text'))).toBeNull();
});

it('describes each HTTP outcome', () => {
  expect(needsYouResolveOutcome(200, null)).toBe('Resolved.');
  expect(needsYouResolveOutcome(409, null)).toBe('Already resolved.');
  expect(needsYouResolveOutcome(404, null)).toBe('No longer on the list.');
  expect(needsYouResolveOutcome(503, null)).toBe('The Needs-you ledger is unavailable. Try again.');
  expect(needsYouResolveOutcome(500, null)).toBe('Could not resolve. Try again.');
});
