import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass,
  type ClaimNoticeSendDeps } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard,
  type FleetCoordinationResult } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';

const HEAD_A = 'abcdef1234567890';
const HEAD_B = '1234567890abcdef';
const SIBLING_HEAD = 'fedcba9876543210';
const THREAD = 'TFAKE/CFAKE/1700000000.000001';
const SIBLING_THREAD = 'TFAKE/CFAKE/1700000000.000002';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination write failed: ${result.error}`);
  return result.value;
}

it('delivers a corrected PR head once without replaying an unchanged sibling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notice-head-transition-493s-'));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const ledgerPath = join(dir, 'coordination.jsonl');
  const runsRoot = join(dir, 'runs');
  const paths = claimNoticePaths(runsRoot);
  let now = Date.parse('2026-11-16T00:00:00.000Z');
  const options = () => ({ path: ledgerPath, now: now += 5_000 });
  const sends: { threadKey: string; text: string; dedupeKey: string }[] = [];
  const send: ClaimNoticeSendDeps['send'] = (threadKey, text, dedupeKey) => {
    sends.push({ threadKey, text, dedupeKey });
    return { ok: true, receipt: `fake-${sends.length}` };
  };
  const pass = () => {
    now += 5_000;
    return runClaimNoticePass({ readBoard: () => readFleetBoard({ path: ledgerPath, now }),
      ...claimNoticeFileDeps(runsRoot), send, now: () => now });
  };
  const board = () => readFleetBoard({ path: ledgerPath, now });
  must(postFleetMessage({ from: 'setup', to: 'all', body: 'fake seed', ttlMs: 1 }, options()));
  expect(await pass()).toMatchObject({ status: 'completed', baselined: true, sent: 0 });
  const claim = must(claimFleetWork({ repo: 'fake/project', task: 'corrected work', agent: 'agent-a' }, options()));
  const sibling = must(claimFleetWork({ repo: 'fake/other', task: 'unchanged work', agent: 'agent-b' }, options()));
  expect(appendClaimThreadBinding(paths.bindings, { claimId: claim.claim.id, repo: 'fake/project',
    threadKey: THREAD, pr: 7, head: HEAD_A }, now)).toMatchObject({ ok: true });
  expect(appendClaimThreadBinding(paths.bindings, { claimId: sibling.claim.id, repo: 'fake/other',
    threadKey: SIBLING_THREAD, pr: 9, head: SIBLING_HEAD }, now)).toMatchObject({ ok: true });
  expect(await pass()).toMatchObject({ status: 'completed', planned: 2, sent: 2 });
  const first = returnFleetClaim({ id: claim.claim.id, agent: 'agent-a', lease: claim.lease,
    pr: 7, head: HEAD_A }, options());
  const other = returnFleetClaim({ id: sibling.claim.id, agent: 'agent-b', lease: sibling.lease,
    pr: 9, head: SIBLING_HEAD }, options());
  expect(first).toMatchObject({ ok: true, outcome: 'returned' });
  expect(other).toMatchObject({ ok: true, outcome: 'returned' });
  const keyA = JSON.stringify(['VERIFIED', claim.claim.id, HEAD_A]);
  const keyB = JSON.stringify(['VERIFIED', claim.claim.id, HEAD_B]);
  const siblingKey = JSON.stringify(['VERIFIED', sibling.claim.id, SIBLING_HEAD]);
  expect(await pass()).toMatchObject({ status: 'completed', planned: 2, sent: 2 });
  expect(sends.find(s => s.dedupeKey === keyA)).toMatchObject({ threadKey: THREAD });
  expect(sends.find(s => s.dedupeKey === keyA)?.text).toContain(`fake/project#7@${HEAD_A.slice(0, 7)}`);
  expect(sends.find(s => s.dedupeKey === siblingKey)).toMatchObject({ threadKey: SIBLING_THREAD });
  expect(await pass()).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
  expect(sends).toHaveLength(4);

  // The same lease returns a corrected receipt for the same claim and PR.
  const corrected = returnFleetClaim({ id: claim.claim.id, agent: 'agent-a', lease: claim.lease,
    pr: 7, head: HEAD_B }, options());
  expect(corrected).toMatchObject({ ok: true, outcome: 'returned',
    message: { body: expect.stringContaining(`pr #7 head ${HEAD_B}`) } });
  expect(projectCoordinationReturns(board(), now).returns).toEqual(expect.arrayContaining([
    expect.objectContaining({ claimId: claim.claim.id, repo: 'fake/project', pr: 7, head: HEAD_B }),
    expect.objectContaining({ claimId: sibling.claim.id, repo: 'fake/other', pr: 9, head: SIBLING_HEAD }),
  ]));
  expect(await pass()).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0 });
  expect(sends).toHaveLength(5);
  expect(sends.at(-1)).toMatchObject({ threadKey: THREAD, dedupeKey: keyB });
  expect(sends.at(-1)?.text).toContain(`VERIFIED: agent-a fake/project#7@${HEAD_B.slice(0, 7)}`);
  expect(sends.at(-1)?.text).not.toContain(HEAD_A.slice(0, 7));
  const keys = readFileSync(paths.sent, 'utf8').trim().split('\n')
    .map(line => (JSON.parse(line) as { key: string }).key);
  expect(keys).toEqual(expect.arrayContaining([keyA, keyB, siblingKey]));
  expect(sends.filter(s => s.dedupeKey === siblingKey)).toHaveLength(1);
  expect(await pass()).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
  expect(sends).toHaveLength(5);
});
