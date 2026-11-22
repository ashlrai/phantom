import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetAdmission } from '../src/cli/fleet-admission.js';

const now = new Date(2026, 10, 21, 12).getTime();
const tick = (time: string, launches: number) => `2026-11-21 ${time} tick run={"work":1} q=1 launched=${launches} reap=0 pause=False wall=2s`;
const status = (closed = false) => JSON.stringify({ admission: { cap: 10, running: 1, load1: 1, admit: !closed }, lanes: { work: { running: 1, target: 8, effective_target: 2, queued: 5, held: false } } });

it('projects measured pace and effective targets in JSON and text without changing verdicts', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  let closed = false;
  const reader = async (path: string) => {
    if (path.endsWith('status.json')) return status(closed);
    if (path.endsWith('dispatchd.log')) return [tick('11:30:00', 2), tick('12:00:00', 0)].join('\n');
    throw new Error('missing');
  };
  try {
    expect(await cmdFleetAdmission(['--json'], reader, now)).toBe(0);
    const report = JSON.parse(String(output.mock.calls.at(-1)![0]));
    expect(report.admission).toMatchObject({ startsPerHour: 4, ticksWithLaunch: 1, windowSeconds: 1800, perLane: [{ target: 2, running: 1, gap: 1 }] });
    expect(report.admission.unknown.settleSeconds).toContain('missing');
    expect(await cmdFleetAdmission([], reader, now)).toBe(0);
    expect(String(output.mock.calls.at(-1)![0])).toContain('4 starts/hour over 1800 seconds');
    closed = true;
    expect(await cmdFleetAdmission(['--json'], reader, now)).toBe(1);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0])).status).toBe('red');
    expect(await cmdFleetAdmission(['--bad'], reader, now)).toBe(2);
    expect(await cmdFleetAdmission(['--json'], async () => { throw new Error(); }, now)).toBe(2);
  } finally { output.mockRestore(); }
});

it('requests a bounded dispatcher tail through the injected tail reader', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const tail = vi.fn(async () => null);
  const previousHome = process.env.HOME;
  const tempHome = await mkdtemp(join(tmpdir(), 'admission-pace-'));
  process.env.HOME = tempHome;
  try {
    // Missing status still exercises the concurrent optional log read.
    expect(await cmdFleetAdmission(['--json'], undefined, now, tail)).toBe(2);
    expect(tail).toHaveBeenCalledWith(expect.stringMatching(/dispatchd\.log$/), 256 * 1024);
  } finally { process.env.HOME = previousHome; await rm(tempHome, { recursive: true, force: true }); output.mockRestore(); }
});
