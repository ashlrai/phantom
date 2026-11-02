import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cmdFleetBrains,
  fleetBrains,
  FLEET_BRAINS_MAX_TAIL_BYTES,
  readFleetBrains,
} from '../src/cli/fleet-brains.js';

// Fixed local clock: Nov 1 2026 12:00. Fixture stamps sit relative to it.
const NOW = new Date(2026, 10, 1, 12, 0, 0).getTime();
const pad2 = (n: number): string => String(n).padStart(2, '0');
const localStamp = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const ago = (minutes: number, text: string): string => `${localStamp(NOW - minutes * 60_000)} ${text}`;

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const runsDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-brains-'));
  dirs.push(dir);
  await mkdir(join(dir, 'queue'), { recursive: true });
  return dir;
};
const log = (lines: string[]): string => `${lines.join('\n')}\n`;
const row = (report: Awaited<ReturnType<typeof readFleetBrains>>, brain: string) =>
  report.brains.find((b) => b.brain === brain)!;

describe('fleetBrains over dispatch-events rows', () => {
  it('reports every brain fresh when all five acted within 90 minutes', () => {
    const { brains, malformedLines } = fleetBrains(log([
      ago(40, 'LEADER fixups=2 bets=3'),
      ago(30, 'OPUS-LEADER pass ok'),
      ago(20, 'AUTOAUTHOR drafted RQ-1'),
      ago(10, 'ORCH-JOB RQ-2 dispatch from sol'),
      ago(5, 'ORCH-JOB RQ-3 reply from claude'),
      ago(1, 'LAUNCH RQ-4'),
    ]), NOW);
    expect(malformedLines).toBe(0);
    expect(brains.map((b) => b.brain)).toEqual(['executor', 'opus-leader', 'autoauthor', 'sol', 'claude-orchestrator']);
    for (const brain of brains) expect(brain.stale, brain.brain).toBe(false);
    expect(brains.find((b) => b.brain === 'sol')!.ageMinutes).toBe(10);
    expect(Date.parse(brains.find((b) => b.brain === 'executor')!.lastEventAt!)).toBe(NOW - 40 * 60_000);
  });

  it('flags only the brain whose last event is older than 90 minutes', () => {
    const { brains } = fleetBrains(log([
      ago(200, 'ORCH-JOB RQ-9 dispatch from claude'),
      ago(10, 'LEADER fixups=0'),
      ago(5, 'ORCH-JOB RQ-8 dispatch from sol'),
    ]), NOW);
    const claude = brains.find((b) => b.brain === 'claude-orchestrator')!;
    expect(claude).toMatchObject({ stale: true, ageMinutes: 200 });
    expect(brains.find((b) => b.brain === 'executor')!.stale).toBe(false);
    expect(brains.find((b) => b.brain === 'sol')!.stale).toBe(false);
  });

  it('keeps a brain never seen unknown, alongside seen brains', () => {
    const { brains } = fleetBrains(log([
      ago(10, 'LEADER fixups=1'),
      ago(5, 'ORCH-JOB RQ-7 dispatch from sol'),
    ]), NOW);
    for (const name of ['opus-leader', 'autoauthor', 'claude-orchestrator']) {
      expect(brains.find((b) => b.brain === name)).toMatchObject({ lastEventAt: null, ageMinutes: null, stale: true });
    }
  });

  it('attributes only matching senders and the newest row wins', () => {
    const { brains } = fleetBrains(log([
      ago(50, 'ORCH-JOB RQ-1 dispatch from gpt'),
      ago(40, 'LEADER codex rc=1'),
      ago(30, 'LEADER cmp fixups=0'),
      ago(20, 'ORCH-JOB RQ-2 dispatch from solace'),
      ago(10, 'ORCH-JOB RQ-3 dispatch from sol'),
    ]), NOW);
    expect(brains.find((b) => b.brain === 'executor')!.ageMinutes).toBe(30);
    expect(brains.find((b) => b.brain === 'sol')!.ageMinutes).toBe(10);
    expect(brains.find((b) => b.brain === 'claude-orchestrator')!.lastEventAt).toBeNull();
  });

  it('skips malformed lines and rows dated after now', () => {
    const { brains, malformedLines } = fleetBrains(log([
      'garbage line',
      '2026-11-01 partial row',
      '2026-02-30 12:00:00 LEADER impossible',
      ago(-10, 'LEADER fixups=9'),
      ago(15, 'LEADER fixups=1'),
    ]), NOW);
    expect(malformedLines).toBe(2);
    expect(brains.find((b) => b.brain === 'executor')).toMatchObject({ stale: false, ageMinutes: 15 });
  });
});

describe('readFleetBrains', () => {
  it('reports every brain unknown, exit 0, when the log is missing', async () => {
    const dir = await runsDir();
    const report = await readFleetBrains({ runsRoot: dir, now: NOW });
    expect(report.source).toBe('missing');
    expect(report.brains.every((b) => b.lastEventAt === null && b.stale)).toBe(true);
    const print = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetBrains([], { runsRoot: dir, now: NOW })).toBe(0);
    expect(print.mock.calls.at(-1)![0]).toContain('executor: unknown');
    expect(print.mock.calls.at(-1)![0]).toContain('claude-orchestrator: unknown');
  });

  it('reads only the retained tail of an oversized log', async () => {
    const dir = await runsDir();
    const padding = 'x'.repeat(FLEET_BRAINS_MAX_TAIL_BYTES + 10_000);
    await writeFile(join(dir, 'queue', 'dispatch-events.log'),
      `${ago(10, 'AUTOAUTHOR drafted RQ-1')}\n${padding}\n${ago(5, 'LEADER fixups=0')}\n`);
    const report = await readFleetBrains({ runsRoot: dir, now: NOW });
    expect(row(report, 'executor').stale).toBe(false);
    expect(row(report, 'autoauthor')).toMatchObject({ lastEventAt: null, stale: true });
  });

  it('emits the JSON schema and validates flags before reading', async () => {
    const dir = await runsDir();
    await writeFile(join(dir, 'queue', 'dispatch-events.log'), log([ago(3, 'LEADER fixups=0')]));
    const print = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetBrains(['--bogus'], { runsRoot: dir, now: NOW })).toBe(2);
    expect(print).not.toHaveBeenCalled();
    expect(await cmdFleetBrains(['--help'], { runsRoot: dir, now: NOW })).toBe(0);
    expect(await cmdFleetBrains(['--json'], { runsRoot: dir, now: NOW })).toBe(0);
    const parsed = JSON.parse(print.mock.calls.at(-1)![0] as string);
    expect(parsed).toMatchObject({ schema: 'fleet.brains.v1', source: 'healthy', staleMinutes: 90 });
    expect(parsed.brains.find((b: { brain: string }) => b.brain === 'executor')).toMatchObject({ stale: false, ageMinutes: 3 });
  });
});
