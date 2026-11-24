/** Real producer → disk → recheck proof; no host fleet state or messages. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { cmdFleetClaimItem } from '../src/cli/fleet-claim-item.js';
import { parseBoardRef } from '../src/core/fleet/claim-board-ref.js';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import { readFleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import type { WorkBoardItem } from '../src/core/comms/work-board.js';

const NOW = Date.parse('2026-11-14T00:30:00.000Z');
const ITEM = 'fake-durable-item';
const OWNER = 'fake-owner';
const REPO = 'fake-org/fake-repo';
const TTL = 60_000;
const item: WorkBoardItem = {
  id: ITEM, channel: 'slack', channelRef: 'fake-channel', receivedAt: new Date(NOW - 1000).toISOString(),
  state: 'RUNNING', asOf: new Date(NOW).toISOString(), source: 'bus-work-claims', missing: [],
  owner: OWNER, claimReceipt: 'bus-claim:fake-durable-item:1:1700000000000',
};
const work = { items: [item], inbox: 'ok' as const, truncated: false };
const unavailable = () => { throw new Error('fake unavailable'); };

function recheckDeps(path: string, root: string, now: number): FleetRecheckDeps {
  return {
    now: () => new Date(now), homeDir: () => root,
    readRuntimeIdentity: () => null, readChannelHealth: unavailable,
    readFleetBoard: () => readFleetBoard({ path, now, reap: false }),
    listWorkBoard: () => work, listCoordination: () => ({ source: 'unavailable', claims: [] }),
    listLiveWorkers: unavailable, readTailnetPeers: unavailable, readPool: unavailable,
    readOrders: unavailable, readPeers: unavailable, readOwners: unavailable, readLaneTargets: unavailable,
  };
}

it('preserves the named owner and exact board binding across a real ledger reread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fake-claim-board-'));
  const path = join(root, 'ledger.jsonl');
  try {
    const out: string[] = [];
    const err: string[] = [];
    const args = [ITEM, '--agent', OWNER, '--repo', REPO, '--ttl-minutes', '1'];
    const deps = {
      now: () => NOW, listWorkBoard: () => work,
      claimFleetWork: (input: Parameters<typeof claimFleetWork>[0]) => claimFleetWork(input, { path, now: NOW }),
      out: (line: string) => out.push(line), err: (line: string) => err.push(line),
    };
    expect(await cmdFleetClaimItem(args, deps)).toBe(0);
    expect(out).toHaveLength(1);
    expect(err).toEqual([]);
    const board = readFleetBoard({ path, now: NOW, reap: false });
    expect(board.state).toBe('known');
    expect(board.claims).toHaveLength(1);
    const claim = board.claims[0]!;
    expect(claim).toMatchObject({ agent: OWNER, repo: REPO, claimedAt: NOW, expiresAt: NOW + TTL });
    expect(parseBoardRef(claim.task)).toEqual({ itemId: ITEM });
    const task = (await readFleetRecheck(recheckDeps(path, root, NOW))).sections.task;
    expect(task.state).toBe('VERIFIED');
    expect(task.task).toMatchObject({ id: ITEM, owner: OWNER, ledgerClaim: { id: claim.id, repo: REPO } });
    expect(task.task?.coordinationClaim ?? null).toBeNull();

    expect(await cmdFleetClaimItem(args, deps)).toBe(1);
    expect(readFleetBoard({ path, now: NOW, reap: false }).claims).toHaveLength(1);
    expect(out).toHaveLength(1);

    expect(claimFleetWork({ repo: REPO, task: 'fake unrelated work', agent: OWNER, ttlMs: TTL * 3 },
      { path, now: NOW }).ok).toBe(true);
    const later = NOW + TTL + 1;
    const expired = readFleetBoard({ path, now: later, reap: false });
    expect(expired.state).toBe('known');
    expect(expired.expiredClaims).toBe(1);
    expect(expired.claims).toHaveLength(1);
    expect(expired.claims[0]).toMatchObject({ agent: OWNER, task: 'fake unrelated work' });
    const staleTask = (await readFleetRecheck(recheckDeps(path, root, later))).sections.task;
    expect(staleTask.state).toBe('UNKNOWN');
    expect(staleTask.task?.ledgerClaim).toBeNull();
    expect(staleTask.task?.coordinationClaim ?? null).toBeNull();

    const absentPath = join(root, 'missing', 'ledger.jsonl');
    expect(readFleetBoard({ path: absentPath, now: NOW, reap: false }).state).toBe('unknown');
    const missing = (await readFleetRecheck(recheckDeps(absentPath, root, NOW))).sections.task;
    expect(missing.state).toBe('UNKNOWN');
    expect(missing.task?.ledgerClaim).toBeNull();
    expect(missing.missing).toContain('task: claims ledger unreadable, owner claim unverified');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
