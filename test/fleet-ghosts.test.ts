import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fleetGhosts } from '../src/core/fleet/ghosts.js';
import { cmdFleetGhosts } from '../src/cli/fleet-ghosts.js';
import { readCompactBrief, compactBriefLines } from '../src/core/fleet/leader-compact-brief.js';
import { runSelfTick, SELF_TICK_STEP_ORDER, type SelfTickSteps } from '../src/core/fleet/self-tick.js';
const now = Date.now(), hour = 3_600_000, dead = 2_147_483_647;
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ghosts-')); await mkdir(join(dir, 'queue/run'), { recursive: true }); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
async function job(id: string, age: number, pid: number | null = dead, quiet = age) {
  await writeFile(join(dir, `queue/run/${id}.line`), `${id}\tphantom\tcodex-local\twork\tplain`);
  await writeFile(join(dir, `queue/run/${id}.dispatched`), String((now - age * hour) / 1000));
  for (const [suffix, text, hours] of [['launch', pid === null ? 'plain' : `pid ${pid}`, age], ['log', 'working', quiet], ['base', 'plain branch /tmp/plain codex-local', age]] as const) {
    const path = join(dir, `${id}.${suffix}`); await writeFile(path, text); const time = new Date(now - hours * hour); await utimes(path, time, time);
  }
}
const read = (apply = false) => fleetGhosts({ runsDir: dir, now: () => now, apply });
it('classifies dead pids, absent pids, old quiet processes and recent output using metadata', async () => {
  await job('gone', 72); await job('fresh', 72, null, 1 / 60); await job('silent', 3, null);
  await job('slow', 3, process.pid, 1); await job('ancient', 30, process.pid);
  expect(Object.fromEntries((await read()).jobs.map(j => [j.id, j.state]))).toEqual({ gone: 'ghost', fresh: 'live', silent: 'ghost', slow: 'stuck', ancient: 'ghost' });
  expect((await readdir(join(dir, 'queue/run'))).some(n => n.endsWith('.reaping'))).toBe(false);
  expect((await read(true)).marked.sort()).toEqual(['ancient', 'gone', 'silent']);
  expect((await read(true)).marked).toEqual([]);
  expect((await readdir(join(dir, 'queue/run'))).filter(n => n.endsWith('.reaping'))).toHaveLength(3);
  expect((await stat(join(dir, 'queue/run/gone.reaping'))).isDirectory()).toBe(true);
  expect((await readFile(join(dir, 'queue/dispatch-events.log'), 'utf8')).trim().split('\n')).toHaveLength(3);
});
it('includes base-only dispatcher entries and keeps fresh launch output live', async () => {
  await job('orphan', 72); await rm(join(dir, 'queue/run/orphan.line')); await rm(join(dir, 'orphan.launch'));
  await job('launching', 72, null); const fresh = new Date(now - 60_000); await utimes(join(dir, 'launching.launch'), fresh, fresh);
  expect((await read()).jobs).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'orphan', lane: 'codex-local', state: 'ghost' }), expect.objectContaining({ id: 'launching', state: 'live' })]));
});
it('self-tick marks at most ten old ghosts and leaves young ghosts alone', async () => {
  for (let i = 0; i < 12; i++) await job(`old${i}`, 72);
  await job('young', 5);
  const steps = Object.fromEntries(SELF_TICK_STEP_ORDER.map(s => [s, async () => ({ exitCode: 0, output: '{}' })])) as SelfTickSteps;
  expect((await runSelfTick({ runsDir: dir, now: () => now, steps })).report.ghosts?.marked).toEqual([]);
  expect((await runSelfTick({ runsDir: dir, now: () => now, steps, apply: true })).report.ghosts?.marked).toHaveLength(10);
  expect((await runSelfTick({ runsDir: dir, now: () => now, steps, apply: true })).report.ghosts?.marked).toHaveLength(2);
  expect((await readdir(join(dir, 'queue/run'))).filter(n => n.endsWith('.reaping'))).toHaveLength(12);
});
it('prints plain or typed CLI results and per-lane leader counts, with unknown evidence explicit', async () => {
  await job('gone', 72);
  await writeFile(join(dir, 'queue/slots.json'), JSON.stringify({ 'codex-local': { target: 4 } }));
  await writeFile(join(dir, 'queue/status.json'), JSON.stringify({ last_tick: new Date(now).toISOString(), lanes: { 'codex-local': { running: 5, held: false } } }));
  const brief = await readCompactBrief(dir, now); expect(brief.lanes[0]).toMatchObject({ lane: 'codex-local', ghosts: 1 });
  expect(compactBriefLines(brief).join('\n')).toContain('1 ghosts');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetGhosts([], read)).toBe(0); expect(log.mock.calls[0][0]).toMatch(/^gone codex-local age 72h recorded pid is gone$/);
  expect(await cmdFleetGhosts(['--json', '--apply'], read)).toBe(0); expect(JSON.parse(log.mock.calls[1][0])).toMatchObject({ schema: 'fleet.ghosts.v1', marked: ['gone'] });
  expect(await cmdFleetGhosts(['--bad'], read)).toBe(2);
  expect(await fleetGhosts({ runsDir: join(dir, 'missing') })).toMatchObject({ known: false });
});
