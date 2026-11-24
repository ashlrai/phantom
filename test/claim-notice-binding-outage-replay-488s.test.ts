/** RQ-PHX-BINDINGOUTAGEREPLAY488S — a pending claim transition must survive a
 * temporary outage of the durable source-thread bindings. Real file-backed
 * deps throughout (real coordination ledger, real binding writer, rebuilt
 * `claimNoticeFileDeps` per pass); only delivery (a synthetic receipt, NOT a
 * Slack delivery) and the clock are fake. Missing-file semantics: an ABSENT
 * or empty bindings file is a known-empty set (nothing was ever bound), while
 * an existing-but-untrusted one (over budget, or not a readable regular file)
 * is unavailable and halts the pass without consuming the transition. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimNoticeFileDeps, claimNoticePaths, readClaimThreadBindings, readClaimThreadBindingsState,
  runClaimNoticePass, type ClaimNoticeSendDeps,
} from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import {
  claimFleetWork, postFleetMessage, readFleetBoard,
  type FleetCoordinationOptions, type FleetCoordinationResult,
} from '../src/core/fleet/coordination.js';

const T0 = Date.parse('2026-11-16T00:00:00.000Z');
const STEP_MS = 5_000;
const THREAD = 'T000FAKE/C000FAKE/1700000000.000001';
const REPO = 'fake/outage';
const HEAD = 'abcdef1234567';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination write failed: ${result.error}`);
  return result.value;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'claim-binding-outage-488s-'));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const ledgerPath = join(dir, 'coordination.jsonl');
  const paths = claimNoticePaths(join(dir, 'runs'));
  let now = T0;
  const sends: { threadKey: string; text: string; dedupeKey: string }[] = [];
  const send: ClaimNoticeSendDeps['send'] = (threadKey, text, dedupeKey) => {
    sends.push({ threadKey, text, dedupeKey });
    return { ok: true, receipt: `fake-receipt-${sends.length}` };
  };
  const tick = () => { now += STEP_MS; return now; };
  const options = (): FleetCoordinationOptions => ({ path: ledgerPath, now: tick() });
  // Everything is re-read from disk per pass: that is the restart.
  const pass = () => runClaimNoticePass({
    readBoard: () => readFleetBoard({ path: ledgerPath, now }),
    ...claimNoticeFileDeps(join(dir, 'runs')), send, now: () => tick(),
  });
  // Known-empty baseline, then a real claim whose binding is real too.
  const baseline = async () => {
    must(postFleetMessage({ from: 'setup', to: 'all', body: 'fake seed marker', ttlMs: 1 }, options()));
    expect(await pass()).toMatchObject({ status: 'completed', baselined: true, planned: 0 });
  };
  const claim = (bind: boolean) => {
    const made = must(claimFleetWork({ repo: REPO, task: 'fake outage task', agent: 'agent-a' }, options()));
    if (bind) {
      const bound = appendClaimThreadBinding(
        paths.bindings, { claimId: made.claim.id, repo: REPO, threadKey: THREAD, pr: 7, head: HEAD }, now);
      if (!bound.ok) throw new Error(`binding write failed: ${bound.reason}`);
    }
    return made.claim;
  };
  const sentRows = () => (existsSync(paths.sent) ? readFileSync(paths.sent, 'utf8') : '')
    .split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as { key: string });
  return { dir, paths, sends, pass, baseline, claim, sentRows };
}

describe('claim notice binding outage replay (RQ-PHX-BINDINGOUTAGEREPLAY488S)', () => {
  it('retains an assignment through an over-budget bindings outage and delivers it once after repair', async () => {
    const f = fixture();
    await f.baseline();
    const claim = f.claim(true);
    const key = JSON.stringify(['ASSIGNED', claim.repo, claim.id, claim.agent, claim.claimedAt, HEAD]);
    const original = readFileSync(f.paths.bindings);
    const prevBefore = readFileSync(f.paths.prev);

    // Outage: the file is over the byte budget, so it cannot be trusted.
    writeFileSync(f.paths.bindings, Buffer.concat([original, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20)]),
      { mode: 0o600 });
    expect(readClaimThreadBindingsState(f.paths.bindings)).toBeNull();
    const outage = await f.pass();
    expect(outage).toMatchObject({ status: 'bindings-unavailable', planned: 0, sent: 0, failed: 0 });
    expect(f.sends).toHaveLength(0);
    expect(readFileSync(f.paths.prev)).toEqual(prevBefore);
    expect(f.sentRows()).toEqual([]);

    // Repair with the original bytes; rebuilt deps replan the same transition.
    writeFileSync(f.paths.bindings, original, { mode: 0o600 });
    const repaired = await f.pass();
    expect(repaired).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0 });
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({ threadKey: THREAD, dedupeKey: key });
    expect(f.sends[0]!.text).toContain('ASSIGNED');
    expect(f.sentRows().map(row => row.key)).toEqual([key]);

    // Restarted third pass stays quiet.
    expect(await f.pass()).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
    expect(f.sends).toHaveLength(1);
  });

  it('treats a present-but-unreadable bindings path (a directory) as unavailable, not empty', async () => {
    const f = fixture();
    await f.baseline();
    f.claim(false);
    mkdirSync(f.paths.bindings, { recursive: true });
    expect(readClaimThreadBindingsState(f.paths.bindings)).toBeNull();
    // Compatibility reader keeps its historical "binds nothing" result.
    expect(readClaimThreadBindings(f.paths.bindings)).toEqual([]);
    const prevBefore = readFileSync(f.paths.prev);
    expect(await f.pass()).toMatchObject({ status: 'bindings-unavailable', sent: 0 });
    expect(readFileSync(f.paths.prev)).toEqual(prevBefore);
    expect(f.sends).toHaveLength(0);
  });

  it('a missing or empty bindings file is known-empty: no invented destination, unbound work is not stranded', async () => {
    const f = fixture();
    await f.baseline();
    f.claim(false);
    expect(existsSync(f.paths.bindings)).toBe(false);
    expect(readClaimThreadBindingsState(f.paths.bindings)).toEqual([]);
    const missing = await f.pass();
    expect(missing).toMatchObject({ status: 'completed', planned: 0, sent: 0, failed: 0 });
    expect(f.sends).toHaveLength(0);
    // The snapshot advanced: ordinary unbound work does not hold the pass hostage.
    expect(JSON.parse(readFileSync(f.paths.prev, 'utf8')).claims).toHaveLength(1);

    writeFileSync(f.paths.bindings, '', { mode: 0o600 });
    expect(readClaimThreadBindingsState(f.paths.bindings)).toEqual([]);
    expect(await f.pass()).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
    expect(f.sends).toHaveLength(0);
  });
});
