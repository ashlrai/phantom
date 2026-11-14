import { expect, it } from 'vitest';
import { buildWorkResultBody, describeWorkResultError, newReplyId } from './work-result-form-model.js';

it('builds each valid form', () => {
  expect(buildWorkResultBody({ kind: 'pr', value: '12', head: ' abc123 ' })).toEqual({ ok: true, result: { pr: 12, head: 'abc123' } });
  expect(buildWorkResultBody({ kind: 'tests', value: '5 passed' })).toEqual({ ok: true, result: { tests: '5 passed' } });
  expect(buildWorkResultBody({ kind: 'artifact', value: 'fake.log' })).toEqual({ ok: true, result: { artifact: 'fake.log' } });
  expect(buildWorkResultBody({ kind: 'blocked', value: 'fake dep' })).toEqual({ ok: true, result: { blocked: 'fake dep' } });
});

it('rejects invalid forms', () => {
  for (const f of [
    { kind: 'pr' as const, value: '0', head: 'a' },
    { kind: 'pr' as const, value: '-3', head: 'a' },
    { kind: 'pr' as const, value: '1.5', head: 'a' },
    { kind: 'pr' as const, value: 'x', head: 'a' },
    { kind: 'pr' as const, value: '4', head: ' ' },
    { kind: 'pr' as const, value: '4' },
    { kind: 'tests' as const, value: '  ' },
    { kind: 'artifact' as const, value: '' },
    { kind: 'blocked' as const, value: '' },
    { kind: 'blocked' as const, value: 'Unknown' },
    { kind: 'blocked' as const, value: 'x'.repeat(201) },
  ]) expect(buildWorkResultBody(f).ok).toBe(false);
  expect(buildWorkResultBody({ kind: 'blocked', value: 'x'.repeat(200) }).ok).toBe(true);
});

it('describes errors per status', () => {
  expect(describeWorkResultError(404)).toBe('Request not found, or this Phantom build cannot record results yet');
  expect(describeWorkResultError(405)).toBe(describeWorkResultError(404));
  expect(describeWorkResultError(400)).toMatch(/invalid/);
  expect(describeWorkResultError(409)).toMatch(/conflict/);
  expect(describeWorkResultError(503)).toMatch(/unavailable/);
  expect(describeWorkResultError(500)).toMatch(/HTTP 500/);
});

it('mints desk- reply ids that differ', () => {
  const a = newReplyId();
  expect(a).toMatch(/^desk-[0-9a-f-]{36}$/);
  expect(newReplyId()).not.toBe(a);
});
