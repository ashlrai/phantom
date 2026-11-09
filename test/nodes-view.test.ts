import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildNodesSnapshot } from '../src/core/nodes/view.js';
import { cmdNodes } from '../src/cli/nodes.js';

const FIXTURE = join(__dirname, 'fixtures/nodes');
const NOW = Date.parse('2026-11-02T12:00:30Z');

function dirWith(nodesJson?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'nodes-'));
  cpSync(FIXTURE, dir, { recursive: true });
  if (nodesJson !== undefined) writeFileSync(join(dir, 'nodes.json'), nodesJson);
  return dir;
}

function fixtureJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE, 'nodes.json'), 'utf8')) as Record<string, unknown>;
}

afterEach(() => { vi.restoreAllMocks(); delete process.env['ASHLR_HOME']; });

describe('nodes view', () => {
  it('reports role, caps, heartbeat age, live jobs and the leader badge deterministically', () => {
    const a = buildNodesSnapshot({ nowMs: NOW, dir: dirWith(), local: null });
    const b = buildNodesSnapshot({ nowMs: NOW, dir: dirWith(), local: null });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.schema).toBe('phantom.nodes.v1');
    expect(a.leaderId).toBe('mac-mini-1');
    expect(a.nodes.map((n) => [n.id, n.role, n.status, n.heartbeatAgeMs, n.liveJobs, n.leader])).toEqual([
      ['build-01', 'worker', 'stale', 120_000, [], false],
      ['lima-vm-2', 'standby', 'down', 200_000, [], false],
      ['mac-mini-1', 'leader', 'ready', 30_000, ['job-7', 'job-9'], true],
    ]);
    expect(a.nodes[2]!.caps).toEqual(['arch:arm64', 'codex', 'gh', 'os:darwin']);
    expect(a.nodes[2]!.owners).toEqual(['mason']);
    expect(a.nodes[2]!.ghAuth).toBe('ok');
    expect(a.problems).toEqual([]);
  });

  it('gives no leader once the lease expires, and demotes dead-lease and backup nodes to standby', () => {
    const late = buildNodesSnapshot({ nowMs: NOW + 600_000, dir: dirWith(), local: null });
    expect(late.leaderId).toBeNull();
    expect(late.nodes.every((n) => !n.leader)).toBe(true);
    expect(late.nodes.find((n) => n.id === 'mac-mini-1')).toMatchObject({ role: 'standby', status: 'down' });
    expect(late.nodes.find((n) => n.id === 'lima-vm-2')).toMatchObject({ role: 'standby', status: 'down' });
  });

  it('drops a registry holding a token-shaped value without echoing it', () => {
    const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4';
    const state = fixtureJson();
    (state['nodes'] as Record<string, unknown>[])[0]!['note'] = secret;
    const snap = buildNodesSnapshot({ nowMs: NOW, local: null, dir: dirWith(JSON.stringify(state)) });
    expect(snap.nodes).toEqual([]);
    expect(snap.leaderId).toBeNull();
    expect(snap.problems).toHaveLength(1);
    expect(snap.problems[0]!.file).toBe('nodes.json');
    expect(snap.problems[0]!.fix).toContain('auth');
    expect(JSON.stringify(snap)).not.toContain(secret);
  });

  it('turns unreadable or invalid registries into problems that say how to fix them', () => {
    const badJson = buildNodesSnapshot({ nowMs: NOW, local: null, dir: dirWith('{nope') });
    expect(badJson.problems.map((p) => [p.file, p.problem])).toEqual([['nodes.json', 'not valid JSON']]);
    expect(badJson.problems[0]!.fix).toContain('nodes.json');

    const badState = buildNodesSnapshot({ nowMs: NOW, local: null, dir: dirWith('{"version":"nope"}') });
    expect(badState.problems.map((p) => p.problem)).toEqual(['failed registry validation']);

    const dup = fixtureJson();
    const nodes = dup['nodes'] as Record<string, unknown>[];
    nodes.push({ ...nodes[0]! });
    const dupSnap = buildNodesSnapshot({ nowMs: NOW, local: null, dir: dirWith(JSON.stringify(dup)) });
    expect(dupSnap.problems.map((p) => p.problem)).toEqual(['failed registry validation']);
    expect(dupSnap.nodes).toEqual([]);
  });

  it('treats a missing registry as empty, not a problem, and still lists this machine', () => {
    const snap = buildNodesSnapshot({ nowMs: NOW, dir: join(tmpdir(), 'nodes-missing-dir') });
    expect(snap.problems).toEqual([]);
    expect(snap.nodes.map((n) => n.id)).toEqual(['local']);
    expect(snap.nodes[0]!.source).toBe('local');
  });
});

describe('phm nodes', () => {
  it('prints parseable --json and a human table, and rejects bad flags with a fix', () => {
    const home = mkdtempSync(join(tmpdir(), 'nodes-home-'));
    process.env['ASHLR_HOME'] = home;
    mkdirSync(join(home, 'nodes'));
    writeFileSync(join(home, 'nodes', 'nodes.json'), readFileSync(join(FIXTURE, 'nodes.json')));
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => { out.push(m); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(cmdNodes(['--json', '--now', '2026-11-02T12:00:30Z'])).toBe(0);
    const parsed = JSON.parse(out[0]!);
    expect(parsed.schema).toBe('phantom.nodes.v1');
    expect(parsed.leaderId).toBe('mac-mini-1');
    out.length = 0;
    expect(cmdNodes(['--now', '2026-11-02T12:00:30Z'])).toBe(0);
    expect(out.join('\n')).toContain('★ mac-mini-1');
    expect(cmdNodes(['--bogus'])).toBe(2);
    expect(err.mock.calls[0]![0]).toContain('Usage: phm nodes');
    expect(cmdNodes(['--now', 'soon'])).toBe(2);
  });
});
