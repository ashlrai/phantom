import { expect, it } from 'vitest';
import { decisionPr } from './fleet-decisions-model.js';

const title = 'Ship RQ-PHX-EXAMPLE1';
const snapshot = {
  publishesLastHour: [{ job: 'RQ-PHX-EXAMPLE1', url: 'https://github.com/example/repo/pull/42' }],
  mergesLastHour: { items: [{ repo: 'example/repo', number: 42, title: 'bridge: RQ-PHX-EXAMPLE1' }] },
};

it('prefers a merged PR over a published PR', () => {
  expect(decisionPr(title, snapshot)).toEqual({ label: 'PR #42 · merged', href: 'https://github.com/example/repo/pull/42', state: 'merged' });
});

it('shows an unsafe published URL without a link', () => {
  expect(decisionPr(title, { publishesLastHour: [{ job: 'RQ-PHX-EXAMPLE1', url: 'http://github.com/example/repo/pull/42' }] }))
    .toEqual({ label: 'PR · published', href: null, state: 'published' });
  expect(decisionPr(title, { publishesLastHour: snapshot.publishesLastHour }))
    .toEqual({ label: 'PR · published', href: 'https://github.com/example/repo/pull/42', state: 'published' });
});

it('requires a job reference and a safe repository', () => {
  expect(decisionPr('No job here', snapshot)).toBeNull();
  expect(decisionPr(title, { mergesLastHour: { items: [{ ...snapshot.mergesLastHour.items[0], repo: '../repo' }] } }))
    .toEqual({ label: 'PR #42 · merged', href: null, state: 'merged' });
  expect(decisionPr(title, undefined)).toBeNull();
});
