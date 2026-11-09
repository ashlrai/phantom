import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRouteMoves, routeMoves } from '../src/cli/fleet-route-moves.js';

const stamp = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};
const now = new Date(2026, 5, 1, 12).getTime();
const row = (time: number, body: string) => `${stamp(new Date(time))} ${body}`;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('fleet route moves', () => {
  it('counts moves and refusals within the window and orders the latest ten moves', () => {
    const lines = Array.from({ length: 12 }, (_, i) => row(now - i * 1000, `ROUTE job${i} a -> b (tier mid)`));
    lines.push(row(now - 6 * 3600000, 'ROUTE_REFUSED no a -> c (tier fast not accepted)'),
      row(now - 6 * 3600000 - 1000, 'ROUTE old a -> b (tier mid)'),
      row(now + 1000, 'ROUTE future a -> b (tier mid)'),
      row(now, 'ROUTE broken a -> b (tier mid not accepted)'));
    const report = routeMoves(lines.join('\n'), 6, now);
    expect(report.moves).toBe(12); expect(report.refused).toBe(1);
    expect(report.pairs).toEqual([{ from: 'a', to: 'b', moves: 12, refused: 0 }, { from: 'a', to: 'c', moves: 0, refused: 1 }]);
    expect(report.tiers).toEqual([{ tier: 'fast', moves: 0, refused: 1 }, { tier: 'mid', moves: 12, refused: 0 }]);
    expect(report.latest.map(e => e.id)).toEqual(Array.from({ length: 10 }, (_, i) => `job${i}`));
    expect(routeMoves(lines.join('\n'), 0.001, now).moves).toBe(4);
  });
  it('reads the overridden root, supports JSON and validates arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'route-moves-'));
    try {
      vi.stubEnv('ASHLR_RUNS_DIR', root);
      await writeFile(join(root, 'dispatch-events.log'), row(Date.now() - 1000, 'ROUTE job a -> b (tier work)'));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await cmdFleetRouteMoves(['--hours', '1', '--json'])).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]![0])).moves).toBe(1);
      expect(await cmdFleetRouteMoves([])).toBe(0);
      expect(String(log.mock.calls[1]![0])).toContain('a -> b: 1, 0');
      expect(await cmdFleetRouteMoves(['--hours', '0'])).toBe(2);
      expect(await cmdFleetRouteMoves(['--json', '--json'])).toBe(2);
      await rm(join(root, 'dispatch-events.log'));
      expect(await cmdFleetRouteMoves([])).toBe(1);
      expect(error).toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
