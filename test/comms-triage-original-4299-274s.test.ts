/**
 * RQ-PHX-COMMSTRIAGEORIGINAL274S: exact-preservation matrix for the Comms
 * inbox slice of original PR #4299. src/core/comms-agent/triage.ts is
 * byte-identical to that PR's head (ab8d13fe55f4f004947cc8d21c195a8c3a0541f5,
 * fetched via `git fetch origin pull/4299/head`), so these tests pin the
 * original contract: strict document refusal, field limits, label/identity
 * classification precedence, summary caps and zero deletion. Fixtures only —
 * no transports, network, inbox or home access. A failure here documents a
 * preservation gap; it never authorizes editing the protected implementation.
 */
import { describe, expect, it } from 'vitest';

import { COMMS_TRANSPORTS } from '../src/core/comms-agent/policy.js';
import {
  classifyMessage,
  parseInboxDocument,
  summarizeMessage,
  triageInbox,
  type InboxMessage,
  type MailClass,
} from '../src/core/comms-agent/triage.js';

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'm-1',
  transport: 'email',
  from: 'ada@example.com',
  subject: 'Hello',
  body: 'Body text',
  ...over,
});
const doc = (rows: unknown[]): unknown => ({ messages: rows });
const message = (over: Partial<InboxMessage> = {}): InboxMessage => ({
  id: 'm-1',
  transport: 'email',
  from: 'ada@example.com',
  subject: 'Hello',
  body: 'Body text',
  ...over,
});

describe('parseInboxDocument refusal', () => {
  it('refuses non-documents and non-array messages', () => {
    for (const value of [null, undefined, 42, 'x', [], {}, { messages: 'x' }, { messages: null }, { messages: {} }]) {
      expect(parseInboxDocument(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('accepts an empty inbox and a minimal row', () => {
    expect(parseInboxDocument(doc([]))).toEqual({ messages: [], rows: [] });
    const parsed = parseInboxDocument(doc([row()]));
    expect(parsed?.messages).toEqual([message()]);
    expect(parsed?.rows).toHaveLength(1);
  });

  it('refuses the whole document when any row is invalid, even after valid rows', () => {
    const badRows: unknown[] = [
      null, 'x', [], 7,
      row({ id: undefined }), row({ id: 7 }), row({ id: '' }), row({ id: '   ' }), row({ id: 'x'.repeat(129) }),
      row({ transport: 'pigeon' }), row({ transport: '' }), row({ transport: undefined }),
      row({ from: 'x'.repeat(257) }), row({ from: 'a\nb@example.com' }),
      row({ subject: 'x'.repeat(301) }), row({ subject: 'one\ntwo' }), row({ subject: 'del\x7f' }),
      row({ body: 7 }), row({ body: 'x'.repeat(64 * 1024 + 1) }),
      row({ labels: 'bulk' }), row({ labels: [1] }), row({ labels: ['x'.repeat(65)] }),
      row({ labels: ['has\ttab'] }), row({ labels: Array.from({ length: 17 }, (_, i) => `l${i}`) }),
    ];
    for (const bad of badRows) {
      expect(parseInboxDocument(doc([row(), bad])), JSON.stringify(bad)).toBeNull();
      expect(parseInboxDocument(doc([bad, row()]))).toBeNull();
    }
  });

  it('accepts fields exactly at their limits', () => {
    const labels = Array.from({ length: 16 }, (_, i) => `label-${i}-${'x'.repeat(55)}`);
    const parsed = parseInboxDocument(doc([row({
      id: 'x'.repeat(128),
      from: 'x'.repeat(256),
      subject: 'x'.repeat(300),
      body: 'x'.repeat(64 * 1024),
      labels,
    })]));
    expect(parsed).not.toBeNull();
    expect(parsed?.messages[0]?.labels).toHaveLength(16);
  });

  it('trims id into messages but preserves the raw row, including unknown fields', () => {
    const parsed = parseInboxDocument(doc([row({ id: '  m-9  ', threadId: 'thr-1', receivedAt: '2026-11-01' })]));
    expect(parsed?.messages[0]?.id).toBe('m-9');
    expect(parsed?.messages[0]).not.toHaveProperty('threadId');
    expect(parsed?.rows[0]).toMatchObject({ id: '  m-9  ', threadId: 'thr-1', receivedAt: '2026-11-01' });
  });

  it('allows control characters in body only; bounded fields reject them', () => {
    const parsed = parseInboxDocument(doc([row({ body: 'line one\nline two\tend' })]));
    expect(parsed?.messages[0]?.body).toBe('line one\nline two\tend');
    expect(parseInboxDocument(doc([row({ from: 'a\x01b' })]))).toBeNull();
    expect(parseInboxDocument(doc([row({ id: 'm\x02' })]))).toBeNull();
  });

  it('accepts every transport in the current contract and refuses others', () => {
    for (const transport of COMMS_TRANSPORTS) {
      const parsed = parseInboxDocument(doc([row({ transport })]));
      expect(parsed?.messages[0]?.transport, transport).toBe(transport);
    }
    expect(parseInboxDocument(doc([row({ transport: 'carrier-pigeon' })]))).toBeNull();
  });
});

describe('classifyMessage precedence', () => {
  const cases: Array<[string, Partial<InboxMessage>, readonly string[], MailClass]> = [
    ['bulk label', { labels: ['bulk'] }, [], 'bulk'],
    ['newsletter label', { labels: ['Newsletter'] }, [], 'bulk'],
    ['list-unsubscribe label', { labels: ['list-unsubscribe'] }, [], 'bulk'],
    ['bot label', { labels: ['bot'] }, [], 'bot'],
    ['automated label case-insensitive', { labels: ['Automated'] }, [], 'bot'],
    ['bulk beats bot', { labels: ['bot', 'bulk'] }, [], 'bulk'],
    ['bulk label beats owner id', { labels: ['bulk'] }, ['ada@example.com'], 'bulk'],
    ['bot label beats owner id', { labels: ['bot'] }, ['ada@example.com'], 'bot'],
    ['owner id', {}, ['ada@example.com'], 'owner'],
    ['owner id match trims from', { from: '  ada@example.com  ' }, ['ada@example.com'], 'owner'],
    ['non-owner sender is person', {}, ['someone-else@example.com'], 'person'],
    ['empty from is unknown', { from: '   ' }, ['ada@example.com'], 'unknown'],
    ['unrecognized labels do not rescue empty from', { from: '   ', labels: ['priority'] }, [], 'unknown'],
    ['no labels no owner is person', {}, [], 'person'],
  ];
  it.each(cases)('%s', (_name, over, ownerIds, expected) => {
    expect(classifyMessage(message(over), ownerIds)).toBe(expected);
  });
});

describe('summarizeMessage', () => {
  it('prefixes class, collapses whitespace and caps at 160 chars', () => {
    expect(summarizeMessage(message({ subject: '  two\n\n spaces  ' }), 'person')).toBe('person: two spaces');
    const long = summarizeMessage(message({ subject: 's'.repeat(300) }), 'bulk');
    expect(long).toHaveLength(160);
    expect(long.startsWith('bulk: ')).toBe(true);
  });

  it('redacts a secret-shaped subject and leaves a clean one untouched', () => {
    const fakeKey = ['sk', 'ant', 'api03', 'A'.repeat(40)].join('-');
    expect(summarizeMessage(message({ subject: `token ${fakeKey} here` }), 'person')).toBe('person: [redacted]');
    expect(summarizeMessage(message({ body: `key ${fakeKey}` }), 'person')).toBe('person: Hello');
  });
});

describe('triageInbox', () => {
  it('keeps owner/person/unknown, archives bulk/bot, drafts only for owner and person, deletes nothing', () => {
    const ownerIds = ['boss@example.com'];
    const input: InboxMessage[] = [
      message({ id: 'bulk-1', labels: ['bulk'], from: 'news@lists.example' }),
      message({ id: 'bot-1', transport: 'imessage', labels: ['bot'], from: 'alerts' }),
      message({ id: 'owner-1', from: 'boss@example.com', subject: 'Ship it?' }),
      message({ id: 'person-1', from: 'ada@example.com', subject: 'Question' }),
      message({ id: 'unknown-1', from: '   ' }),
    ];
    const result = triageInbox(input, ownerIds);
    expect(result.deleted).toBe(0);
    expect(result.kept.map(m => m.id)).toEqual(['owner-1', 'person-1', 'unknown-1']);
    expect(result.archived.map(m => m.id)).toEqual(['bulk-1', 'bot-1']);
    expect(result.summaries.map(s => [s.id, s.class])).toEqual([
      ['bulk-1', 'bulk'], ['bot-1', 'bot'], ['owner-1', 'owner'], ['person-1', 'person'], ['unknown-1', 'unknown'],
    ]);
    expect(result.drafts.map(d => d.messageId)).toEqual(['owner-1', 'person-1']);
    const ownerDraft = result.drafts[0]!;
    expect(ownerDraft).toMatchObject({ transport: 'email', recipient: 'boss@example.com', subject: 'Re: Ship it?' });
    expect(ownerDraft.body).toContain('Draft reply.');
    expect(ownerDraft.body).toContain('owner: Ship it?');
    expect(result.kept.length + result.archived.length).toBe(input.length);
    expect(result.archived[0]).toBe(input[0]);
  });

  it('returns an empty result for an empty inbox and never deletes', () => {
    expect(triageInbox([], [])).toEqual({ kept: [], archived: [], drafts: [], summaries: [], deleted: 0 });
    const result = triageInbox([message({ labels: ['newsletter'] })], []);
    expect(result.deleted).toBe(0);
    expect(result.archived).toHaveLength(1);
    expect(result.drafts).toEqual([]);
  });
});
