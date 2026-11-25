/** `phm nodes --json` failures answer with the parseable error envelope `phm node` emits;
 * text mode keeps the usage block on stderr. Every source is injected. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdNodes } from '../src/cli/nodes.js';
import type { HostStats, NodeRecord, NodesState } from '../src/core/drive/nodes/state.js';
import type { NodeProbe } from '../src/core/fleet/nodes-doctor.js';
import type { NodesRegistry, NodesViewDeps } from '../src/core/fleet/nodes-view.js';
import type { QueueOrderV1 } from '../src/core/queue/order-types.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const GIB = 1024 ** 3;
const stats = (): HostStats => ({
  sampledAtMs: NOW, uptimeSeconds: 60, load: [1, 1, 1], ramTotal: 32 * GIB, ramUsed: 8 * GIB, diskFree: null,
  cores: Array.from({ length: 8 }, () => ({ total: 100, idle: 50 })),
});
const node = (nodeId: string): NodeRecord =>
  ({ nodeId, session: 1, heartbeatAt: NOW - 2_000, expiresAt: NOW + 30_000, caps: ['claude'], slots: 2, hostStats: stats() });
const registry = (nodes: NodeRecord[]): NodesRegistry => ({
  source: 'pool-witness', selfNode: 'node-a', pool: { owner: 'acme', primary: 'primary-mac', backup: 'backup-mac' },
  state: { version: 'drive.nodes.v1', sequence: 9, observedAt: NOW - 1_000, nodes, leader: null, jobs: [] } satisfies NodesState,
});
const tailnet = JSON.stringify({ BackendState: 'Running', Self: { HostName: 'node-a' }, Peer: {} });
const deps = (): NodesViewDeps => ({
  peers: { now: () => new Date(NOW), homeDir: () => '/fake-home', exec: () => tailnet },
  readRegistry: () => registry([node('node-a')]), localStats: () => stats(), hostName: () => 'node-a.fake.example', timeZone: 'UTC',
});
const noProbe: NodeProbe = async () => null;
const queueOf = (): QueueOrderV1 =>
  ({ schema: 'queue.order.v1', version: 1, generatedAt: new Date(NOW).toISOString(), count: 0, parked: 0, lanes: ['claude'], jobs: [] });
const noQueue = async () => queueOf();

const logged = () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { log, err };
};
const envelope = (log: ReturnType<typeof logged>['log'], call = 0) => JSON.parse(String(log.mock.calls[call]![0]));

afterEach(() => { vi.restoreAllMocks(); });

describe('phm nodes --json error envelope', () => {
  it('bare view: an unknown command and bad flags answer the envelope on stdout, exit 2', async () => {
    const { log, err } = logged();
    expect(await cmdNodes(['bogus', '--json'], deps(), noQueue, noProbe)).toBe(2);
    expect(envelope(log)).toMatchObject({ schemaVersion: 1, command: 'nodes',
      error: { code: 'usage', message: "Unknown nodes command 'bogus'.", fix: 'Run: phm nodes --help' } });
    expect(err).not.toHaveBeenCalled();

    log.mockClear();
    expect(await cmdNodes(['--bogus', '--json'], deps(), noQueue, noProbe)).toBe(2);
    expect(envelope(log).error.message).toBe("Unknown argument '--bogus' for 'phm nodes'.");

    log.mockClear();
    expect(await cmdNodes(['--can-take', 'BAD!', '--json'], deps(), noQueue, noProbe)).toBe(2);
    expect(envelope(log)).toMatchObject({ command: 'nodes', error: { code: 'usage' } });
    expect(envelope(log).error.message).toContain('--can-take');
  });

  it('every subcommand names the refused argument in the envelope', async () => {
    const { log } = logged();
    const cases: Array<[string[], string, string]> = [
      [['pool', '--bogus', '--json'], 'pool', "Unknown argument '--bogus' for 'phm nodes pool'."],
      [['plan', '--json', '--json'], 'plan', '--json was given twice.'],
      [['doctor', '--node', '--json'], 'doctor', '--node needs a value.'],
      [['offload', 'maybe', '--json'], 'offload', "Unknown offload command 'maybe'."],
      [['offload', 'on', '--json'], 'offload', "Unexpected argument '--json'."],
    ];
    for (const [args, command, message] of cases) {
      log.mockClear();
      expect(await cmdNodes(args, deps(), noQueue, noProbe)).toBe(2);
      expect(envelope(log)).toMatchObject({ schemaVersion: 1, command, error: { code: 'usage', message, fix: 'Run: phm nodes --help' } });
    }
  });

  it('doctor --node with an unknown name is a not-found envelope, exit 1', async () => {
    const { log, err } = logged();
    expect(await cmdNodes(['doctor', '--node', 'nope', '--json'], deps(), noQueue, noProbe)).toBe(1);
    expect(envelope(log)).toMatchObject({ schemaVersion: 1, command: 'doctor',
      error: { code: 'not-found', message: 'No computer named nope.', fix: 'Run: phm nodes to list them.' } });
    expect(err).not.toHaveBeenCalled();
  });

  it('text mode is unchanged: usage block on stderr, nothing parseable promised on stdout', async () => {
    const { log, err } = logged();
    expect(await cmdNodes(['bogus'], deps(), noQueue, noProbe)).toBe(2);
    expect(String(err.mock.calls[0]![0])).toContain('Usage: phm nodes');
    expect(log).not.toHaveBeenCalled();

    err.mockClear();
    expect(await cmdNodes(['doctor', '--node', 'nope'], deps(), noQueue, noProbe)).toBe(1);
    expect(String(err.mock.calls[0]![0])).toBe('No computer named nope. Run `phm nodes` to list them.');
    expect(log).not.toHaveBeenCalled();
  });

  it('--help still prints usage and exits 0 on every verb', async () => {
    const { log, err } = logged();
    for (const args of [['--help'], ['pool', '--help'], ['offload', 'on', '--help']]) {
      log.mockClear(); err.mockClear();
      expect(await cmdNodes(args, deps(), noQueue, noProbe)).toBe(0);
      expect(String(log.mock.calls[0]![0])).toContain('Usage: phm nodes');
      expect(err).not.toHaveBeenCalled();
    }
  });
});
