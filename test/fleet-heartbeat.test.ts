import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetHeartbeat, fsHeartbeatReader, readFleetHeartbeat, type HeartbeatReader } from '../src/cli/fleet-heartbeat.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

function reader(queue: string | null, files: Array<{ name: string; text: string }> = []): HeartbeatReader {
  return { queueStatus: async () => queue, supervisorStatuses: async () => files };
}
const queue = (minAgo: number) => JSON.stringify({ last_tick: at(minAgo), paused: false });

let out: string[];
let err: string[];
beforeEach(() => {
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((m: string) => { out.push(String(m)); });
  vi.spyOn(console, 'error').mockImplementation((m: string) => { err.push(String(m)); });
  vi.spyOn(process.stdout, 'write').mockImplementation((m: string | Uint8Array) => { out.push(String(m)); return true; });
});
afterEach(() => vi.restoreAllMocks());

describe('fleet heartbeat', () => {
  it('all fresh prints one line per source and exits 0', async () => {
    const r = reader(queue(5), [{ name: 'status-main.md', text: `# Supervisor ${at(10)}\nmain: up\n` }]);
    expect(await cmdFleetHeartbeat([], { reader: r, now: () => NOW })).toBe(0);
    expect(out).toEqual(['queue/status.json: 5 min old', 'supervisor/status-main.md: 10 min old', 'Heartbeat: ok']);
  });

  it('flags a stale source and exits 1', async () => {
    const r = reader(queue(45), [{ name: 'status-a.md', text: `Updated: ${at(2)}\n` }]);
    expect(await cmdFleetHeartbeat([], { reader: r, now: () => NOW })).toBe(1);
    expect(out[0]).toBe('queue/status.json: 45 min old STALE (over 30)');
    expect(out.at(-1)).toBe('Heartbeat: STALE');
  });

  it('--max-age moves the threshold (both forms) and the boundary is inclusive-fresh', async () => {
    const r = reader(queue(30), [{ name: 'status-a.md', text: `${at(40)}\n` }]);
    expect(await cmdFleetHeartbeat(['--max-age', '45'], { reader: r, now: () => NOW })).toBe(0);
    expect(await cmdFleetHeartbeat(['--max-age=35'], { reader: r, now: () => NOW })).toBe(1);
    expect(await cmdFleetHeartbeat([], { reader: reader(queue(30)), now: () => NOW })).toBe(0);
  });

  it('--json is typed and parseable', async () => {
    const r = reader(queue(1), [{ name: 'status-a.md', text: `${at(99)}\n` }]);
    expect(await cmdFleetHeartbeat(['--json', '--max-age', '10'], { reader: r, now: () => NOW })).toBe(1);
    const view = JSON.parse(out.join(''));
    expect(view).toMatchObject({ v: 1, maxAgeMinutes: 10, stale: true, generatedAt: at(0) });
    expect(view.sources).toEqual([
      { source: 'queue/status.json', at: at(1), ageMinutes: 1, stale: false },
      { source: 'supervisor/status-a.md', at: at(99), ageMinutes: 99, stale: true, reason: 'old' },
    ]);
  });

  it('missing queue status and unparseable files are stale, never silently fresh', async () => {
    const v = await readFleetHeartbeat(reader(null, [{ name: 'status-x.md', text: 'no time here\n' }]), NOW, 30);
    expect(v.sources.map(s => [s.reason, s.ageMinutes])).toEqual([['missing', null], ['unparseable', null]]);
    expect(v.stale).toBe(true);
    expect((await readFleetHeartbeat(reader('{not json'), NOW, 30)).sources[0]!.reason).toBe('unparseable');
  });

  it('only the header counts; offsets parse; future times clamp to 0', async () => {
    const late = 'a\n'.repeat(20) + `${at(1)}\n`;
    const v = await readFleetHeartbeat(reader(JSON.stringify({ last_tick: '2026-11-02T13:00:00+02:00' }), [
      { name: 'status-late.md', text: late },
      { name: 'status-future.md', text: `${at(-5)}\n` },
      { name: 'status-space.md', text: 'Time: 2026-11-02 11:50\n' },
    ]), NOW, 30);
    expect(v.sources.map(s => s.ageMinutes)).toEqual([60, 0, null, 10]); // queue, future, late (past header), space
  });

  it('rejects bad usage with exit 2 and --help exits 0', async () => {
    const r = reader(queue(1));
    for (const bad of [['--bogus'], ['x'], ['--max-age'], ['--max-age', 'abc'], ['--max-age', '-1'], ['--json', '--json'], ['--json=1']]) {
      expect(await cmdFleetHeartbeat(bad, { reader: r, now: () => NOW })).toBe(2);
    }
    expect(await cmdFleetHeartbeat(['-h'], { reader: r })).toBe(0);
    expect(out.join('\n')).toContain('Usage: ashlr fleet heartbeat');
  });

  it('default reader reads a temp runs dir (hermetic) and ignores odd names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-'));
    try {
      mkdirSync(join(dir, 'queue')); mkdirSync(join(dir, 'supervisor'));
      writeFileSync(join(dir, 'queue', 'status.json'), queue(3));
      writeFileSync(join(dir, 'supervisor', 'status-main.md'), `${at(4)}\n`);
      writeFileSync(join(dir, 'supervisor', 'notes.md'), 'ignored');
      const v = await readFleetHeartbeat(fsHeartbeatReader(dir), NOW, 30);
      expect(v.sources.map(s => s.source)).toEqual(['queue/status.json', 'supervisor/status-main.md']);
      expect(await cmdFleetHeartbeat([], { runsDir: dir, now: () => NOW })).toBe(0);
      expect(await cmdFleetHeartbeat([], { runsDir: join(dir, 'nope'), now: () => NOW })).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
