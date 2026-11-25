/**
 * `phm node` --json error contract: every verb answers a failure with
 * {"schemaVersion":1,"command","error":{"code","message","fix"}} — usage
 * problems exit 2 with code "usage", operational failures exit 1 with code
 * "error" and a masked message. docs/NODE-ROUTER.md documents this shape for
 * "any verb"; these tests pin it across the dispatcher's subcommands.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const deps = vi.hoisted(() => ({
  read: vi.fn(), configure: vi.fn(), call: vi.fn(), capacity: vi.fn(), worker: vi.fn(), bridge: vi.fn(),
}));
vi.mock('../src/core/drive/nodes/pool-host.js', () => ({
  readPoolConfig: deps.read, configurePool: deps.configure, callPool: deps.call,
  serveNodeRpc: vi.fn(), poolDirectory: () => '/unused',
}));
vi.mock('../src/core/drive/nodes/worker.js', () => ({ probeNodeLanes: () => ['codex'], runNodeWorker: deps.worker }));
vi.mock('../src/core/drive/nodes/capacity.js', () => ({ readNodeCapacity: deps.capacity }));
vi.mock('../src/core/drive/nodes/ready-bridge-run.js', () => ({ runConfiguredNodeBridge: deps.bridge }));

import { cmdNode } from '../src/cli/node.js';
import { cmdNodePool } from '../src/cli/node-pool.js';
import { cmdNodeSelfUpdate } from '../src/cli/node-self-update.js';
import { cmdNodeCapacity, cmdNodeRoute } from '../src/cli/node-capacity.js';
import { cmdNodeBridge } from '../src/cli/node-bridge.js';

const config = { role: 'worker', node: 'air', owner: 'mason', primary: 'primary-mac', backup: 'backup-mac' };

function capture() {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation((line: string) => { lines.push(String(line)); });
  return lines;
}
const lastJson = (lines: string[]) => JSON.parse(lines.at(-1)!);

beforeEach(() => {
  vi.resetAllMocks();
  deps.read.mockReturnValue(config);
  deps.capacity.mockReturnValue({ slots: 2, held: null });
  deps.call.mockImplementation((_config, verb) => ({ demoted: false, result: verb === 'status' ? { nodes: [], jobs: [] } : {} }));
});
afterEach(() => vi.restoreAllMocks());

describe('phm node pool verbs', () => {
  it('names local usage refusals instead of masking them as pool failures', async () => {
    const lines = capture();
    expect(await cmdNodePool('worker', ['--json'])).toBe(2);
    expect(lastJson(lines)).toMatchObject({ schemaVersion: 1, command: 'worker',
      error: { code: 'usage', message: expect.stringContaining('--runner'), fix: expect.any(String) } });
  });

  it('rejects malformed pool flags as usage', async () => {
    const lines = capture();
    expect(await cmdNodePool('watch', ['--bogus', '--json'])).toBe(2);
    expect(lastJson(lines)).toMatchObject({ command: 'watch', error: { code: 'usage' } });
  });

  it('rejects an undocumented pool role as usage', async () => {
    const lines = capture();
    expect(await cmdNodePool('pool', ['--role', 'worker', '--node', 'air', '--owner', 'mason',
      '--primary', 'primary-mac', '--backup', 'backup-mac', '--json'])).toBe(2);
    expect(lastJson(lines).error).toMatchObject({ code: 'usage', message: expect.stringContaining('--role') });
  });

  it('masks operational failures behind the fixed pool message', async () => {
    deps.call.mockImplementation(() => { throw new Error('ssh secret detail'); });
    const lines = capture();
    expect(await cmdNodePool('status', ['--json'])).toBe(1);
    const out = lastJson(lines);
    expect(out).toMatchObject({ schemaVersion: 1, command: 'status', error: { code: 'error' } });
    expect(out.error.message).toContain('Node pool operation refused or unavailable');
    expect(out.error.message).not.toContain('secret detail');
  });

  it('reports an unconfigured pool as an operational refusal', async () => {
    deps.read.mockReturnValue(null);
    const lines = capture();
    expect(await cmdNodePool('status', ['--json'])).toBe(1);
    expect(lastJson(lines)).toMatchObject({ command: 'status', error: { code: 'error' } });
  });
});

describe('phm node self-update', () => {
  it('emits the full error envelope for argument refusals', async () => {
    const lines = capture();
    const nodesFn = vi.fn(async () => []);
    expect(await cmdNodeSelfUpdate(['--bogus', '--json'], { nodes: nodesFn, localVersion: () => '1.0.0' })).toBe(2);
    expect(nodesFn).not.toHaveBeenCalled();
    expect(lastJson(lines)).toMatchObject({ schemaVersion: 1, command: 'self-update',
      error: { code: 'usage', fix: expect.stringContaining('self-update --help') } });
  });

  it('treats a missing --owner with no pool as usage, not an operational failure', async () => {
    const lines = capture();
    expect(await cmdNodeSelfUpdate(['--json'])).toBe(2);
    expect(lastJson(lines).error).toMatchObject({ code: 'usage', message: expect.stringContaining('--owner') });
  });

  it('masks registry read failures', async () => {
    const lines = capture();
    expect(await cmdNodeSelfUpdate(['--owner', 'ashlr', '--json'],
      { nodes: async () => { throw new Error('ssh secret detail'); }, localVersion: () => '1.0.0' })).toBe(1);
    const out = lastJson(lines);
    expect(out.error).toMatchObject({ code: 'error' });
    expect(out.error.message).not.toContain('secret detail');
  });
});

describe('phm node capacity and route', () => {
  it('capacity usage refusals carry the command name and fix', async () => {
    const lines = capture();
    expect(await cmdNodeCapacity(['--bogus', '--json'])).toBe(2);
    expect(lastJson(lines)).toMatchObject({ schemaVersion: 1, command: 'capacity',
      error: { code: 'usage', fix: 'Run: phm node capacity --help' } });
  });

  it('route usage refusals carry the command name and fix', async () => {
    const lines = capture();
    expect(await cmdNodeRoute(['--json'])).toBe(2);
    expect(lastJson(lines)).toMatchObject({ schemaVersion: 1, command: 'route',
      error: { code: 'usage', fix: 'Run: phm node route --help' } });
  });
});

describe('phm node dispatcher and bridge', () => {
  it('unknown verbs and bad lanes arguments get the usage envelope', async () => {
    const lines = capture();
    expect(await cmdNode(['bogus', '--json'])).toBe(2);
    expect(lastJson(lines)).toMatchObject({ schemaVersion: 1, command: 'node',
      error: { code: 'usage', message: expect.stringContaining('bogus') } });
    expect(await cmdNode(['lanes', '--bogus', '--json'])).toBe(2);
    expect(lastJson(lines)).toMatchObject({ schemaVersion: 1, command: 'lanes', error: { code: 'usage' } });
  });

  it('bridge operational failures emit the envelope instead of throwing', async () => {
    deps.bridge.mockImplementation(() => { throw new Error('secret detail'); });
    const lines = capture();
    expect(await cmdNodeBridge(['--json'])).toBe(1);
    const out = lastJson(lines);
    expect(out).toMatchObject({ schemaVersion: 1, command: 'bridge', error: { code: 'error' } });
    expect(out.error.message).not.toContain('secret detail');
  });

  it('bridge shows fixed operator-facing store messages verbatim', async () => {
    deps.bridge.mockImplementation(() => { throw new Error('Invalid drive nodes state'); });
    const lines = capture();
    expect(await cmdNodeBridge(['--json'])).toBe(1);
    expect(lastJson(lines).error.message).toBe('Invalid drive nodes state');
  });
});
