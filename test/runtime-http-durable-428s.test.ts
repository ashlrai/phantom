import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readClaimExecution } from '../src/core/fleet/claim-execution-evidence.js';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';
import type { LiveWorker } from '../src/core/fleet/runs-live-workers.js';
import type { FleetRuntimeDeps } from '../src/core/fleet/runtime-snapshot.js';
import { createFleetRuntimeSnapshotApi, VERSE_FLEET_RUNTIME_SNAPSHOT_PATH } from '../src/core/verse/fleet-runtime-snapshot-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

it('reads durable claim returns through the desktop HTTP boundary without retaining running evidence', async () => {
  const home = mkdtempSync(join(tmpdir(), 'runtime-http-428s-'));
  try {
    const path = join(home, 'ledger.jsonl');
    writeFileSync(path, '', { mode: 0o600 });
    let now = Date.parse('2026-11-13T14:00:00.000Z');
    const options = () => ({ path, now });
    const board = () => readFleetBoard(options());
    let workers: LiveWorker[] = [];
    const deps: FleetRuntimeDeps = {
      now: () => now, home: () => home, stateRoot: () => home, host: () => 'fake-host',
      platform: () => 'fakeos', arch: () => 'fakearch', pid: () => 123, uptime: () => 10,
      installedVersion: () => '1.2.3', sourceVersion: () => '1.2.3', tailnet: () => 'fake-net', board,
      execution: () => readClaimExecution({ board, now: () => now, workers: async () => ({
        v: 1, generatedAt: new Date(now).toISOString(), sourceState: 'healthy', workers, leaders: [], orchestratorAgents: 0,
      }) }),
    };
    const api = createFleetRuntimeSnapshotApi({ runtimeDeps: deps, now: () => new Date(now) });
    const task = 'RQ-FAKE-HTTP428S private task text';
    const claim = claimFleetWork({ repo: 'fake-owner/fake-repo', task, agent: 'fake-agent' }, options());
    if (!claim.ok) throw new Error('claim failed');
    const read = async () => {
      const response = { status: 0, body: '', ends: 0 };
      const res = {
        writeHead(status: number) { response.status = status; return this; },
        end(body: string) { response.body = body; response.ends++; },
      } as unknown as ServerResponse;
      expect(await api({} as VerseApiContext, {} as IncomingMessage, res, VERSE_FLEET_RUNTIME_SNAPSHOT_PATH, 'GET')).toBe(true);
      expect(response).toMatchObject({ status: 200, ends: 1 });
      expect([task, claim.value.lease, home, 'leaseHash'].every(value => !response.body.includes(value))).toBe(true);
      const result = JSON.parse(response.body);
      expect(result).toMatchObject({ authority: 'none', generatedAt: new Date(now).toISOString(), snapshot: { asOf: new Date(now).toISOString() } });
      return result.snapshot;
    };
    expect(await read()).toMatchObject({ coordination: { activeClaims: 1 }, execution: { state: 'known', running: 0, claimedNoWorker: 1 } });
    workers = [{ pid: 4242, job: 'RQ-FAKE-HTTP428S', repo: 'fake-repo', lane: 'fake', tier: 'work', ageSeconds: 1 }];
    now += 1000;
    expect(await read()).toMatchObject({ coordination: { activeClaims: 1 }, execution: { state: 'known', running: 1, claimedNoWorker: 0 } });
    renameSync(path, `${path}.away`);
    now += 1000;
    expect(await read()).toMatchObject({ coordination: { state: 'UNKNOWN', activeClaims: 'UNKNOWN' }, execution: { state: 'UNKNOWN', running: 0 } });
    renameSync(`${path}.away`, path);
    now += 1000;
    expect(await read()).toMatchObject({ coordination: { activeClaims: 1 }, execution: { state: 'known', running: 1 } });
    const input = { id: claim.value.claim.id, agent: 'fake-agent', lease: claim.value.lease, tests: 'fake tests' };
    expect(returnFleetClaim(input, options()).outcome).toBe('returned');
    const returns = projectCoordinationReturns(board(), now).returns;
    expect(returns).toHaveLength(1);
    now += 5000;
    expect(await read()).toMatchObject({ coordination: { activeClaims: 0, newestReturnAgeSeconds: 5 }, execution: { state: 'known', running: 0, claimedNoWorker: 0 } });
    expect(returnFleetClaim(input, options()).outcome).toBe('already-returned');
    expect(projectCoordinationReturns(board(), now).returns).toEqual(returns);
    now += 2000;
    expect(await read()).toMatchObject({ coordination: { activeClaims: 0, newestReturnAgeSeconds: 7 }, execution: { state: 'known', running: 0, claimedNoWorker: 0 } });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
