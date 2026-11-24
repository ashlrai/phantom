/** RQ-PHX-SLACKNOTICECONFLICT436S — a bus 'conflict' is not an enqueue
 * receipt. `claimNoticeSlackSender` mints a deterministic envelope id per
 * dedupeKey, but `appendBusInbox` returns 'conflict' for ANY differing
 * envelope under that id — it cannot prove destination, thread, body or
 * provenance equivalence. The sender must therefore report conflict as an
 * honest failure (`bus-conflict`), never as `ok` with a synthetic
 * `bus-note:` receipt: only 'posted' or an identical 'duplicate' may
 * establish durable enqueue. These tests drive the REAL sender and the
 * REAL `runClaimNoticePass` against temporary file-backed bus and state
 * roots with fake Slack identifiers only — no transport ever leaves. A
 * conflict leaves the sent ledger and prev snapshot untouched so the
 * notice stays pending and retryable; posted and byte-identical duplicate
 * outcomes still ledger and advance normally. */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimNoticeSlackSender } from '../src/cli/fleet-claim-notices.js';
import {
  claimNoticeFileDeps, runClaimNoticePass,
  type ClaimNoticeSendDeps,
} from '../src/core/fleet/claim-notice-send.js';
import type { AgentNetworkConfig } from '../src/core/agents/slack-network.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const now = Date.parse('2026-11-14T12:00:00Z');
const TEAM = 'T000FAKE';
const CHANNEL = 'C000FAKE';
const THREAD = `${TEAM}/${CHANNEL}/1700000000.000001`;
const OTHER_THREAD = `${TEAM}/${CHANNEL}/1700000000.000002`;
const claim = { id: 'claim-fake-436', repo: 'ashlrai/phantom', task: 'fake task', agent: 'fake-owner',
  claimedAt: now - 1000, expiresAt: now + 3_600_000 };
const binding = { claimId: claim.id, repo: claim.repo, threadKey: THREAD, pr: 123, head: 'abcdef1234567890' };
// A known-absent snapshot before claimedAt makes this a fresh acquisition.
// Preseed the exact current identity so the conflict proof exercises a collision.
const dedupeKey = JSON.stringify(['ASSIGNED', claim.repo, claim.id, claim.agent, claim.claimedAt, binding.head]);
const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known', claims: [claim],
  messages: [], proposals: [], expiredClaims: 0 };
const config: AgentNetworkConfig = {
  path: 'fake-agent-network.toml', state: 'ok', teamIdentities: [],
  slack: { bridgeId: 'slack', teamId: TEAM, map: [{ topic: 'fleet.claims', channel: CHANNEL }] },
};

interface StoredRow { cursor: number; receivedAt: number; envelope: { id: string; channel_ref?: string; body: { text?: string } } }

describe('claim notice bus conflict', () => {
  let busRoot: string, runsRoot: string;
  const paths = () => ({
    bindings: join(runsRoot, 'claim-thread-bindings.jsonl'),
    sent: join(runsRoot, 'claim-notice-sent.jsonl'),
    prev: join(runsRoot, 'claim-notice-prev.json'),
  });
  const seedRuns = () => {
    const p = paths();
    writeFileSync(p.bindings, JSON.stringify({ v: 1, ...binding }) + '\n', { mode: 0o600 });
    writeFileSync(p.prev, JSON.stringify({ v: 1, state: 'known', claims: [], messages: [],
      asOf: now - 60_000 }), { mode: 0o600 });
  };
  const inboxRows = (): StoredRow[] =>
    (JSON.parse(readFileSync(join(busRoot, 'bus-inbox', 'messages.json'), 'utf8')) as { rows: StoredRow[] }).rows;
  const passDeps = (send: ClaimNoticeSendDeps['send'], over: Partial<ClaimNoticeSendDeps> = {}): ClaimNoticeSendDeps => ({
    readBoard: () => board, ...claimNoticeFileDeps(runsRoot), send, now: () => now, ...over,
  });

  beforeEach(() => {
    busRoot = mkdtempSync(join(tmpdir(), 'claim-notice-bus-436-'));
    runsRoot = mkdtempSync(join(tmpdir(), 'claim-notice-runs-436-'));
    chmodSync(busRoot, 0o700);
    chmodSync(runsRoot, 0o700);
  });
  afterEach(() => {
    rmSync(busRoot, { recursive: true, force: true });
    rmSync(runsRoot, { recursive: true, force: true });
  });

  it('sender: conflict is an honest failure; posted and identical duplicate still succeed', async () => {
    const send = claimNoticeSlackSender(busRoot, () => config);
    const first = await send(THREAD, 'ASSIGNED: earlier as-of text', dedupeKey);
    expect(first.ok).toBe(true);
    const receipt = (first as { receipt: string }).receipt;
    expect(receipt).toMatch(/^bus-note:claim-notice-[0-9a-f]{24}$/);
    const id = receipt.slice('bus-note:'.length);

    // The byte-identical retry is a transport duplicate, still a receipt.
    const dup = await send(THREAD, 'ASSIGNED: earlier as-of text', dedupeKey);
    expect(dup).toEqual({ ok: true, receipt });

    // A different thread and body under the same deterministic id is a
    // conflict: failure with a fixed safe reason, no receipt, and the
    // stored envelope is neither replaced nor echoed back.
    const conflict = await send(OTHER_THREAD, 'ASSIGNED: conflicting as-of text', dedupeKey);
    expect(conflict).toEqual({ ok: false, reason: 'bus-conflict' });
    const rows = inboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.envelope.id).toBe(id);
    expect(rows[0]!.envelope.channel_ref).toBe(THREAD);
    expect(rows[0]!.envelope.body.text).toBe('ASSIGNED: earlier as-of text');
    const raw = readFileSync(join(busRoot, 'bus-inbox', 'messages.json'), 'utf8');
    expect(raw).not.toContain('conflicting as-of text');
    expect(raw).not.toContain(OTHER_THREAD);
  });

  it('pass: a bus conflict fails the notice, fences nothing and stays retryable', async () => {
    seedRuns();
    const send = claimNoticeSlackSender(busRoot, () => config);
    // Preseed the deterministic id with an earlier pass's differing text —
    // exactly what a retry after changed as-of wording collides with.
    const preseed = await send(THREAD, 'ASSIGNED: stale as-of text', dedupeKey);
    expect(preseed.ok).toBe(true);
    const prevBefore = readFileSync(paths().prev);

    const deps = passDeps(send);
    const first = await runClaimNoticePass(deps);
    expect(first).toMatchObject({ status: 'completed', planned: 1, sent: 0, failed: 1 });
    expect(first.deliveries[0]).toMatchObject({ result: 'failed', reason: 'bus-conflict', dedupeKey });
    expect(first.deliveries[0]!.receipt).toBeUndefined();
    expect(existsSync(paths().sent)).toBe(false);
    expect(readFileSync(paths().prev)).toEqual(prevBefore);

    // The failed notice was never ledgered, so the next pass re-plans and
    // re-attempts the send instead of skipping it as delivered.
    const second = await runClaimNoticePass(deps);
    expect(second).toMatchObject({ status: 'completed', planned: 1, sent: 0, failed: 1 });
    expect(second.deliveries[0]).toMatchObject({ result: 'failed', reason: 'bus-conflict' });
    expect(existsSync(paths().sent)).toBe(false);
    expect(readFileSync(paths().prev)).toEqual(prevBefore);
  });

  it('pass: posted then identical duplicate still ledger and advance the snapshot', async () => {
    seedRuns();
    const send = claimNoticeSlackSender(busRoot, () => config);
    const files = claimNoticeFileDeps(runsRoot);
    let ledgerFails = true;
    const deps = passDeps(send, {
      // First pass: the bus post lands but the ledger append fails, leaving
      // the notice pending — the send-succeeded/ledger-failed gap.
      appendSentLedger: (key, at) => {
        if (ledgerFails) { ledgerFails = false; throw new Error('fake disk full'); }
        return files.appendSentLedger(key, at);
      },
    });
    const prevBefore = readFileSync(paths().prev);

    const first = await runClaimNoticePass(deps);
    expect(first.deliveries[0]).toMatchObject({ result: 'failed', reason: 'ledger-append-failed' });
    expect(readFileSync(paths().prev)).toEqual(prevBefore);
    expect(existsSync(paths().sent)).toBe(false);

    // Same pass clock → byte-identical envelope → bus 'duplicate' counts as
    // durably enqueued, so the retry ledgers and the snapshot advances.
    const second = await runClaimNoticePass(deps);
    expect(second).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0 });
    expect(second.deliveries[0]).toMatchObject({ result: 'sent', dedupeKey });
    expect(String(second.deliveries[0]!.receipt)).toMatch(/^bus-note:claim-notice-[0-9a-f]{24}$/);
    const sentRows = readFileSync(paths().sent, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { key: string });
    expect(sentRows.map(row => row.key)).toEqual([dedupeKey]);
    expect(JSON.parse(readFileSync(paths().prev, 'utf8'))).toMatchObject({ v: 1, state: 'known', asOf: now });

    const third = await runClaimNoticePass(deps);
    expect(third).toMatchObject({ status: 'completed', planned: 0, sent: 0, skipped: 0 });
    expect(inboxRows()).toHaveLength(1);
  });
});
