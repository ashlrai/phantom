import { mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildNodesSnapshot } from '../src/core/nodes/view.js';
import { cmdNodes } from '../src/cli/nodes.js';

const FIXTURE = join(__dirname, 'fixtures/nodes');
const NOW = Date.parse('2026-11-02T12:00:30Z');

function dirWith(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'nodes-'));
  cpSync(FIXTURE, dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

afterEach(() => { vi.restoreAllMocks(); delete process.env['ASHLR_HOME']; });

describe('nodes view', () => {
  it('reports role, caps, heartbeat age, live jobs and the leader badge deterministically', () => {
    const a = buildNodesSnapshot({ nowMs: NOW, dir: dirWith(), local: null });
    const b = buildNodesSnapshot({ nowMs: NOW, dir: dirWith(), local: null });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.leaderId).toBe('mac-mini-1');
    expect(a.nodes.map((n) => [n.id, n.role, n.status, n.heartbeatAgeMs, n.liveJobs.length, n.leader])).toEqual([
      ['lima-vm-2', 'worker', 'stale', 210_000, 0, false],
      ['mac-mini-1', 'leader', 'ready', 30_000, 2, true],
    ]);
    expect(a.nodes[1]!.caps).toEqual(['arch:arm64', 'codex', 'gh', 'os:darwin']);
    expect(a.problems).toEqual([]);
  });

  it('gives no leader once the lease expires or the holder is down, and demotes a stale leader claim', () => {
    const late = buildNodesSnapshot({ nowMs: NOW + 600_000, dir: dirWith(), local: null });
    expect(late.leaderId).toBeNull();
    expect(late.nodes.find((n) => n.id === 'mac-mini-1')).toMatchObject({ leader: false, role: 'standby', status: 'down' });
  });

  it('drops a record holding a token-shaped value without echoing it', () => {
    const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4';
    const snap = buildNodesSnapshot({ nowMs: NOW, local: null, dir: dirWith({ 'leaky.json': JSON.stringify({ id: 'leaky', caps: [secret] }) }) });
    expect(snap.nodes.map((n) => n.id)).not.toContain('leaky');
    expect(snap.problems).toHaveLength(1);
    expect(snap.problems[0]!.fix).toContain('log in on that node');
    expect(JSON.stringify(snap)).not.toContain(secret);
  });

  it('turns bad records into problems that say how to fix them', () => {
    const snap = buildNodesSnapshot({ nowMs: NOW, local: null, dir: dirWith({
      'bad.json': '{nope', 'role.json': '{"id":"r","role":"boss"}', 'zdup.json': '{"id":"mac-mini-1"}', 'noid.json': '{}',
    }) });
    expect(snap.problems.map((p) => p.file)).toEqual(['bad.json', 'noid.json', 'role.json', 'zdup.json']);
    for (const p of snap.problems) expect(p.fix.length).toBeGreaterThan(10);
    expect(snap.nodes).toHaveLength(2);
  });

  it('includes this machine when no registry exists', () => {
    const snap = buildNodesSnapshot({ nowMs: NOW, dir: join(tmpdir(), 'nodes-missing-dir') });
    expect(snap.nodes.map((n) => n.id)).toEqual(['local']);
    expect(snap.nodes[0]!.source).toBe('local');
  });
});

describe('phm nodes', () => {
  it('prints parseable --json and a human table, and rejects bad flags with a fix', () => {
    const home = mkdtempSync(join(tmpdir(), 'nodes-home-'));
    process.env['ASHLR_HOME'] = home;
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
    expect(err.mock.calls[0]![0]).toContain('Usage: phm nodes');
    expect(cmdNodes(['--now', 'soon'])).toBe(2);
  });
});
