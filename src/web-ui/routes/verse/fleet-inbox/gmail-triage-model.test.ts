import { expect, it } from 'vitest';
import { gmailTriageLine, readGmailTriageView, triageAge } from './gmail-triage-model.js';

const SCHEMA = 'fleet.gmail-triage-latest.v1';
const latest = (over: Record<string, unknown> = {}) => ({
  schema: SCHEMA, at: '2026-11-09T10:00:00.000Z', dir: 'fixture-mail', scanned: 100, updates: 9, drafted: 4, review: 7,
  failed: 0, unreadInSample: 18, target: 100, archiveCandidateCount: 62, ...over,
});
const payload = (l: unknown = latest()) => ({ schema: SCHEMA, latest: l });

it('returns null for malformed payloads', () => {
  for (const bad of [null, 'x', 3, [], {}, { schema: 'other', latest: null }, { schema: SCHEMA },
    payload('x'), payload({ ...latest(), schema: 'other' }), payload(latest({ at: 5 })),
    payload(latest({ scanned: -1 })), payload(latest({ drafted: 1.5 })), payload(latest({ target: '100' })),
    payload(latest({ review: undefined })), payload(latest({ unreadInSample: Number.NaN }))]) {
    expect(readGmailTriageView(bad)).toBeNull();
  }
});

it('maps a null latest to never', () => {
  expect(readGmailTriageView(payload(null))).toEqual({ state: 'never' });
});

it('reads a valid record and flags over target both ways', () => {
  const under = readGmailTriageView(payload());
  expect(under).toMatchObject({ state: 'read', scanned: 100, drafted: 4, review: 7, overTarget: false });
  expect(readGmailTriageView(payload(latest({ unreadInSample: 101 })))).toMatchObject({ overTarget: true });
  expect(readGmailTriageView(payload(latest({ unreadInSample: 100 })))).toMatchObject({ overTarget: false });
});

it('words the age in minutes, hours, days and unknown', () => {
  const now = Date.parse('2026-11-09T12:00:00.000Z');
  expect(triageAge('2026-11-09T11:30:00.000Z', now)).toBe('30m ago');
  expect(triageAge('2026-11-09T10:00:00.000Z', now)).toBe('2h ago');
  expect(triageAge('2026-11-06T12:00:00.000Z', now)).toBe('3d ago');
  expect(triageAge('2026-11-09T13:00:00.000Z', now)).toBe('time unknown');
  expect(triageAge('not a date', now)).toBe('time unknown');
});

it('builds the two lines', () => {
  const now = Date.parse('2026-11-09T12:00:00.000Z');
  const read = (over: Record<string, unknown>) => {
    const v = readGmailTriageView(payload(latest(over)));
    if (v?.state !== 'read') throw new Error('expected read');
    return v;
  };
  expect(gmailTriageLine(read({}), now)).toEqual({
    summary: 'Last triage 2h ago · 100 scanned · 4 drafted · 7 to review',
    unread: '18 unread in the sample (target 100)',
  });
  const over = gmailTriageLine(read({ unreadInSample: 130, failed: 2, at: 'bad' }), now);
  expect(over.summary).toBe('Last triage time unknown · 100 scanned · 4 drafted · 7 to review · 2 failed');
  expect(over.unread).toBe('62 archive candidates, unread over target 100');
});
