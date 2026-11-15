/** Process execution over real MCP never supplies a task owner or claim. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { readFleetRecheck, type FleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import { listLiveWorkers } from '../src/core/fleet/runs-live-workers.js';
import type { WorkBoardItem } from '../src/core/comms/work-board.js';

const NOW = new Date('2026-10-10T13:13:00.000Z');
const ISO = NOW.toISOString();
const done: WorkBoardItem = {
  id: 'synthetic-done-x', channel: 'slack', channelRef: 'TFAKE/CFAKE/1',
  receivedAt: '2026-10-10T12:00:00.000Z', asOf: '2026-10-10T12:05:00.000Z',
  state: 'VERIFIED', source: 'bus-reply:synthetic-reply-336', missing: [],
  owner: 'synthetic-previous-owner', claimReceipt: 'bus-claim:synthetic-done-x:1:1',
};
const clients: Client[] = [];
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function dependencies(home: string, items: WorkBoardItem[]): Required<FleetRecheckDeps> {
  return {
    now: () => NOW, homeDir: () => home,
    readRuntimeIdentity: () => ({
      host: 'synthetic-host', platform: 'fakeos', asOf: ISO, tailnetName: 'synthetic-node',
      installedVersion: '0.0.0-fake', sourceVersion: '0.0.0-fake', versionDrift: false,
      fleetState: { path: join(home, 'private-state'), mtime: ISO, ageSeconds: 0, stale: false }, reasons: [],
    }),
    readFleetBoard: () => ({
      schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0,
    }),
    readChannelHealth: () => ({
      schemaVersion: 1, asOf: ISO, channels: (['slack', 'imessage'] as const).map(channel => ({
        channel, configured: true, processAlive: true, runtimeHost: 'synthetic-host',
        lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
        proof: { requestCoverage: 'idle', futureDatedCount: 0 }, state: 'LIVE', missing: [], asOf: ISO,
      })),
    }),
    listWorkBoard: () => ({ items, inbox: 'ok', truncated: false }),
    listCoordination: () => ({ source: 'available', claims: [] }),
    listLiveWorkers: () => listLiveWorkers({ now: () => NOW.getTime(), runPs: async () => '' }),
  };
}

describe('fleet_recheck MCP process evidence and task ownership', () => {
  it.each(['BLOCKED', 'UNKNOWN'] as const)('preserves %s with and without a live process', async state => {
    const home = mkdtempSync(join(tmpdir(), 'recheck-owner-336-'));
    homes.push(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('ASHLR_HOME', home);
    vi.stubEnv('ASHLR_RUNS_DIR', join(home, 'runs'));
    const items = state === 'BLOCKED' ? [done] : [done, {
      ...done, id: 'synthetic-unbound-current-336', state: 'RUNNING' as const, asOf: ISO,
      owner: 'synthetic-current-owner', claimReceipt: 'bus-claim:synthetic-unbound-current-336:2:2',
    }];
    const deps = dependencies(home, items);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createFleetServer({
      status: async () => ({}), loop: async () => ({}), recheck: () => readFleetRecheck(deps),
    });
    const client = new Client({ name: 'synthetic-owner-336', version: '1.0.0' });
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const read = async (): Promise<FleetRecheck> => {
      const result = await client.callTool({ name: 'fleet_recheck', arguments: {} });
      expect(result.isError).toBeUndefined();
      const wire = JSON.stringify(result);
      expect(wire).not.toContain(home);
      expect(wire).not.toMatch(/"pid"|424242/);
      expect(readdirSync(home)).toEqual([]); // No recheck log, queue or enqueue artifacts.
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as FleetRecheck;
    };
    const baseline = await read();
    expect(baseline.sections.runtime.state).toBe('VERIFIED');
    expect(baseline.sections.bridge.state).toBe('VERIFIED');
    expect(baseline.sections.task.state).toBe(state);
    expect(baseline.overall.state).toBe(state);
    expect(baseline.sections.task.liveWorker).toBeNull();
    expect(baseline.sections.task.lastVerified).toEqual({
      id: done.id, owner: done.owner, claimReceipt: done.claimReceipt, asOf: done.asOf, source: done.source,
    });
    if (state === 'BLOCKED') expect(baseline.sections.task.task).toBeNull();
    else expect(baseline.sections.task.task).toMatchObject({ id: 'synthetic-unbound-current-336', ledgerClaim: null });
    deps.listLiveWorkers = () => listLiveWorkers({ now: () => NOW.getTime(), runPs: async () =>
      `424242 00:37 /bin/sh ${home}/bin/launch.sh synthetic-live-336 phantom codex-personal work` });
    const live = await read();
    const expectedWorker = {
      job: 'synthetic-live-336', repo: 'phantom', lane: 'codex-personal', tier: 'work',
      ageSeconds: 37, asOf: ISO, source: 'process-table',
    };
    expect(live.sections.task.liveWorker).toEqual(expectedWorker); // Exact shape excludes owner/claim/pid.
    expect(live).toEqual({ ...baseline, sections: {
      ...baseline.sections, task: { ...baseline.sections.task, liveWorker: expectedWorker },
    } });
    deps.listLiveWorkers = () => listLiveWorkers({ now: () => NOW.getTime(), runPs: async () => {
      throw new Error(`${home}/private-process-source-unavailable`);
    } });
    expect(await read()).toEqual(baseline);
  });
});
