import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readReplyState, REPLY_STATE_SCHEMA } from '../src/core/comms/reply-state.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';

let root: string;
let now: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reply-text-date-'));
  chmodSync(root, 0o700);
  now = Date.parse('2026-11-14T12:30:00.000Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('keeps the persisted evidence timestamp in shared text across read times', () => {
  const dates = ['2026-11-12T12:30:00.000Z', '2026-11-13T12:30:00.000Z'];
  for (const [index, at] of dates.entries()) {
    const envelope: BusEnvelope = { id: `fake-${index}`, from: 'fake-peer', to: 'fake-lane',
      priority: 'P2', ttl: 1_000_000_000, body: { kind: 'work' } };
    expect(appendBusInbox(envelope, { root, now: () => Date.parse(at) }).status).toBe('posted');
  }
  const first = readReplyState('fake-0', { root, now });
  const second = readReplyState('fake-1', { root, now });
  for (const [state, at] of [[first, dates[0]], [second, dates[1]]] as const) {
    expect(state).toMatchObject({ schema: REPLY_STATE_SCHEMA, state: 'RECEIVED', owner: null,
      claim: null, duplicateOf: null, asOf: at });
    expect(state.source).toBeTruthy();
    expect(state.text).toContain(`source: ${state.source}, evidence timestamp: ${at}`);
    expect(state.text).toContain('no owner yet');
  }
  expect(first.text).not.toBe(second.text);
  now += 86_400_000;
  expect(readReplyState('fake-0', { root, now }).text).toBe(first.text);
  expect(readReplyState('fake-1', { root, now }).text).toBe(second.text);
  const missing = readReplyState('fake-missing', { root, now });
  expect(missing.text).toContain('as of unknown, source:');
  expect(missing.text).not.toContain(new Date(now).toISOString());
});
