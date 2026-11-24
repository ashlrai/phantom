/** RQ-PHX-SLACKLEDGERRECOVERY438S — damaged durable notice evidence must
 * never be read as a partial trusted set. `readClaimNoticeSent` used to
 * skip torn lines, unsupported versions and invalid keys, so a corrupted
 * `claim-notice-sent.jsonl` could hide earlier deliveries and let
 * `runClaimNoticePass` resend ASSIGNED/BLOCKED/VERIFIED notices as though
 * they were never enqueued. The reader now treats ANY nonblank line that
 * is not a valid v1 record as an untrusted ledger (`null`), which the pass
 * already maps to `ledger-unavailable`: zero sends, zero ledger appends,
 * zero snapshot writes, and the evidence file left byte-identical for
 * existing-owner recovery. These tests drive the REAL file-backed deps —
 * private temp roots, synthetic identifiers only, no transport. */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimNoticeFileDeps, runClaimNoticePass,
  type ClaimNoticeSendDeps,
} from '../src/core/fleet/claim-notice-send.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const now = Date.parse('2026-11-14T12:00:00Z');
const THREAD = 'T000FAKE/C000FAKE/1700000000.000001';
const claim = { id: 'claim-fake-438', repo: 'ashlrai/phantom', task: 'fake task', agent: 'fake-owner',
  claimedAt: now - 1000, expiresAt: now + 3_600_000 };
const binding = { claimId: claim.id, repo: claim.repo, threadKey: THREAD, pr: 123, head: 'abcdef1234567890' };
const dedupeKey = JSON.stringify(['ASSIGNED', claim.repo, claim.id, claim.agent, claim.claimedAt, binding.head]);
const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known', claims: [claim],
  messages: [], proposals: [], expiredClaims: 0 };
const validRow = (key: string, at = now) => JSON.stringify({ v: 1, at, key });

describe('claim notice sent-ledger recovery', () => {
  let runsRoot: string;
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
  const passDeps = (send: ClaimNoticeSendDeps['send']): ClaimNoticeSendDeps => ({
    readBoard: () => board, ...claimNoticeFileDeps(runsRoot), send, now: () => now,
  });
  const okSend = () => {
    const calls: { threadKey: string; dedupeKey: string }[] = [];
    return { calls, send: (threadKey: string, _text: string, dedupeKey: string) => {
      calls.push({ threadKey, dedupeKey });
      return { ok: true as const, receipt: 'fake-receipt' };
    } };
  };

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), 'claim-notice-ledger-438-'));
    chmodSync(runsRoot, 0o700);
    seedRuns();
  });
  afterEach(() => {
    rmSync(runsRoot, { recursive: true, force: true });
  });

  it.each([
    ['a torn line', `{"v":1,"at":${now},"key":"${dedupeKey}"`],
    ['an unsupported version', JSON.stringify({ v: 2, at: now, key: dedupeKey })],
    ['an invalid key', JSON.stringify({ v: 1, at: now, key: '' })],
    ['a non-object row', '"just a string"'],
  ])('refuses to send when the ledger mixes valid rows with %s', async (_label, badLine) => {
    const p = paths();
    // One already-delivered notice plus the damaged record: the valid row
    // must not let the pass treat the partial set as the whole ledger.
    writeFileSync(p.sent, `${validRow('key-earlier')}
${validRow(dedupeKey)}
${badLine}
`, { mode: 0o600 });
    const bytesBefore = readFileSync(p.sent);
    const prevBefore = readFileSync(p.prev);
    const { calls, send } = okSend();

    const result = await runClaimNoticePass(passDeps(send));

    expect(result).toMatchObject({ status: 'ledger-unavailable', reason: 'sent-ledger-unreadable',
      planned: 0, sent: 0, failed: 0, skipped: 0, deliveries: [] });
    expect(calls).toHaveLength(0);
    expect(readFileSync(p.sent)).toEqual(bytesBefore);
    expect(readFileSync(p.prev)).toEqual(prevBefore);
    expect(existsSync(p.sent)).toBe(true);
  });

  it('a fully valid ledger still dedupes without sending', async () => {
    const p = paths();
    writeFileSync(p.sent, `${validRow('key-earlier')}\n\n${validRow(dedupeKey)}\n`, { mode: 0o600 });
    const { calls, send } = okSend();

    const result = await runClaimNoticePass(passDeps(send));

    expect(result).toMatchObject({ status: 'completed', planned: 1, sent: 0, skipped: 1, failed: 0 });
    expect(result.deliveries[0]).toMatchObject({ result: 'ledgered', dedupeKey });
    expect(calls).toHaveLength(0);
    const keys = readFileSync(p.sent, 'utf8').split('\n').filter(line => line.trim().length > 0)
      .map(line => (JSON.parse(line) as { key: string }).key);
    expect(keys).toEqual(['key-earlier', dedupeKey]);
  });

  it('a genuinely missing ledger still bootstraps and sends once', async () => {
    const p = paths();
    expect(existsSync(p.sent)).toBe(false);
    const { calls, send } = okSend();

    const result = await runClaimNoticePass(passDeps(send));

    expect(result).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0 });
    expect(calls).toEqual([{ threadKey: THREAD, dedupeKey }]);
    const rows = readFileSync(p.sent, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { key: string });
    expect(rows.map(row => row.key)).toEqual([dedupeKey]);
    expect(JSON.parse(readFileSync(p.prev, 'utf8'))).toMatchObject({ v: 1, state: 'known', asOf: now });
  });

  it('retains legacy ledger fencing for a historically discovered acquisition', async () => {
    const p = paths();
    const legacyKey = JSON.stringify(['ASSIGNED', claim.id, binding.head]);
    writeFileSync(p.prev, JSON.stringify({ v: 1, state: 'known', claims: [], messages: [],
      asOf: claim.claimedAt }), { mode: 0o600 });
    writeFileSync(p.sent, `${validRow(legacyKey)}\n`, { mode: 0o600 });
    const before = readFileSync(p.sent);
    const { calls, send } = okSend();

    const result = await runClaimNoticePass(passDeps(send));

    expect(result).toMatchObject({ status: 'completed', planned: 1, sent: 0, skipped: 1, failed: 0 });
    expect(result.deliveries[0]).toMatchObject({ result: 'ledgered', dedupeKey: legacyKey });
    expect(calls).toHaveLength(0);
    expect(readFileSync(p.sent)).toEqual(before);
  });

  it('does not let an ambiguous legacy key suppress a proven fresh acquisition', async () => {
    const p = paths();
    const legacyKey = JSON.stringify(['ASSIGNED', claim.id, binding.head]);
    writeFileSync(p.sent, `${validRow(legacyKey)}\n`, { mode: 0o600 });
    const { calls, send } = okSend();

    // Legacy rows cannot identify the repo, owner or acquisition clock. An
    // upgrade may enqueue once again, but must never hide a new acquisition.
    const result = await runClaimNoticePass(passDeps(send));
    expect(result).toMatchObject({ status: 'completed', planned: 1, sent: 1, skipped: 0, failed: 0 });
    expect(calls).toEqual([{ threadKey: THREAD, dedupeKey }]);
    const bytes = readFileSync(p.sent);
    expect(bytes.toString().trim().split('\n').map(line => JSON.parse(line).key))
      .toEqual([legacyKey, dedupeKey]);

    // Reconstruct dependencies with the pre-acquisition snapshot to prove
    // that the qualified ledger fences the same transition after restart.
    seedRuns();
    expect(await runClaimNoticePass(passDeps(send)))
      .toMatchObject({ status: 'completed', planned: 1, sent: 0, skipped: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(readFileSync(p.sent)).toEqual(bytes);
  });
});
