import { describe, expect, it } from 'vitest';
import { ideaSteerText, ideaSteeredLabel } from './idea-steer-model.js';

const idea = { title: 'Add retries', repo: 'phantom' };

describe('ideaSteerText', () => {
  it('builds both verdict lines', () => {
    expect(ideaSteerText(idea, 'do-next')).toBe('[idea:phantom] Do next: Add retries');
    expect(ideaSteerText(idea, 'not-now')).toBe('[idea:phantom] Not now: Add retries');
  });
  it('appends a trimmed single-line note capped at 200 chars', () => {
    expect(ideaSteerText(idea, 'do-next', '  soon\n please ')).toBe('[idea:phantom] Do next: Add retries · soon please');
    expect(ideaSteerText(idea, 'do-next', '   ')).toBe('[idea:phantom] Do next: Add retries');
    const line = ideaSteerText(idea, 'do-next', 'n'.repeat(500))!;
    expect(line.endsWith(` · ${'n'.repeat(200)}`)).toBe(true);
  });
  it('strips control characters and caps the title at 160', () => {
    expect(ideaSteerText({ ...idea, title: 'a\u0000b\r\nc\u0085d\td' }, 'do-next')).toBe('[idea:phantom] Do next: a b c d d');
    const line = ideaSteerText({ ...idea, title: 'x'.repeat(400) }, 'not-now')!;
    expect(line).toBe(`[idea:phantom] Not now: ${'x'.repeat(160)}`);
    expect(line).not.toMatch(/[\u0000-\u001f]/);
  });
  it('returns null for an empty title', () => {
    expect(ideaSteerText({ ...idea, title: ' \n\u0007 ' }, 'do-next')).toBeNull();
  });
});

describe('ideaSteeredLabel', () => {
  it('words the age', () => {
    const now = 10_000_000;
    expect(ideaSteeredLabel('do-next', now, now)).toBe('Sent: do next · just now');
    expect(ideaSteeredLabel('not-now', now - 3 * 60_000, now)).toBe('Sent: not now · 3m ago');
    expect(ideaSteeredLabel('do-next', now - 2 * 3_600_000, now)).toBe('Sent: do next · 2h ago');
    expect(ideaSteeredLabel('do-next', now - 50 * 3_600_000, now)).toBe('Sent: do next · 2d ago');
  });
});
