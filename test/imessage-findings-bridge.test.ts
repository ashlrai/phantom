/**
 * RQ-SWE3-DOTFEED-1: teammate findings mirror onto the local agent bus.
 *
 * Hermetic: runsDir and the bus root are tmp dirs, handles are placeholders,
 * the append/read seams are injectable and nothing reaches chat.db, a model or
 * a transport. Asserts never print message text or handles.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bridgeTeammateFindings, teammateFindingEnvelope, TEAMMATE_FINDINGS_TOPIC, FINDINGS_BATCH_MAX,
} from '../src/core/comms/imessage-findings-bridge.js';
import { markTeammateTextsAnswered, recordTeammateText, senderIdFor } from '../src/core/comms/imessage-teammate-inbox.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { validateBusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { busBodySchema } from '../src/core/agents/bus-v2-schema.js';

const HANDLE = '+15550000002';
const SENDER = senderIdFor(HANDLE);
const NOW = new Date('2026-11-07T12:00:00Z');

let runsDir = '';
let busRoot = '';
const dir = () => join(runsDir, 'imessage');
const busMessages = () => {
  const page = listBusInboxAfter(0, 100, { root: busRoot });
  return page.status === 'ok' ? page.messages : [];
};
const seed = (rowid: number, text: string, at = NOW) =>
  recordTeammateText({ rowid, handle: HANDLE, text }, runsDir, at);
const bridge = (options: Parameters<typeof bridgeTeammateFindings>[0] = {}) =>
  bridgeTeammateFindings({ runsDir, busRoot, now: () => NOW, ...options });

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'imsg-find-runs-'));
  busRoot = mkdtempSync(join(tmpdir(), 'imsg-find-bus-'));
});
afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
  rmSync(busRoot, { recursive: true, force: true });
});

describe('teammateFindingEnvelope', () => {
  const row = { rowid: 11, senderId: SENDER, text: 'gate is red on lane work' };

  it('builds a valid channel-aware note addressed to the findings topic', () => {
    const envelope = teammateFindingEnvelope(row);
    expect(envelope).not.toBeNull();
    expect(envelope).toMatchObject({
      id: 'imessage-teammate-11',
      from: SENDER,
      to: TEAMMATE_FINDINGS_TOPIC,
      priority: 'P2',
      channel: 'imessage',
      channel_ref: 'imessage:teammates:11',
      sender: { agent_id: SENDER, vendor: 'imessage', human: false, team: true },
      external: false,
      body: { kind: 'note', text: row.text, thread: SENDER },
    });
    // A finding is data, never work: the work loop's kind gate cannot claim it.
    expect(envelope!.body).not.toMatchObject({ kind: 'work' });
    expect(busBodySchema.safeParse(envelope!.body).success).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain(HANDLE);
  });

  it('is deterministic so an exact replay dedupes at the store', () => {
    expect(teammateFindingEnvelope(row)!.id).toBe(teammateFindingEnvelope({ ...row, text: 'changed' })!.id);
  });

  it('refuses rows that can never be enveloped instead of truncating', () => {
    expect(teammateFindingEnvelope({ ...row, rowid: 0 })).toBeNull();
    expect(teammateFindingEnvelope({ ...row, senderId: 'imessage:zz' })).toBeNull();
    expect(teammateFindingEnvelope({ ...row, senderId: HANDLE })).toBeNull();
    expect(teammateFindingEnvelope({ ...row, text: '   ' })).toBeNull();
    expect(teammateFindingEnvelope({ ...row, text: 'sk-test-FAKEFAKEFAKE' })).toBeNull();
    expect(teammateFindingEnvelope({ ...row, text: 'x'.repeat(20_000) })).toBeNull();
  });
});

describe('bridgeTeammateFindings', () => {
  it('reports missing when no teammate inbox exists', () => {
    expect(bridge()).toMatchObject({ state: 'missing', examined: 0, posted: 0, lastRowid: 0 });
    expect(busMessages()).toHaveLength(0);
  });

  it('posts every durable row past the watermark, newest rowid last', () => {
    seed(11, 'finding one');
    seed(13, 'finding two');
    markTeammateTextsAnswered([11], runsDir);
    expect(bridge()).toMatchObject({ state: 'healthy', examined: 2, posted: 2, duplicate: 0, refused: 0, pending: 0, lastRowid: 13 });
    const messages = busMessages();
    expect(messages.map((m) => m.envelope.id)).toEqual(['imessage-teammate-11', 'imessage-teammate-13']);
    expect(messages[0]!.envelope.to).toBe(TEAMMATE_FINDINGS_TOPIC);
    expect(messages[0]!.envelope.body).toMatchObject({ kind: 'note', text: 'finding one' });
    expect(messages.every((m) => validateBusEnvelope(m.envelope).ok)).toBe(true);
    const state = JSON.parse(readFileSync(join(dir(), 'findings-bridge.json'), 'utf8')) as Record<string, unknown>;
    expect(state).toMatchObject({ v: 1, lastRowid: 13 });
    expect(statSync(join(dir(), 'findings-bridge.json')).mode & 0o777).toBe(0o600);
  });

  it('bridges rows the responder already answered; findings are independent of replies', () => {
    seed(11, 'a finding with an answer');
    markTeammateTextsAnswered([11], runsDir);
    expect(bridge()).toMatchObject({ posted: 1, lastRowid: 11 });
  });

  it('is a no-op once the watermark covers every row', () => {
    seed(11, 'finding one');
    expect(bridge()).toMatchObject({ posted: 1 });
    expect(bridge()).toMatchObject({ state: 'healthy', examined: 0, posted: 0, duplicate: 0, lastRowid: 11 });
    expect(busMessages()).toHaveLength(1);
  });

  it('dedupes by rowid at the store when the watermark is lost or behind', () => {
    seed(11, 'finding one');
    expect(bridge()).toMatchObject({ posted: 1 });
    writeFileSync(join(dir(), 'findings-bridge.json'), JSON.stringify({ v: 1, lastRowid: 0, at: NOW.toISOString() }), { mode: 0o600 });
    expect(bridge()).toMatchObject({ posted: 0, duplicate: 1, lastRowid: 11 });
    expect(busMessages()).toHaveLength(1);
  });

  it('never reposts after the original envelope expired: the watermark is the dedupe of record', () => {
    seed(11, 'finding one');
    expect(bridge()).toMatchObject({ posted: 1 });
    rmSync(join(busRoot, 'bus-inbox'), { recursive: true, force: true });
    expect(bridge()).toMatchObject({ examined: 0, posted: 0, duplicate: 0 });
    expect(busMessages()).toHaveLength(0);
  });

  it('holds the watermark on a transient store state and retries the same rows', () => {
    seed(11, 'finding one');
    seed(12, 'finding two');
    const append = vi.fn()
      .mockReturnValueOnce({ status: 'posted', id: 'imessage-teammate-11', cursor: 1 })
      .mockReturnValueOnce({ status: 'full' });
    expect(bridge({ append })).toMatchObject({ state: 'pending', examined: 1, posted: 1, pending: 1, lastRowid: 11 });
    expect(bridge({ append: (env) => ({ status: 'posted', id: env.id, cursor: 2 }) })).toMatchObject({ state: 'healthy', posted: 1, pending: 0, lastRowid: 12 });
  });

  it('counts unbridgeable rows as refused and advances past them', () => {
    seed(11, 'fine');
    appendFileSync(join(dir(), 'teammates.jsonl'), `${JSON.stringify({ v: 1, at: NOW.toISOString(), rowid: 12, senderId: SENDER, text: 'sk-test-FAKEFAKEFAKE' })}\n`);
    seed(13, 'also fine');
    expect(bridge()).toMatchObject({ examined: 3, posted: 2, refused: 1, pending: 0, lastRowid: 13 });
    expect(busMessages().map((m) => m.envelope.id)).toEqual(['imessage-teammate-11', 'imessage-teammate-13']);
  });

  it('never revives an expired finding: a row older than the bus TTL is refused, not posted', () => {
    // Review regression: a 30-day-old row posted today would get a fresh
    // 7-day TTL stamped at append time and live on the bus as if new.
    seed(11, 'stale finding', new Date(NOW.getTime() - 30 * 24 * 60 * 60_000));
    seed(12, 'fresh finding');
    expect(bridge()).toMatchObject({ state: 'healthy', examined: 2, posted: 1, refused: 1, pending: 0, lastRowid: 12 });
    expect(busMessages().map((m) => m.envelope.id)).toEqual(['imessage-teammate-12']);
  });

  it('advances the watermark past expired rows so no later pass rescans them', () => {
    seed(11, 'stale finding', new Date(NOW.getTime() - 30 * 24 * 60 * 60_000));
    expect(bridge()).toMatchObject({ posted: 0, refused: 1, lastRowid: 11 });
    // The expired row is behind the watermark: the next pass examines nothing.
    expect(bridge()).toMatchObject({ examined: 0, posted: 0, refused: 0, lastRowid: 11 });
    // A fresh row arriving later still bridges normally.
    seed(12, 'fresh finding');
    expect(bridge()).toMatchObject({ examined: 1, posted: 1, lastRowid: 12 });
    expect(busMessages().map((m) => m.envelope.id)).toEqual(['imessage-teammate-12']);
  });

  it('caps one pass and leaves the rest pending for the next', () => {
    for (let rowid = 1; rowid <= 5; rowid++) seed(rowid, `finding ${rowid}`);
    expect(bridge({ maxBatch: 2 })).toMatchObject({ state: 'pending', examined: 2, posted: 2, pending: 3, lastRowid: 2 });
    expect(bridge({ maxBatch: 2 })).toMatchObject({ examined: 2, posted: 2, pending: 1, lastRowid: 4 });
    expect(bridge()).toMatchObject({ state: 'healthy', pending: 0, lastRowid: 5 });
    expect(busMessages()).toHaveLength(5);
    expect(FINDINGS_BATCH_MAX).toBeGreaterThan(0);
  });

  it('stops on abort without advancing the watermark', () => {
    seed(11, 'finding one');
    seed(12, 'finding two');
    const controller = new AbortController();
    controller.abort();
    expect(bridge({ signal: controller.signal })).toMatchObject({ examined: 0, pending: 2, lastRowid: 0 });
    expect(busMessages()).toHaveLength(0);
  });

  it('survives degraded inbox lines while still bridging the intact rows', () => {
    seed(11, 'finding one');
    appendFileSync(join(dir(), 'teammates.jsonl'), 'this is not json\n');
    seed(12, 'finding two');
    expect(bridge()).toMatchObject({ state: 'degraded', posted: 2, lastRowid: 12 });
    expect(busMessages()).toHaveLength(2);
  });

  it('reports busy when another pass holds the lock and never double-posts', () => {
    seed(11, 'finding one');
    const held = acquireLocalStoreLockWithOutcome(join(dir(), 'findings-bridge.lock'), 0, { anchorPath: dir() });
    expect(held.state).toBe('acquired');
    try {
      expect(bridge()).toMatchObject({ state: 'busy', posted: 0 });
    } finally {
      if (held.state === 'acquired') releaseLocalStoreLock(held.lock);
    }
    expect(bridge()).toMatchObject({ state: 'healthy', posted: 1 });
  });

  it('refuses a corrupt watermark instead of silently resetting it', () => {
    seed(11, 'finding one');
    writeFileSync(join(dir(), 'findings-bridge.json'), '{torn', { mode: 0o600 });
    expect(bridge()).toMatchObject({ state: 'unavailable', posted: 0 });
    expect(busMessages()).toHaveLength(0);
  });

  it('keeps the lock path private and releases it for the next pass', () => {
    seed(11, 'finding one');
    expect(bridge()).toMatchObject({ state: 'healthy', posted: 1 });
    expect(bridge()).toMatchObject({ state: 'healthy', posted: 0 });
    expect(existsSync(join(dir(), 'findings-bridge.lock'))).toBe(false);
  });
});
