import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdJobsGaps } from '../src/cli/jobs-gaps.js';
import { AGENT_COMMANDS } from '../src/cli/help.js';
import type { LaneFacts } from '../src/core/fleet/autofill-lanes.js';
import { readJobGaps, type JobGapsDeps } from '../src/core/fleet/job-gaps.js';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const titles = ['Wire amber readings in test/amber.ts', 'Cover cobalt locks in test/cobalt.ts',
  'Print velvet sizes in test/velvet.ts', 'Sort meadow beacons in test/meadow.ts', 'Rename quartz docks in test/quartz.ts'];
const lane = (over: Partial<LaneFacts> = {}): LaneFacts => ({ lane: 'claude', target: 8, running: 1, queued: 1, held: false, remainingPct: 80, ...over });
let root: string;
let deps: JobGapsDeps;
beforeEach(async () => {
  vi.stubEnv('ASHLR_GAPS_MAX', '');
  root = await mkdtemp(join(tmpdir(), 'gap-capacity-749s-'));
  await mkdir(join(root, 'metrics'), { recursive: true });
  await mkdir(join(root, 'wt', 'JOBAMBER'), { recursive: true });
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), JSON.stringify({ event: 'outcome', job: 'JOBAMBER', lane: 'claude', empty: true, repo: 'phantom', ts: new Date(NOW - 7200000).toISOString() }) + '\n');
  await writeFile(join(root, 'wt', 'JOBAMBER', 'BRIDGE_NOTES.md'), `## Gaps\n${titles.map(t => `- ${t}`).join('\n')}\n`);
  deps = { runsDir: root, wtDir: join(root, 'wt'), now: NOW, propose: true,
    openIdeas: async () => [], queuedWork: async () => [], mergedTitles: async () => [], masterHasTarget: async () => false };
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const files = () => readdir(join(root, 'leader', 'drop', 'claude')).catch(() => [] as string[]);

describe('capacity defaults preserved with master policy', () => {
  it.each(['', 'invalid', '-1', '41', '1.5'])('uses measured room above three for environment %j, while retaining the hourly guard', async env => {
    vi.stubEnv('ASHLR_GAPS_MAX', env);
    const report = await readJobGaps(24, { ...deps, lanes: [lane()] });
    expect(report.proposalLimit).toBe(40);
    expect(report.candidates).toHaveLength(5);
    expect(report.proposed!.filter(p => p.queued)).toHaveLength(3);
    expect(report.proposed!.filter(p => !p.queued).map(p => p.skipped)).toEqual(Array(2).fill('held: already 3 new gap jobs in the last hour'));
    expect(await files()).toHaveLength(3);
    const next = await readJobGaps(24, { ...deps, lanes: [lane()], now: NOW + 3600001 });
    expect(next.proposed!.filter(p => p.queued)).toHaveLength(2);
    expect(await files()).toHaveLength(5);
  });

  it('passes explicit CLI zero through to the real proposer ahead of the environment', async () => {
    vi.stubEnv('ASHLR_GAPS_MAX', '4');
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await cmdJobsGaps(['--propose', '--max', '0', '--json'],
      (hours, propose, maxNew) => readJobGaps(hours, { ...deps, propose, maxNew, lanes: [lane()] }));
    expect(result).toBe(0);
    const report = JSON.parse(String(out.mock.calls[0]![0]));
    expect(report.proposalLimit).toBe(0);
    expect(report.proposed.every((p: { queued: boolean; skipped: string }) => !p.queued && p.skipped === 'already 0 new jobs this tick')).toBe(true);
    expect(await files()).toEqual([]);
  });

  it.each(['', 'invalid'])('keeps the conservative fallback without readings (%j)', async env => {
    vi.stubEnv('ASHLR_GAPS_MAX', env);
    const report = await readJobGaps(24, deps);
    expect(report.proposalLimit).toBe(3);
    expect(report.proposed!.filter(p => p.queued)).toHaveLength(3);
    expect(await files()).toHaveLength(3);
  });

  it('does not treat pace alone as measured capacity', async () => {
    const pace = new Map([['claude', { pool: 'claude', state: 'unknown' as const, usedPct: null, hoursToReset: null, emptyAt: null, evenPacePerHour: null, recentPerHour: null, resetAt: null }]]);
    expect((await readJobGaps(24, { ...deps, pace })).proposalLimit).toBe(3);
  });

  it('consumes capacity only after a successful write', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('fixture failure')).mockResolvedValue(undefined);
    const report = await readJobGaps(24, { ...deps, lanes: [lane({ target: 3 })], write });
    expect(write).toHaveBeenCalledTimes(2);
    expect(report.proposed!.filter(p => p.queued)).toHaveLength(1);
    expect(report.proposed!.filter(p => p.skipped === 'could not write the job')).toHaveLength(1);
    expect(report.proposed!.filter(p => p.skipped === 'no lane has free slots and usage left')).toHaveLength(3);
  });

  it('holds on an existing proposer lock and unreadable hourly history', async () => {
    const lock = join(root, 'metrics', 'gap-propose.lock');
    await writeFile(lock, 'fixture');
    const locked = await readJobGaps(24, { ...deps, lanes: [lane()] });
    expect(locked.proposed!.every(p => p.skipped === 'hourly count unavailable; held')).toBe(true);
    await rm(lock);
    await mkdir(join(root, 'metrics', 'gap-proposed.jsonl'));
    const unreadable = await readJobGaps(24, { ...deps, lanes: [lane()] });
    expect(unreadable.proposed!.every(p => p.skipped === 'hourly count unavailable; held')).toBe(true);
    expect(await files()).toEqual([]);
  });

  it('describes the per-call ceiling and independent rolling-hour guard in both CLI help surfaces', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdJobsGaps(['--help'])).toBe(0);
    const registry = AGENT_COMMANDS.find(c => c.usage.startsWith('phm jobs gaps '))!;
    for (const text of [String(out.mock.calls[0]![0]), registry.description]) {
      expect(text).toContain('up to 40');
      expect(text).toContain('3 without lane readings');
      expect(text).toMatch(/3 new gap jobs per rolling hour/);
      expect(text).toContain('--max N overrides ASHLR_GAPS_MAX, including zero');
    }
  });
});
