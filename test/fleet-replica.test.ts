import { mkdirSync, mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetLaneSlots } from '../src/cli/fleet-lane-slots.js';
import { cmdOrg } from '../src/cli/org.js';
import { fleetReplicaStatus, machineReport, serveFleetReplica, syncFleetReplica } from '../src/core/fleet/fleet-replica.js';
import { renderOrgTreeText } from '../src/core/fleet/org-tree.js';
import { readFleetOrgMap } from '../src/core/verse/fleet-org-map-api.js';

const { location, readOnlySsh } = vi.hoisted(() => ({
  location: { machine: 'leader-mac' },
  readOnlySsh: vi.fn<typeof import('../src/core/drive/nodes/ssh.js').callNodeSshReadOnly>(),
}));
vi.mock('../src/core/drive/nodes/ssh.js', async original => ({
  ...await original<typeof import('../src/core/drive/nodes/ssh.js')>(),
  callNodeSshReadOnly: readOnlySsh,
}));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(),
  homedir: () => process.env.HOME!, hostname: () => location.machine,
}));
vi.mock('../src/core/verse/display-standing-policy.js', () => ({
  displayStandingPolicy: () => location.machine === 'leader-mac'
    ? { grantId: '0123456789abcdef0123456789abcdef', grantSeq: 28, repos: [] } : null,
}));

let root: string;
const NOW = Date.parse('2026-11-24T12:00:00Z');
function useHost(machine: string): void {
  location.machine = machine;
  const home = join(root, machine);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  vi.stubEnv('HOME', home);
  vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(home, '.ashlr-runs'));
}
function put(path: string, content: unknown): void {
  const full = join(process.env.HOME!, path);
  mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
  writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-replica-'));
  vi.useFakeTimers({ toFake: ['Date'] });
  readOnlySsh.mockReset().mockRejectedValue(new Error('offline'));
  vi.setSystemTime(NOW);
  useHost('leader-mac');
  const at = new Date(NOW).toISOString();
  put('.ashlr-runs/coordination/leader-board.json', { schema: 'fleet.leader-board.v1', generatedAt: at, lanes: [],
    queueDepthByTier: { work: 5 }, mergesLastHour: 2, conflictingPrs: { count: null, delta: null, trend: 'unknown', history: [] },
    needsMason: { status: 'missing', count: 0, items: [] }, sources: { readyTsv: 'healthy', queueCounts: 'ok', needsMason: 'missing' } });
  put('.ashlr-runs/queue/status.json', { last_tick: at, paused: false, mem_free_pct: 71,
    lanes: { claude: { target: 4, running: 2, queued: 5, held: false } } });
  put('.ashlr-runs/dispatch-events.log', '2026-11-24 12:00:00 LEADER running\n2026-11-24 12:00:00 ORCH-PLAN ready\n');
  put('.ashlr/fleet/runtime/tick.json', {
    v: 1, at, capabilityKind: null, dryRun: false, standing: { grantId: 'fixture', stageId: 'work', switch: 'autonomous' },
    lanes: [{ lane: 'claude-cli', slots: 4, busy: 0, capReason: null }], presence: { state: 'unknown' },
    holdProduction: null, pausedRepos: [], waitingVerify: null, openPrsByRepo: null, ledgerHead: null, held: [], watch: { available: false, reason: null },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('authenticated fleet projection across two homes', () => {
  const report = { machine: 'muse', lanes: [{ lane: 'gemini-neon', processes: 1, claims: 1 }] };
  async function leaderRpc(alias: string, request: unknown) {
    expect(alias).toBe('leader-mac');
    expect(request).toMatchObject({ kind: 'replica', report: { machine: 'muse' } });
    useHost('leader-mac');
    try { return await serveFleetReplica({ report }); } finally { useHost('muse'); }
  }
  it('uses the leader view from org and lane-slots with no worker coordination or grant', async () => {
    await serveFleetReplica({ report: { machine: 'air', lanes: [] } });
    useHost('muse');
    expect(existsSync(join(process.env.HOME!, '.ashlr-runs'))).toBe(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const status = await syncFleetReplica({ leader: 'leader-mac', ssh: leaderRpc });
    expect(status).toMatchObject({ lastError: null, source: { machine: 'leader-mac', via: 'leader-replica', ageSeconds: 0, stale: false } });
    expect(await cmdOrg(['--text'])).toBe(0);
    expect(log.mock.lastCall?.[0]).toContain('Executor: running');
    expect(log.mock.lastCall?.[0]).toContain('Dispatcher running');
    expect(log.mock.lastCall?.[0]).toContain('Source: leader-mac (leader-replica)');
    expect(log.mock.lastCall?.[0]).toContain('gemini-neon @ muse');
    const worker = (await readFleetOrgMap()).tree;
    expect(worker.peerSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ machine: 'air', via: 'leader-replica', stale: false }),
      expect.objectContaining({ machine: 'muse', via: 'leader-replica', stale: false }),
    ]));
    expect(worker.leader.dispatcher).toEqual({ paused: false, lastTick: '2026-11-24T12:00:00.000Z' });
    expect(worker.lanes).toEqual(expect.arrayContaining([expect.objectContaining({ lane: 'claude', machine: 'leader-mac', running: 2, target: 4, queued: 5 })]));
    expect(await cmdFleetLaneSlots(['--json'])).toBe(0);
    expect(JSON.parse(log.mock.lastCall![0]).lanes).toEqual(expect.arrayContaining([
      expect.objectContaining({ lane: 'claude-cli', machine: 'leader-mac', slots: 4, capReason: 'Governed by leader grant #28 on leader-mac' }),
    ]));
    expect(existsSync(join(process.env.HOME!, '.ashlr-runs', 'coordination'))).toBe(false);
    expect(existsSync(join(process.env.ASHLR_HOME!, 'authority'))).toBe(false);
    useHost('leader-mac');
    const leader = (await readFleetOrgMap()).tree;
    expect(leader.leader).toEqual(worker.leader);
    expect(leader.lanes).toEqual(expect.arrayContaining([expect.objectContaining({ lane: 'gemini-neon', machine: 'muse', running: 1 })]));
  });

  it('preserves the last good sample, then reports null facts on expiry', async () => {
    useHost('muse');
    const ssh = vi.fn(leaderRpc);
    await syncFleetReplica({ leader: 'leader-mac', ssh });
    await syncFleetReplica({ ssh });
    expect(ssh).toHaveBeenCalledTimes(1);
    await syncFleetReplica({ force: true, ssh: () => { throw new Error('offline'); } });
    expect(fleetReplicaStatus()).toMatchObject({ source: { stale: false }, lastError: 'Fleet leader snapshot unavailable over SSH' });
    vi.setSystemTime(NOW + 120_001);
    const { tree } = await readFleetOrgMap();
    expect(tree.leader).toMatchObject({ state: 'unknown', dispatcher: { lastTick: null, paused: null } });
    expect(renderOrgTreeText(tree)).toContain('leader unreachable since 2026-11-24T12:00:00.000Z');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await cmdFleetLaneSlots(['--json']);
    expect(JSON.parse(log.mock.lastCall![0]).lanes).toEqual(expect.arrayContaining([
      expect.objectContaining({ lane: 'claude-cli', slots: null, busy: null, capReason: 'leader unreachable since 2026-11-24T12:00:00.000Z' }),
    ]));
  });

  it('refreshes a stale configured replica when org is read', async () => {
    useHost('muse');
    await syncFleetReplica({ leader: 'leader-mac', ssh: leaderRpc });
    vi.setSystemTime(NOW + 120_001);
    readOnlySsh.mockImplementation(leaderRpc);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdOrg(['--text'])).toBe(0);
    expect(await cmdOrg(['--text'])).toBe(0);
    expect(readOnlySsh).toHaveBeenCalledTimes(1);
    expect(readOnlySsh.mock.calls[0]?.[3]?.timeoutMs).toBe(5_000);
    expect(log.mock.lastCall?.[0]).toContain('Source: leader-mac (leader-replica)');
    expect(log.mock.lastCall?.[0]).not.toContain('leader unreachable');
  });

  it('abandons an unresponsive replica pull at five seconds and retains the observation', async () => {
    useHost('muse');
    await syncFleetReplica({ leader: 'leader-mac', ssh: leaderRpc });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW + 120_001);
    let started!: (signal: AbortSignal | undefined) => void;
    const sshStarted = new Promise<AbortSignal | undefined>(resolve => { started = resolve; });
    readOnlySsh.mockImplementation((_host, _request, _size, options) => {
      started(options?.signal);
      return new Promise(() => undefined);
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const org = cmdOrg(['--text']);
    const signal = await sshStarted;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await org).toBe(0);
    expect(signal?.aborted).toBe(true);
    expect(log.mock.lastCall?.[0]).toContain('leader unreachable since 2026-11-24T12:00:00.000Z');
    expect(fleetReplicaStatus().lastError).toBe('Fleet leader snapshot unavailable over SSH');
  });

  it('refuses malformed peer input and distinguishes an empty cache from zero capacity', async () => {
    await expect(serveFleetReplica({ report: { ...report, machine: '../muse' } })).rejects.toThrow('Invalid fleet machine report');
    useHost('muse');
    expect(fleetReplicaStatus()).toMatchObject({ leader: null, source: null });
    await syncFleetReplica({ leader: 'leader-mac', ssh: () => ({ schema: 'wrong' }) });
    await expect(serveFleetReplica({ report })).rejects.toThrow('Fleet leader data unavailable');
    expect((await readFleetOrgMap()).tree.source).toMatchObject({ stale: true, reason: 'leader unreachable since never reached' });
    expect(machineReport('muse', '/bin/bash /tool/arloop.sh --lane devin --private irrelevant\n/tool/muse-runner\n', ['devin'],
      { gemini: { running: 1, target: 3, queued: 2, held: false } }).lanes)
      .toEqual([{ lane: 'devin', processes: 1, claims: 1 }, { lane: 'muse-runner', processes: 1, claims: null },
        { lane: 'gemini', processes: null, claims: null, dispatch: { running: 1, target: 3, queued: 2, held: false } }]);
  });
});
