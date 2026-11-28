/**
 * `phm node` --json error contract: every verb answers a failure with
 * {"schemaVersion":1,"command","error":{"code","message","fix"}} — usage
 * problems exit 2 with code "usage", operational failures exit 1 with code
 * "error" and a masked message — except a missing pool configuration, which
 * is an authored local state named truthfully. docs/NODE-ROUTER.md documents
 * this shape for "any verb"; these tests pin it across the dispatcher's
 * subcommands.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { cmdNodeFleet } from '../src/cli/node-fleet.js';
import { cmdNodePool } from '../src/cli/node-pool.js';
import { cmdNodeSelfUpdate } from '../src/cli/node-self-update.js';
import { cmdNodeCapacity, cmdNodeRoute } from '../src/cli/node-capacity.js';
import { cmdNodeBridge } from '../src/cli/node-bridge.js';
import { ashlrHome } from '../src/core/cloud/store.js';

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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

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

  it('reports an unconfigured pool as an operational refusal naming the missing config', async () => {
    deps.read.mockReturnValue(null);
    const lines = capture();
    expect(await cmdNodePool('worker', ['--json'])).toBe(1);
    const out = lastJson(lines);
    expect(out).toMatchObject({ schemaVersion: 1, command: 'worker', error: { code: 'error' } });
    expect(out.error.message).toContain('no node pool configuration');
    expect(out.error.message).not.toContain('Node pool operation refused');
    expect(out.error.fix).toContain('phm node join');
  });

  it('names a standalone registry instead of claiming no configuration', async () => {
    deps.read.mockReturnValue(null);
    const dir = join(ashlrHome(), 'nodes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'nodes.json'), JSON.stringify({ nodes: [{ nodeId: 'box' }], jobs: [] }));
    const lines = capture();
    expect(await cmdNodePool('status', ['--json'])).toBe(1);
    const out = lastJson(lines);
    expect(out.error).toMatchObject({ code: 'error' });
    expect(out.error.message).toContain('standalone node registry');
    expect(out.error.message).not.toContain('no node pool configuration');
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

describe('node store path honesty under a relocated ASHLR_HOME', () => {
  // docs/add-a-computer.md tells a first-time node to point ASHLR_HOME at a
  // scratch directory; diagnostics must name that real path, not ~/.ashlr.
  function relocatedHome(): string {
    const dir = join(tmpdir(), `phantom-node-paths-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('fleet store failures name the real $ASHLR_HOME/nodes in the fix', async () => {
    const home = relocatedHome();
    try {
      // A regular file where the store dir belongs makes privateDirectory refuse.
      writeFileSync(join(home, 'nodes'), 'not a directory');
      vi.stubEnv('ASHLR_HOME', home);
      const lines = capture();
      expect(await cmdNodeFleet('status', ['--owner', 'scope', '--json'])).toBe(1);
      const out = lastJson(lines);
      expect(out.error.fix).toContain(join(home, 'nodes'));
      expect(out.error.fix).not.toContain('~/.ashlr/nodes');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('fleet store failures describe private storage, not universe jargon', async () => {
    const home = relocatedHome();
    try {
      // A regular file where the store dir belongs makes privateDirectory refuse.
      writeFileSync(join(home, 'nodes'), 'not a directory');
      vi.stubEnv('ASHLR_HOME', home);
      const lines = capture();
      expect(await cmdNodeFleet('status', ['--owner', 'scope', '--json'])).toBe(1);
      const out = lastJson(lines);
      expect(out.error.message).toContain('Private storage');
      expect(out.error.message).not.toContain('Universe storage');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('bridge help and error fix name the real $ASHLR_HOME/node-bridge.json', async () => {
    const home = relocatedHome();
    try {
      vi.stubEnv('ASHLR_HOME', home);
      const lines = capture();
      expect(await cmdNodeBridge(['--help'])).toBe(0);
      expect(lines.at(-1)).toContain(join(home, 'node-bridge.json'));
      deps.bridge.mockImplementation(() => { throw new Error('boom'); });
      lines.length = 0;
      expect(await cmdNodeBridge(['--json'])).toBe(1);
      expect(lastJson(lines).error.fix).toContain(join(home, 'node-bridge.json'));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a default install keeps the ~ contracted spelling', async () => {
    const lines = capture();
    expect(await cmdNodeBridge(['--help'])).toBe(0);
    expect(lines.at(-1)).toContain('~/.ashlr/node-bridge.json');
  });
});
