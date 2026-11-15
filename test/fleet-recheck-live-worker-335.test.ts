/** RQ-PHX-RECHECKLIVEWORKER335 — task.liveWorker is process-table evidence only.
 * Every reader is faked; nothing touches the real home or process table. */
import { describe, expect, it, vi } from 'vitest';
import { readFleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import { formatRecheckReply } from '../src/core/fleet/fleet-recheck-reply.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { LiveWorker, LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const NOW = new Date('2026-11-13T13:13:00.000Z');
const ISO = NOW.toISOString();
const runtime: RuntimeIdentity = {
  host: 'fake-host', platform: 'fakeos', asOf: ISO,
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  fleetState: { path: '~/x', mtime: ISO, ageSeconds: 60, stale: false },
  tailnetName: 'fake-tailnet-node', reasons: [],
};
const ledger: FleetBoard = {
  schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0,
};
const channel = (c: 'slack' | 'imessage'): ChannelHealth => ({
  channel: c, configured: true, processAlive: true, runtimeHost: 'fake-host',
  lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
  proof: { requestCoverage: 'idle', futureDatedCount: 0 }, state: 'LIVE', missing: [], asOf: ISO,
});
const channels: ChannelHealthReport = { schemaVersion: 1, asOf: ISO, channels: [channel('slack'), channel('imessage')] };
const done: WorkBoardItem = {
  id: 'fake-done-1', channel: 'slack', channelRef: 'T0FAKEWS/C0FAKECH/1',
  receivedAt: '2026-11-13T13:00:00.000Z', state: 'VERIFIED', asOf: '2026-11-13T13:05:00.000Z',
  source: 'bus-reply:fake-reply-1', missing: [], owner: 'agent-alpha', claimReceipt: 'bus-claim:fake-done-1:1:1',
};

const w = (job: string, repo: string, ageSeconds: number | null): LiveWorker =>
  ({ pid: 424242, job, repo, lane: 'claude', tier: 'work', ageSeconds });
const snap = (workers: LiveWorker[], sourceState: 'healthy' | 'unavailable' = 'healthy'): LiveWorkersSnapshot =>
  ({ v: 1, generatedAt: ISO, sourceState, workers, leaders: [], orchestratorAgents: 0 });

function deps(live?: FleetRecheckDeps['listLiveWorkers'], items: WorkBoardItem[] = [done]): FleetRecheckDeps {
  return {
    now: () => NOW, homeDir: () => '/home/fakeuser',
    readRuntimeIdentity: () => runtime, readFleetBoard: () => ledger, readChannelHealth: () => channels,
    listWorkBoard: (): WorkBoardResult => ({ items, inbox: 'ok', truncated: false }),
    listCoordination: () => ({ source: 'unavailable', claims: [] }),
    ...(live ? { listLiveWorkers: live } : { listLiveWorkers: () => { throw new Error('absent'); } }),
  };
}

describe('fleet recheck liveWorker evidence', () => {
  const workers = [w('b-old', 'phantom', 900), w('z-new', 'phantom', 30), w('other-1', 'elsewhere', 5)];

  it('picks the newest phantom worker without changing any state', async () => {
    const base = await readFleetRecheck(deps());
    const v = await readFleetRecheck(deps(() => snap(workers)));
    expect(v.sections.task.liveWorker).toEqual({
      job: 'z-new', repo: 'phantom', lane: 'claude', tier: 'work', ageSeconds: 30, asOf: ISO, source: 'process-table',
    });
    expect(JSON.stringify(v)).not.toContain('424242');
    expect(v.overall).toEqual(base.overall);
    const { liveWorker: _a, ...taskWith } = v.sections.task;
    const { liveWorker: _b, ...taskWithout } = base.sections.task;
    expect(JSON.stringify(taskWith)).toBe(JSON.stringify(taskWithout));
    expect(base.sections.task.liveWorker).toBeNull();
  });

  it('orders by age then job id, nulls last', async () => {
    const v = await readFleetRecheck(deps(() => snap([w('b', 'phantom', null), w('c', 'phantom', 7), w('a', 'phantom', 7)])));
    expect(v.sections.task.liveWorker?.job).toBe('a');
    const n = await readFleetRecheck(deps(() => snap([w('b', 'phantom', null), w('a', 'phantom', null)])));
    expect(n.sections.task.liveWorker).toMatchObject({ job: 'a', ageSeconds: null });
  });

  it('is null on throw, stall and unavailable, adding no missing entries', async () => {
    const base = await readFleetRecheck(deps());
    vi.useFakeTimers();
    try {
      const p = readFleetRecheck(deps(() => new Promise<LiveWorkersSnapshot>(() => {})));
      await vi.advanceTimersByTimeAsync(5_001);
      const stalled = await p;
      expect(stalled.sections.task.liveWorker).toBeNull();
      expect(stalled.overall.missing).toEqual(base.overall.missing);
    } finally { vi.useRealTimers(); }
    for (const live of [
      () => { throw new Error('boom'); },
      () => snap(workers, 'unavailable'),
    ]) {
      const v = await readFleetRecheck(deps(live));
      expect(v.sections.task.liveWorker).toBeNull();
      expect(v.overall).toEqual(base.overall);
    }
  });

  it('scrubs home paths and omits pid in verdict and reply', async () => {
    const v = await readFleetRecheck(deps(() => snap([w('fake-job', '/Users/fakeuser/secret-repo', 12)])));
    expect(JSON.stringify(v)).not.toMatch(/\/Users\/fakeuser|\/home\/fakeuser|424242/);
    const reply = formatRecheckReply(v);
    expect(reply).not.toMatch(/\/Users\/|\/home\/|424242/);
    expect(reply).toContain('Running job: fake-job · ~/secret-repo · lane claude/work · up 12s · as of '
      + `${ISO} (process evidence, not a claim)`);
  });

  it('prints the line after Task and says up unknown for null age', async () => {
    const lines = formatRecheckReply(await readFleetRecheck(deps(() => snap([w('j', 'phantom', null)])))).split('\n');
    const i = lines.findIndex(l => l.startsWith('Task:'));
    expect(lines[i + 1]).toMatch(/^Last verified:/);
    expect(lines[i + 2]).toContain('up unknown');
    expect(lines.join('\n')).not.toMatch(/routed|dispatched/i);
  });

  it('drops Running job before Last verified and keeps the verdict line', async () => {
    const v = await readFleetRecheck(deps(() => snap([w('j'.repeat(60), 'phantom', 3)])));
    v.sections.task.lastVerified = {
      id: 'x'.repeat(60), owner: 'o'.repeat(60), claimReceipt: 'c'.repeat(60), asOf: ISO, source: 's',
    };
    v.overall.missing = ['m'.repeat(300)];
    const reply = formatRecheckReply(v);
    expect(reply.length).toBeLessThanOrEqual(900);
    expect(reply).not.toContain('Running job');
    expect(reply.split('\n').pop()).toMatch(/^(BLOCKED|UNKNOWN)/);
  });
});
