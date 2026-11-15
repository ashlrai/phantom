import { mkdtempSync, writeFileSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildNodesSnapshot } from '../src/core/nodes/view.js';
import { cmdNodes } from '../src/cli/nodes.js';

const FIXTURE = join(__dirname, 'fixtures/nodes');
const NOW = Date.parse('2026-11-02T12:00:30Z');
const dirs: string[] = [];

function dirWith(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'nodes-'));
  dirs.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('nodes view', () => {
  it('reports role, caps, heartbeat age, live jobs and the leader badge deterministically', () => {
    const dir = dirWith();
    const a = buildNodesSnapshot({ nowMs: NOW, dir });
    const b = buildNodesSnapshot({ nowMs: NOW, dir });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.leaderId).toBe('mac-mini-1');
    expect(a.nodes.map((n) => [n.id, n.role, n.status, n.heartbeatAgeMs, n.liveJobs.length, n.leader])).toEqual([
      ['lima-vm-2', 'worker', 'stale', 210_000, 0, false],
      ['mac-mini-1', 'leader', 'ready', 30_000, 2, true],
    ]);
    expect(a.nodes[1]!.caps).toEqual(['arch:arm64', 'codex', 'gh', 'os:darwin']);
    expect(a.error).toBeNull();
  });

  it('gives no leader once the lease expires or the holder is down, and demotes a stale leader claim', () => {
    const late = buildNodesSnapshot({ nowMs: NOW + 600_000, dir: dirWith() });
    expect(late.leaderId).toBeNull();
    expect(late.nodes.find((n) => n.id === 'mac-mini-1')).toMatchObject({ leader: false, role: 'standby', status: 'down' });
  });

  it('rejects an inventory holding a token-shaped value without echoing it', () => {
    const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4';
    const raw = JSON.parse(readFileSync(join(FIXTURE, 'nodes.json'), 'utf8'));
    raw.nodes[0].caps.push(secret);
    const snap = buildNodesSnapshot({ nowMs: NOW, dir: dirWith({ 'nodes.json': JSON.stringify(raw) }) });
    expect(snap.nodes).toEqual([]);
    expect(snap.error).toBe('inventory contains a secret-shaped value');
    expect(JSON.stringify(snap)).not.toContain(secret);
  });

  it('reports malformed, invalid and duplicate inventories without inventing nodes', () => {
    const raw = JSON.parse(readFileSync(join(FIXTURE, 'nodes.json'), 'utf8'));
    raw.nodes.push(raw.nodes[0]);
    for (const body of ['{nope', '{"version":"invalid"}', JSON.stringify(raw)]) {
      const snap = buildNodesSnapshot({ nowMs: NOW, dir: dirWith({ 'nodes.json': body }) });
      expect(snap.nodes).toEqual([]);
      expect(snap.error).toMatch(/inventory (is not valid JSON|failed validation)/);
    }
  });

  it('reports a missing inventory without inventing a local node', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nodes-missing-'));
    dirs.push(dir);
    const snap = buildNodesSnapshot({ nowMs: NOW, dir });
    expect(snap.nodes).toEqual([]);
    expect(snap.error).toBe('inventory missing');
  });
});

describe('phm nodes', () => {
  it('prints parseable --json and a human table, and rejects bad flags with a fix', () => {
    const home = mkdtempSync(join(tmpdir(), 'nodes-home-'));
    dirs.push(home);
    vi.stubEnv('ASHLR_HOME', home);
    cpSync(FIXTURE, join(home, 'nodes'), { recursive: true });
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
    expect(err.mock.calls[0]![0]).toContain('Usage: ashlr fleet nodes');
    expect(cmdNodes(['--now', 'soon'])).toBe(2);
    rmSync(join(home, 'nodes', 'nodes.json'));
    out.length = 0;
    expect(cmdNodes(['--json'])).toBe(1);
    expect(JSON.parse(out[0]!).error).toBe('inventory missing');
  });
});
