/** RQ-PHX-REPOIDENTITYREPLAY488S — a claim id that is later acquired by a
 * second repository must not change the identity of an assignment already
 * delivered under the legacy [state, id, head] key. Synthetic boards (the real
 * coordination writer cannot mint identical ids across repos), the real
 * runClaimNoticePass and a real file-backed sent ledger in a private temp
 * root; deps are rebuilt every pass. Receipts are synthetic, never Slack. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimNoticeFileDeps, claimNoticePaths, readClaimNoticeSent, runClaimNoticePass,
  writeClaimNoticePrev,
} from '../src/core/fleet/claim-notice-send.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';

const T0 = Date.parse('2026-11-16T00:00:00.000Z');
const HOUR = 3_600_000;
const [REPO_A, REPO_B, REPO_C] = ['fake/a', 'fake/b', 'fake/c'];
const THREAD = { A: 'T0FAKE/C0FAKE/1.000001', B: 'T0FAKE/C0FAKE/1.000002', C: 'T0FAKE/C0FAKE/1.000003' };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const claim = (id: string, repo: string): FleetClaim =>
  ({ id, repo, task: 'task', agent: 'agent-x', claimedAt: T0, expiresAt: T0 + 24 * HOUR });
const board = (claims: FleetClaim[]): FleetBoard =>
  ({ schema: 'fleet.coordination.v1', state: 'known', claims, messages: [], proposals: [], expiredClaims: 0 });

function scenario() {
  const root = join(mkdtempSync(join(tmpdir(), 'claim-notice-late-repo-488s-')), 'runs');
  dirs.push(join(root, '..'));
  chmodSync(join(root, '..'), 0o700);
  const paths = claimNoticePaths(root);
  const sends: { threadKey: string; dedupeKey: string }[] = [];
  let now = T0;
  let failThread: string | null = null;
  const bindings = [['A', REPO_A], ['B', REPO_B], ['C', REPO_C]] as const;
  const pass = async (claims: FleetClaim[]) => {
    now += 1000;
    return runClaimNoticePass({
      ...claimNoticeFileDeps(root), // rebuilt per pass: only files carry state
      readBoard: () => board(claims),
      readBindings: () => bindings.map(([k, repo]) =>
        ({ claimId: repo === REPO_C ? 'c-1' : 'shared-1', repo, threadKey: THREAD[k], head: 'abcdef1234567' })),
      send: (threadKey, _text, dedupeKey) => {
        if (threadKey === failThread) return { ok: false, reason: 'injected-failure' };
        sends.push({ threadKey, dedupeKey });
        return { ok: true, receipt: `synthetic-receipt-${sends.length}` };
      },
      now: () => now,
    });
  };
  return { root, paths, sends, pass, failOn: (t: string | null) => { failThread = t; } };
}

async function lateRepoRun() {
  const s = scenario();
  // Known empty baseline, so the first pass plans (not merely baselines).
  writeClaimNoticePrev(s.paths.prev, { state: 'known', claims: [], messages: [], asOf: T0 });
  chmodSync(s.paths.prev, 0o600);
  s.failOn(THREAD.C);
  const p1 = await s.pass([claim('shared-1', REPO_A), claim('c-1', REPO_C)]);
  const afterP1 = s.sends.length;
  const p2 = await s.pass([claim('shared-1', REPO_A), claim('shared-1', REPO_B), claim('c-1', REPO_C)]);
  s.failOn(null);
  const p3 = await s.pass([claim('shared-1', REPO_A), claim('shared-1', REPO_B), claim('c-1', REPO_C)]);
  const p4 = await s.pass([claim('shared-1', REPO_A), claim('shared-1', REPO_B), claim('c-1', REPO_C)]);
  return { s, p1, p2, p3, p4, afterP1 };
}

describe('late repository acquiring an already-delivered claim id (488s)', () => {
  it('delivers repo B exactly once to its own thread and then stays quiet', async () => {
    const { s, p1, p4, afterP1 } = await lateRepoRun();
    expect(p1.failed).toBe(1);
    expect(s.sends.slice(0, afterP1).map(x => x.threadKey)).toEqual([THREAD.A]);
    expect(s.sends.filter(x => x.threadKey === THREAD.B)).toHaveLength(1);
    expect(s.sends.filter(x => x.threadKey === THREAD.C)).toHaveLength(1);
    expect(p4.planned).toBe(0);
    expect(p4.sent).toBe(0);
    expect(readClaimNoticeSent(s.paths.sent)?.size).toBe(s.sends.length);
  });

  it('fences A under its legacy ledgered key while A is the only holder', async () => {
    const s = scenario();
    writeClaimNoticePrev(s.paths.prev, { state: 'known', claims: [], messages: [], asOf: T0 });
    chmodSync(s.paths.prev, 0o600);
    await s.pass([claim('shared-1', REPO_A)]);
    expect(s.sends).toHaveLength(1);
    expect(JSON.parse(s.sends[0]!.dedupeKey)).toEqual(['ASSIGNED', 'shared-1', 'abcdef1234567']);
    writeFileSync(s.paths.prev, JSON.stringify({ v: 1, state: 'known', claims: [], messages: [], asOf: T0 }), { mode: 0o600 });
    const replay = await s.pass([claim('shared-1', REPO_A)]);
    expect(replay.sent).toBe(0);
    expect(s.sends).toHaveLength(1);
  });

  // KNOWN GAP: planner picks repo-qualified keys once B appears, so the legacy
  // key that fenced A no longer matches and A is delivered twice. Planner-only
  // fixes cannot repair this (it has no ledger access and a notice carries one
  // key); see BRIDGE_NOTES.md. `it.fails` flips red when the owner fixes it.
  it.fails('does not resend A after B joins (needs sender-side legacy-key fence)', async () => {
    const { s } = await lateRepoRun();
    expect(s.sends.filter(x => x.threadKey === THREAD.A)).toHaveLength(1);
  });
});
