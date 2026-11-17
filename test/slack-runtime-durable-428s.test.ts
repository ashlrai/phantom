import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { readClaimExecution } from '../src/core/fleet/claim-execution-evidence.js';
import { claimFleetWork, handoffFleetClaim, readFleetBoard, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { readRuntimeSnapshot } from '../src/core/fleet/runtime-snapshot.js';
import type { LiveWorker, LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import type { WorkBoardResult } from '../src/core/comms/work-board.js';

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination failed: ${result.error}`);
  return result.value;
}

it('composes the Slack status answer from the real durable ledger on every request', async () => {
  const home = mkdtempSync(join(tmpdir(), 'slack-runtime-428s-'));
  try {
    const root = join(home, 'state'), ledger = join(home, 'ledger.jsonl');
    mkdirSync(root);
    writeFileSync(join(root, 'state.json'), '{}');
    writeFileSync(ledger, '', { mode: 0o600 });
    let now = Date.parse('2026-11-15T19:00:00.000Z');
    utimesSync(join(root, 'state.json'), now / 1000, now / 1000);
    const options = () => ({ path: ledger, now });
    const fleetBoard = (input?: { now?: number }) => readFleetBoard({ path: ledger, now: input?.now ?? now });
    const task = 'RQ-FAKE-SLACK428S fake private task prose';
    const job = 'RQ-FAKE-SLACK428S';
    const workerPid = 7654321;
    const leases: string[] = [];
    let workers: LiveWorker[] = [];
    let processSnapshotAgeMs = 0;
    let processesFail = false;
    const processes = async (): Promise<LiveWorkersSnapshot> => {
      if (processesFail) throw new Error('fake process table failure');
      return {
        v: 1, generatedAt: new Date(now - processSnapshotAgeMs).toISOString(),
        sourceState: 'healthy', workers, leaders: [], orchestratorAgents: 0,
      };
    };
    const reply = ownerStatusReply({
      brief: async () => 'Morning leader brief\nShipped: none',
      board: (): WorkBoardResult => ({ items: [], inbox: 'ok', truncated: false }),
      snapshot: at => readRuntimeSnapshot({
        now: () => at.getTime(), home: () => home, stateRoot: () => root,
        host: () => 'fake-host', platform: () => 'fakeos', arch: () => 'fakearch',
        pid: () => 123, uptime: () => 10,
        installedVersion: () => '1.2.3', sourceVersion: () => '1.2.3',
        tailnet: () => 'fake-tailnet', board: fleetBoard,
        execution: () => readClaimExecution({ board: fleetBoard, now: () => at.getTime(), workers: processes }),
      }),
    });
    const composed: string[] = [];
    const compose = async (): Promise<string | undefined> => {
      const at = now;
      const text = await reply.compose('/fake-slack-428s-runs', new Date(at), 'status');
      composed.push(text);
      expect(text.startsWith('Phantom status, ')).toBe(true);
      expect(text.includes('Shipped: none')).toBe(true);
      expect(text.includes('Work items as of')).toBe(true);
      expect(text.length <= 1500).toBe(true);
      expect(text.includes(`as of ${new Date(at).toISOString()}`)).toBe(true);
      const claims = text.split('\n').find(line => line.startsWith('Claims:'));
      expect(text.split('\n').at(-1)).toBe(claims);
      return claims;
    };
    const noWorkerUnknownReturn = 'newest return UNKNOWN (no readable retained return at or before asOf)';
    expect(reply.ask('status')).toBe(true);

    // Empty durable ledger: an honest zero, no retained summary.
    expect(await compose()).toBe(`Claims: 0 live (0 running, 0 no worker), ${noWorkerUnknownReturn}`);

    const claim = must(claimFleetWork({ repo: 'fake-owner/fake-slack428s', task, agent: 'fake-owner-a' }, options()));
    leases.push(claim.lease);
    now += 2_000;
    expect(await compose()).toBe(`Claims: 1 live (0 running, 1 no worker), ${noWorkerUnknownReturn}`);

    workers = [{ pid: workerPid, job, repo: 'fake-slack428s', lane: 'fake-lane', tier: 'work', ageSeconds: 1 }];
    now += 2_000;
    expect(await compose()).toBe(`Claims: 1 live (1 running, 0 no worker), ${noWorkerUnknownReturn}`);

    // A retained process snapshot is not current execution: UNKNOWN, never RUNNING.
    processSnapshotAgeMs = 120_000;
    now += 2_000;
    const stale = await compose();
    expect(stale?.startsWith('Claims: 1 live,')).toBe(true);
    expect(stale?.includes('(running UNKNOWN: execution: process table unavailable)')).toBe(true);
    expect(stale?.includes('1 running')).toBe(false);

    // A failed process read is reported the same honest way.
    processSnapshotAgeMs = 0;
    processesFail = true;
    now += 2_000;
    const failed = await compose();
    expect(failed?.includes('(running UNKNOWN: execution: process table unavailable)')).toBe(true);
    expect(failed?.includes('1 running')).toBe(false);

    // A fresh healthy observation recovers on the very next request.
    processesFail = false;
    now += 2_000;
    expect(await compose()).toBe(`Claims: 1 live (1 running, 0 no worker), ${noWorkerUnknownReturn}`);

    const handoff = must(handoffFleetClaim({ id: claim.claim.id, agent: 'fake-owner-a', lease: claim.lease, to: 'fake-owner-b' }, options()));
    leases.push(handoff.lease);
    now += 2_000;
    expect(await compose()).toBe(`Claims: 1 live (1 running, 0 no worker), ${noWorkerUnknownReturn}`);
    expect(fleetBoard().claims.map(item => item.agent)).toEqual(['fake-owner-b']);

    expect(returnFleetClaim({ id: claim.claim.id, agent: 'fake-owner-a', lease: claim.lease, tests: 'fake tests' }, options()).outcome)
      .toBe('not-owner');
    now += 2_000;
    expect(await compose()).toBe(`Claims: 1 live (1 running, 0 no worker), ${noWorkerUnknownReturn}`);

    const input = { id: claim.claim.id, agent: 'fake-owner-b', lease: handoff.lease, tests: 'fake tests' };
    expect(returnFleetClaim(input, options()).outcome).toBe('returned');
    now += 3_000;
    expect(await compose()).toBe('Claims: 0 live (0 running, 0 no worker), newest return 3s ago');

    // Replay: a resolved return never resurrects the claim.
    expect(returnFleetClaim(input, options()).outcome).toBe('already-returned');
    expect(fleetBoard().claims).toEqual([]);
    now += 4_000;
    expect(await compose()).toBe('Claims: 0 live (0 running, 0 no worker), newest return 7s ago');
    expect(fleetBoard().claims).toEqual([]);

    // Task prose, lease values, local absolute paths and worker pids stay local.
    const hidden = [task, job, claim.claim.id, ...leases, home, root, ledger, '/fake-slack-428s-runs', String(workerPid)];
    expect(composed.every(text => hidden.every(value => !text.includes(value)))).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
