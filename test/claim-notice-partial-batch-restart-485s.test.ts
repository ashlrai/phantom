import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass,
  type ClaimNoticeSendDeps } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard,
  type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination write failed: ${result.error}`);
  return result.value;
}

it('resumes only the pending assignment after an unknown board and file-backed restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-partial-485s-'));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const ledger = join(dir, 'coordination.jsonl');
  const root = join(dir, 'runs');
  const paths = claimNoticePaths(root);
  let now = Date.parse('2026-11-16T00:00:00Z');
  let failB = true;
  const attempts: { thread: string; text: string; key: string }[] = [];
  const threadA = 'T000FAKE/C000FAKE/1700000000.000001';
  const threadB = 'T000FAKE/C000FAKE/1700000000.000002';
  const send: ClaimNoticeSendDeps['send'] = (thread, text, key) => {
    attempts.push({ thread, text, key });
    return thread === threadB && failB
      ? { ok: false, reason: 'synthetic-failure' }
      : { ok: true, receipt: 'synthetic-durable-receipt' };
  };
  const options = () => ({ path: ledger, now: now += 5_000 });
  // Every pass reconstructs all file dependencies and the board reader.
  const pass = () => {
    now += 5_000;
    return runClaimNoticePass({ ...claimNoticeFileDeps(root),
      readBoard: () => readFleetBoard({ path: ledger, now }), send, now: () => now });
  };
  must(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'seed', ttlMs: 1 }, options()));
  expect(await pass()).toMatchObject({ status: 'completed', baselined: true, planned: 0, sent: 0 });
  const baseline = readFileSync(paths.prev);
  const a = must(claimFleetWork({ repo: 'fake/alpha', task: 'fake task A', agent: 'fake-owner-a' }, options()));
  const b = must(claimFleetWork({ repo: 'fake/beta', task: 'fake task B', agent: 'fake-owner-b' }, options()));
  const bindingA = { claimId: a.claim.id, repo: 'fake/alpha', threadKey: threadA, pr: 7, head: 'abcdef1234567' };
  const bindingB = { claimId: b.claim.id, repo: 'fake/beta', threadKey: threadB, pr: 9, head: '1234567abcdef' };
  expect(appendClaimThreadBinding(paths.bindings, bindingA, now).ok).toBe(true);
  expect(appendClaimThreadBinding(paths.bindings, bindingB, now).ok).toBe(true);
  const bindingRows = readFileSync(paths.bindings, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(bindingRows).toMatchObject([bindingA, bindingB]);
  const keyA = JSON.stringify(['ASSIGNED', a.claim.id, bindingA.head]);
  const keyB = JSON.stringify(['ASSIGNED', b.claim.id, bindingB.head]);

  const partial = await pass();
  const partialAt = now;
  expect(partial).toMatchObject({ status: 'completed', planned: 2, sent: 1, failed: 1, skipped: 0 });
  expect(partial.deliveries).toMatchObject([
    { threadKey: threadA, dedupeKey: keyA, state: 'ASSIGNED', result: 'sent' },
    { threadKey: threadB, dedupeKey: keyB, state: 'ASSIGNED', result: 'failed', reason: 'synthetic-failure' },
  ]);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toMatchObject({ thread: threadA, key: keyA });
  expect(attempts[1]).toMatchObject({ thread: threadB, key: keyB });
  expect(attempts[0].text).toContain('fake-owner-a');
  expect(attempts[1].text).toContain('fake-owner-b');
  expect(readFileSync(paths.prev)).toEqual(baseline);
  const sentPartial = readFileSync(paths.sent);
  expect(JSON.parse(sentPartial.toString().trim())).toEqual({ v: 1, at: now, key: keyA });

  // An unreadable real board between attempts must not synthesize releases or mutate state.
  const boardBytes = readFileSync(ledger);
  writeFileSync(ledger, 'invalid coordination ledger\n', { mode: 0o600 });
  expect(readFleetBoard({ path: ledger, now }).state).toBe('unknown');
  const unavailable = await pass();
  expect(unavailable).toMatchObject({ status: 'board-unavailable', planned: 0, sent: 0, deliveries: [] });
  expect(attempts).toHaveLength(2);
  expect(readFileSync(paths.prev)).toEqual(baseline);
  expect(readFileSync(paths.sent)).toEqual(sentPartial);
  writeFileSync(ledger, boardBytes, { mode: 0o600 });

  failB = false;
  const recovered = await pass();
  expect(recovered).toMatchObject({ status: 'completed', planned: 2, sent: 1, failed: 0, skipped: 1 });
  expect(recovered.deliveries).toMatchObject([
    { threadKey: threadA, dedupeKey: keyA, state: 'ASSIGNED', result: 'ledgered' },
    { threadKey: threadB, dedupeKey: keyB, state: 'ASSIGNED', result: 'sent' },
  ]);
  expect(attempts).toHaveLength(3);
  expect(attempts[2]).toMatchObject({ thread: threadB, key: keyB });
  expect(attempts.every(attempt => !attempt.text.includes('RELEASED'))).toBe(true);
  const rows = readFileSync(paths.sent, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(rows).toEqual([{ v: 1, at: partialAt, key: keyA },
    { v: 1, at: now, key: keyB }]);
  expect(JSON.parse(readFileSync(paths.prev, 'utf8'))).toMatchObject({
    v: 1, state: 'known', asOf: now, claims: [a.claim, b.claim],
  });
  const settledSnapshot = readFileSync(paths.prev);
  const settledSent = readFileSync(paths.sent);
  expect(await pass()).toMatchObject({ status: 'completed', planned: 0, sent: 0, failed: 0 });
  expect(attempts).toHaveLength(3);
  expect(readFileSync(paths.sent)).toEqual(settledSent);
  expect(JSON.parse(readFileSync(paths.prev, 'utf8')).claims).toEqual(JSON.parse(settledSnapshot.toString()).claims);
});
