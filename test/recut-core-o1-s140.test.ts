/**
 * RQ-PHX-RECUTCOREO1S140 — recut of PR #1563 (RQ-MERGEAUTOPILOTQ7).
 *
 * Exercises the recovered merge autopilot through its real entry points:
 * the `phm land` CLI verb (cmdLand — argv parsing, the --apply env gate and
 * the empty-store sweep) and runMergeAutopilot end-to-end: a live-behind PR
 * is classified from a route-table GitHub transport, and under --apply the
 * ONLY effect dispatched is the pinned PUT update-branch, with the act
 * ledgered on the real merge-state record inside the isolated HOME store.
 */
import { describe, expect, it, vi } from 'vitest';

import { cmdLand } from '../src/cli/land.js';
import { runMergeAutopilot, type MergeAutopilotDeps } from '../src/core/fleet/merge-autopilot.js';
import {
  newFleetMergeState,
  proposalStateKey,
  readFleetMergeState,
  writeFleetMergeState,
} from '../src/core/fleet/fleet-merge-state.js';
import {
  FLEET_APP_BOT_LOGIN,
  type GithubCall,
  type GithubReply,
  type HostMergeDeps,
} from '../src/core/fleet/host-merge.js';

const NOW = Date.parse('2026-02-10T12:00:00Z');
const NOW_ISO = new Date(NOW).toISOString();
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

const REPO = 'acme/recut-widgets';
const KEY = proposalStateKey('autopilot-recut-s140')!;

/** One open, ledgered fleet PR on the real merge-state store (isolated HOME). */
function mkRecord(): void {
  const record = newFleetMergeState({
    key: KEY,
    kind: 'change',
    proposalId: KEY,
    revertsLandingId: null,
    repo: REPO,
    repoPath: `/tmp/${REPO}`,
    enforcement: 'server',
    nowIso: NOW_ISO,
  });
  record.pr = {
    number: 12,
    nodeId: 'PR_12',
    repositoryId: 'R_1',
    branch: 'ashlr/fleet/test-12',
    baseBranch: 'main',
    baseSha: BASE,
    headSha: HEAD,
    treeSha: 'e'.repeat(40),
    ownerLane: false,
    ownerLaneReason: null,
    openedAt: NOW_ISO,
    ledgered: true,
    state: 'open',
    closedBy: null,
    nextCheckAt: null,
    checkBackoffMs: 0,
    checks: null,
    wouldMergeHeadSha: null,
    verifyCheck: null,
  };
  expect(writeFleetMergeState(record)).toBe(true);
}

function prBody(mergeableState = 'clean'): Record<string, unknown> {
  return {
    number: 12,
    node_id: 'PR_12',
    state: 'open',
    merged: false,
    mergeable: true,
    mergeable_state: mergeableState,
    head: { sha: HEAD, ref: 'ashlr/fleet/test-12', repo: { full_name: REPO } },
    base: { ref: 'main' },
    user: { login: FLEET_APP_BOT_LOGIN },
    labels: [],
  };
}

/** A behind-PR route table: GitHub agrees the PR is open, behind and check-green. */
function behindRoutes(over: Record<string, { status: number; body?: unknown }> = {}) {
  return {
    'GET /pulls/12': { status: 200, body: prBody('behind') },
    'GET /git/ref/heads/main': { status: 200, body: { object: { sha: BASE, type: 'commit' } } },
    ...over,
  };
}

function fakeHost(routes: Record<string, { status: number; body?: unknown }>): { host: HostMergeDeps; calls: GithubCall[] } {
  const calls: GithubCall[] = [];
  const host: HostMergeDeps = {
    transport: async (call) => {
      calls.push(call);
      const hit = routes[`${call.method} ${call.path.replace(`/repos/${REPO}`, '')}`];
      return { status: hit?.status ?? 404, body: hit?.body ?? { message: 'unrouted' } } satisfies GithubReply;
    },
    token: async () => ({ token: 'test-token', expiresAt: null }),
    nowMs: () => NOW,
    sleep: async () => {},
    killActive: () => false,
    killEpoch: () => 'x'.repeat(64),
    policy: () => null,
    appendLedger: (() => ({ ok: true as const })) as unknown as HostMergeDeps['appendLedger'],
    ledgerHead: () => null,
  };
  return { host, calls };
}

function deps(host: HostMergeDeps): MergeAutopilotDeps {
  return { host, listHolds: () => [], armed: () => true, nowMs: () => NOW };
}

describe('cmdLand — the real phm land verb', () => {
  it('--help prints usage and exits 0 without acting', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdLand(['--help']);
    expect(code).toBe(0);
    expect(log.mock.calls.flat().join(' ')).toContain('phm land auto');
    log.mockRestore();
  });

  it('an unknown verb exits 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdLand(['bogus'])).toBe(2);
    err.mockRestore();
  });

  it('a malformed --repo exits 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdLand(['auto', '--repo', 'not a repo'])).toBe(2);
    err.mockRestore();
  });

  it('dry-run on an empty merge-state store sweeps nothing and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdLand(['auto']);
    expect(code).toBe(0);
    expect(log.mock.calls.flat().join(' ')).toContain('No open fleet pull requests.');
    log.mockRestore();
  });

  it('--apply without PHANTOM_MERGE_AUTOPILOT=1 refuses before any read', async () => {
    const saved = process.env['PHANTOM_MERGE_AUTOPILOT'];
    delete process.env['PHANTOM_MERGE_AUTOPILOT'];
    try {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = await cmdLand(['auto', '--apply']);
      expect(code).toBe(1);
      expect(err.mock.calls.flat().join(' ')).toContain('PHANTOM_MERGE_AUTOPILOT=1');
      err.mockRestore();
    } finally {
      if (saved !== undefined) process.env['PHANTOM_MERGE_AUTOPILOT'] = saved;
    }
  });
});

describe('runMergeAutopilot — classify and act through the real pass', () => {
  it('dry-run classifies a behind PR and PLANS update-branch without dispatching it', async () => {
    mkRecord();
    const { host, calls } = fakeHost(behindRoutes());
    const result = await runMergeAutopilot({ repo: REPO, deps: deps(host) });
    expect(result.ok).toBe(true);
    expect(result.prs).toHaveLength(1);
    expect(result.prs[0]!.class).toBe('behind');
    expect(result.prs[0]!.action).toMatchObject({ kind: 'update-branch', status: 'planned' });
    // Dry-run: every GitHub call is a read.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('--apply issues only the pinned PUT update-branch and ledgers the act on the real record', async () => {
    mkRecord();
    const { host, calls } = fakeHost(behindRoutes({
      'PUT /pulls/12/update-branch': { status: 202, body: { message: 'Updating pull request branch.' } },
    }));
    const result = await runMergeAutopilot({ repo: REPO, apply: true, deps: deps(host) });
    expect(result.ok).toBe(true);
    expect(result.prs[0]!.action).toMatchObject({ kind: 'update-branch', status: 'applied' });
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.method).toBe('PUT');
    expect(writes[0]!.path).toBe(`/repos/${REPO}/pulls/12/update-branch`);
    expect(writes[0]!.body).toEqual({ expected_head_sha: HEAD });
    const memo = readFleetMergeState(KEY);
    expect(memo.state).toBe('ok');
    if (memo.state !== 'ok') return;
    expect(memo.record.autopilot?.actions).toHaveLength(1);
    expect(memo.record.autopilot?.actions[0]!.kind).toBe('update-branch');
  });
});
