import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { appendBusInbox, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { collectBusWorkItemEvidence, deriveBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { classifyWorkItem } from '../src/core/comms/work-item-state.js';

const now = Date.parse('2026-11-22T12:00:00Z');
const id = 'fake-request';
const request: BusInboxReceipt = { cursor: 2, receivedAt: now - 1000,
  envelope: { id, from: 'fake-peer', to: 'fake-lane', priority: 'P1', ttl: 10_000_000, body: {} } };
const reply = (cursor: number, receivedAt: number, body: Record<string, unknown>): BusInboxReceipt => ({
  cursor, receivedAt, envelope: { ...request.envelope, id: `fake-reply-${cursor}`, body: { inReplyTo: id, ...body } },
});
const derive = (rows: BusInboxReceipt[]) => deriveBusWorkItemEvidence(id, rows, [], now);
const classify = (rows: BusInboxReceipt[]) => classifyWorkItem(derive(rows).evidence, new Date(now).toISOString());

it('selects each kind by cursor across permutations without changing the input', () => {
  const rows = [request,
    reply(3, now - 100, { verified: { tests: 'older' }, blocked: { dependency: 'older' } }),
    reply(4, now - 200, { blocked: { dependency: 'newer' } }),
    reply(5, now - 300, { verified: { tests: 'newer' } }),
    reply(6, now + 300_001, { verified: { tests: 'future' }, blocked: { dependency: 'future' } }),
    reply(7, NaN, { verified: { tests: 'invalid' }, blocked: { dependency: 'invalid' } }),
    reply(8, request.receivedAt - 1, { verified: { tests: 'old generation' }, blocked: { dependency: 'old generation' } }),
    reply(1, now, { verified: { tests: 'old cursor' }, blocked: { dependency: 'old cursor' } }),
  ];
  const expected = derive(rows);
  expect(expected.evidence.verified).toMatchObject({ tests: 'newer', source: 'bus-reply:fake-reply-5' });
  expect(expected.evidence.blocker).toMatchObject({ dependency: 'newer', source: 'bus-reply:fake-reply-4' });
  expect(classify(rows)).toMatchObject({ state: 'VERIFIED', source: 'bus-reply:fake-reply-5' });
  for (let shift = 0; shift < rows.length; shift++) {
    for (const order of [rows.slice(shift).concat(rows.slice(0, shift)), [...rows].reverse().slice(shift).concat([...rows].reverse().slice(0, shift))]) {
      const before = structuredClone(order);
      expect(derive(order)).toEqual(expected);
      expect(classify(order)).toEqual(classify(rows));
      expect(order).toEqual(before);
    }
  }
  const blocked = rows.filter(row => row.cursor !== 5 && row.cursor !== 3);
  expect(classify(blocked)).toMatchObject({ state: 'BLOCKED', source: 'bus-reply:fake-reply-4' });
});

it('collects cursor-selected evidence from a temporary durable inbox', () => {
  const root = mkdtempSync(join(tmpdir(), 'reply-order-'));
  try {
    for (const row of [request, reply(3, now - 100, { blocked: { dependency: 'first' } }),
      reply(4, now - 200, { blocked: { dependency: 'second' } }),
      reply(5, now - 300, { verified: { tests: 'passed' } })]) {
      expect(appendBusInbox(row.envelope, { root, now: () => row.receivedAt }).status).toBe('posted');
    }
    const file = join(root, 'bus-inbox/messages.json');
    const before = readFileSync(file, 'utf8');
    const result = collectBusWorkItemEvidence(id, { root, now });
    expect(result.sources.inbox).toBe('found');
    expect(result.evidence.blocker).toMatchObject({ dependency: 'second' });
    expect(classifyWorkItem(result.evidence, new Date(now).toISOString()))
      .toMatchObject({ state: 'VERIFIED', source: 'bus-reply:fake-reply-5' });
    expect(readFileSync(file, 'utf8')).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
