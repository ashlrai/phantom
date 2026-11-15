import { expect, it } from 'vitest';
import { readUnifiedInboxView, sourceProblems, type UnifiedInboxSources } from './unified-inbox-model.js';

const ok = { state: 'healthy', pending: 0 };
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'bus:b1', source: 'bus', kind: 'bus-work', severity: 'info', blocking: false, title: 't', since: null, expiresAt: null, act: [], ...over,
});
const view = (items: unknown[]) => readUnifiedInboxView({
  schema: 'comms.unified-inbox.v1', total: items.length, omitted: 0,
  sources: { 'needs-you': ok, imessage: ok, drafts: ok, bus: ok, gmail: ok, linkedin: ok }, items,
});
const detailOf = (raw: unknown) => {
  const v = view([entry({ detail: raw })]);
  return v && !v.unavailable ? v.items[0]?.detail : undefined;
};

it('keeps a string detail and omits anything else', () => {
  expect(detailOf('teammate-a · waiting 12m')).toBe('teammate-a · waiting 12m');
  expect(detailOf(42)).toBeUndefined();
  expect(detailOf(undefined)).toBeUndefined();
  expect(detailOf({ a: 1 })).toBeUndefined();
});

it('caps detail at 300 characters', () => {
  expect(detailOf('x'.repeat(500))).toBe('x'.repeat(300));
});

it('sourceProblems gives no entry for healthy sources', () => {
  const sources: UnifiedInboxSources = { 'needs-you': ok, imessage: ok, drafts: ok, bus: ok, gmail: ok, linkedin: ok } as UnifiedInboxSources;
  expect(sourceProblems(sources)).toEqual([]);
});

it('sourceProblems explains each unhealthy state with its command', () => {
  const sources = {
    'needs-you': ok, imessage: { state: 'missing', pending: 0 }, drafts: { state: 'degraded', pending: 2 },
    bus: { state: 'unavailable', pending: 0 }, gmail: { state: 'missing', pending: 0 }, linkedin: ok,
  } as UnifiedInboxSources;
  expect(sourceProblems(sources)).toEqual([
    { source: 'imessage', name: 'iMessage', meaning: 'not set up on this Mac', command: 'phm fleet teammate-texts' },
    { source: 'drafts', name: 'Drafts', meaning: 'read partly; some items may be missing', command: 'phm drafts list --status pending' },
    { source: 'bus', name: 'Bus', meaning: 'could not be read', command: 'phm fleet bus-claim' },
    { source: 'gmail', name: 'Gmail', meaning: 'not set up on this Mac', command: 'phm fleet gmail-archive-plan' },
  ]);
});
