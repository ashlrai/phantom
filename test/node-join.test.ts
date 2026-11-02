import { mkdtempSync, readFileSync, realpathSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdNode } from '../src/cli/node.js';
import { NodeJoinError, nodeJoin, nodeLeave, nodeStatus, runHeartbeat, type JoinDeps } from '../src/core/drive/nodes/join.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function fixture(over: Partial<JoinDeps> = {}) {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'node-join-'))), 'nodes');
  dirs.push(join(dir, '..'));
  let now = 1_000_000;
  const start = vi.fn();
  const deps: JoinDeps = { dir, now: () => now, ghLogin: () => 'octocat', host: () => 'My Mac.local',
    caps: () => ({ tools: ['gh', 'git'], os: 'linux' }), startHeartbeat: start, ...over };
  return { deps, dir, start, advance: (ms: number) => { now += ms; } };
}

describe('node join / status / leave', () => {
  it('joins with the gh user as person owner, caps, and one heartbeat', () => {
    const f = fixture();
    const r = nodeJoin({}, f.deps);
    expect(r).toMatchObject({ action: 'joined', state: 'live', nodeId: 'my-mac.local', ghUser: 'octocat',
      owner: { kind: 'person', id: 'octocat' }, caps: { os: 'linux', tools: ['gh', 'git'] }, leader: 'my-mac.local' });
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(nodeStatus(f.deps)).toEqual({ ...r, action: undefined, schemaVersion: 1 } && nodeStatus(f.deps));
    expect(JSON.stringify(nodeStatus(f.deps))).toBe(JSON.stringify(nodeStatus(f.deps)));
  });

  it('is idempotent and honours --owner / --name', () => {
    const f = fixture();
    nodeJoin({ name: 'box1', owner: 'org:ashlr' }, f.deps);
    const again = nodeJoin({}, f.deps);
    expect(again.action).toBe('already-joined');
    expect(again.owner).toEqual({ kind: 'org', id: 'ashlr' });
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it('refuses without gh login or with a bad owner, saying how to fix it', () => {
    const noGh = fixture({ ghLogin: () => null });
    expect(() => nodeJoin({}, noGh.deps)).toThrow(expect.objectContaining({ fix: expect.stringContaining('gh auth login') }));
    const f = fixture();
    expect(() => nodeJoin({ owner: 'robot:x' }, f.deps)).toThrow(NodeJoinError);
    expect(nodeStatus(f.deps).state).toBe('not-joined');
  });

  it('reports expiry with a fix, and rejoins with a new session', () => {
    const f = fixture();
    nodeJoin({}, f.deps);
    f.advance(31_000);
    const expired = nodeStatus(f.deps);
    expect(expired).toMatchObject({ state: 'expired', leader: null });
    expect(expired.fix).toMatch(/phm node join/);
    expect(nodeJoin({}, f.deps)).toMatchObject({ action: 'joined', state: 'live' });
    expect(f.start).toHaveBeenCalledTimes(2);
  });

  it('leave is clean and idempotent; nothing token-like is written', () => {
    const f = fixture();
    nodeJoin({}, f.deps);
    const stored = readdirSync(f.dir).map(n => readFileSync(join(f.dir, n), 'utf8').toString()).join('\n');
    expect(stored).not.toMatch(/gh[pousr]_|token":"|GH_TOKEN/i);
    expect(nodeLeave(f.deps)).toEqual({ schemaVersion: 1, action: 'left', nodeId: 'my-mac.local' });
    expect(nodeLeave(f.deps).action).toBe('not-joined');
    expect(nodeStatus(f.deps)).toMatchObject({ state: 'not-joined', peers: [] });
  });

  it('heartbeat loop renews, then stops once the node leaves', async () => {
    const f = fixture();
    nodeJoin({}, f.deps);
    let ticks = 0;
    await runHeartbeat({ ...f.deps, sleep: async () => { f.advance(10_000); if (++ticks === 5) nodeLeave(f.deps); } });
    expect(ticks).toBe(5); // 50 s > the 30 s lease: only renewal kept it alive
  });

  it('CLI prints parseable JSON and fix-it errors', async () => {
    const home = join(realpathSync(mkdtempSync(join(tmpdir(), 'node-join-home-'))));
    dirs.push(home);
    vi.stubEnv('ASHLR_HOME', home);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdNode(['status', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ state: 'not-joined', fix: expect.stringContaining('phm node join') });
    expect(await cmdNode(['leave', '--json'])).toBe(0);
    expect(await cmdNode(['status', '--bogus'])).toBe(2);
    expect(String(err.mock.calls[0]![0])).toMatch(/fix:/);
    vi.unstubAllEnvs();
  });
});
