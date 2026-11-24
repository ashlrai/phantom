import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimNoticeFileDeps, claimNoticePaths, readClaimNoticePrev, runClaimNoticePass,
  type ClaimNoticeSendDeps } from '../src/core/fleet/claim-notice-send.js';
import { claimFleetWork, postFleetMessage, readFleetBoard, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const thread = 'T000FAKE/C000FAKE/1700000000.000001';
const head = 'abcdef1234567';
function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'claim-prev-outage-'));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const root = join(dir, 'runs');
  const paths = claimNoticePaths(root);
  const ledger = join(dir, 'coordination.jsonl');
  let now = Date.parse('2026-11-16T00:00:00Z');
  const tick = () => now += 5000;
  const sends: { threadKey: string; dedupeKey: string }[] = [];
  const send: ClaimNoticeSendDeps['send'] = (threadKey, _text, dedupeKey) => {
    sends.push({ threadKey, dedupeKey });
    return { ok: true, receipt: 'fake-receipt' };
  };
  const pass = () => runClaimNoticePass({ ...claimNoticeFileDeps(root),
    readBoard: () => readFleetBoard({ path: ledger, now }), send, now: tick });
  const baseline = async () => {
    must(postFleetMessage({ from: 'setup', to: 'all', body: 'fake seed', ttlMs: 1 }, { path: ledger, now: tick() }));
    expect(await pass()).toMatchObject({ status: 'completed', baselined: true, planned: 0 });
  };
  const claim = () => {
    const made = must(claimFleetWork({ repo: 'fake/outage', task: 'fake task', agent: 'agent-a' }, { path: ledger, now: tick() }));
    const binding = appendClaimThreadBinding(paths.bindings,
      { claimId: made.claim.id, repo: 'fake/outage', threadKey: thread, head }, now);
    if (!binding.ok) throw new Error(binding.reason);
    return JSON.stringify(['ASSIGNED', made.claim.repo, made.claim.id, made.claim.agent, made.claim.claimedAt, head]);
  };
  const sent = () => existsSync(paths.sent) ? readFileSync(paths.sent, 'utf8') : '';
  return { paths, pass, baseline, claim, sends, sent };
}

describe('previous snapshot outage recovery', () => {
  for (const obstruction of ['directory', 'malformed', 'oversized'] as const) {
    it(`preserves a pending assignment through ${obstruction} and resumes once`, async () => {
      const f = fixture();
      await f.baseline();
      const original = readFileSync(f.paths.prev);
      const key = f.claim();
      const sentBefore = f.sent();
      if (obstruction === 'directory') {
        rmSync(f.paths.prev);
        mkdirSync(f.paths.prev);
        writeFileSync(join(f.paths.prev, 'marker'), 'untouched');
      } else {
        writeFileSync(f.paths.prev, obstruction === 'malformed' ? '{' : Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
      }
      const obstructed = obstruction === 'directory' ? null : readFileSync(f.paths.prev);
      expect(readClaimNoticePrev(f.paths.prev)).toBeNull();
      expect(await f.pass()).toMatchObject({ status: 'prev-unavailable', reason: 'prev-snapshot-unreadable', planned: 0, sent: 0 });
      expect(f.sends).toEqual([]);
      expect(f.sent()).toBe(sentBefore);
      if (obstructed) expect(readFileSync(f.paths.prev).equals(obstructed)).toBe(true);
      else expect(readFileSync(join(f.paths.prev, 'marker'), 'utf8')).toBe('untouched');
      rmSync(f.paths.prev, { recursive: true });
      writeFileSync(f.paths.prev, original, { mode: 0o600 });
      expect(await f.pass()).toMatchObject({ status: 'completed', planned: 1, sent: 1 });
      expect(f.sends).toEqual([{ threadKey: thread, dedupeKey: key }]);
      expect(JSON.parse(f.sent().trim()).key).toBe(key);
      expect(await f.pass()).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
      expect(f.sends).toHaveLength(1);
    });
  }
  it('baselines an absent snapshot and accepts a healthy empty snapshot', async () => {
    const f = fixture();
    expect(readClaimNoticePrev(f.paths.prev)).toBeNull();
    await f.baseline();
    expect(readClaimNoticePrev(f.paths.prev)).toMatchObject({ state: 'known', claims: [], messages: [] });
    expect(await f.pass()).toMatchObject({ status: 'completed', baselined: false, planned: 0 });
    expect(f.sends).toEqual([]);
  });
});
