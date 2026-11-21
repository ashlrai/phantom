import { describe, expect, it } from 'vitest';
import { buildLoopStages, loopStagesText, minutesText, parseSince, STAGE_NAMES } from '../src/core/metrics/loop-stages.js';
import { cmdMetricsLoop } from '../src/cli/metrics-loop.js';
import type { LoopReaders } from '../src/core/metrics/loop-collect.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const min = (m: number) => new Date(now - 10 * 3_600_000 + m * 60_000).toISOString();
const url = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
const row = (job: string, event: string, m: number, extra: object = {}) => JSON.stringify({ event, job, ts: min(m), ...extra });
const merged = (job: string, m: number, n: number) => row(job, 'outcome', m, { state: 'MERGED', url: url(n) });
/** A complete job: queued 0, launched 40, finished 50, PR 52, merged 55. */
const complete = (job: string, n: number, shift = 0) => [row(job, 'enqueue', shift), row(job, 'launch', shift + 40), row(job, 'finish', shift + 50), row(job, 'publish', shift + 52, { url: url(n) }), merged(job, shift + 55, n)];
const stage = (r: ReturnType<typeof buildLoopStages>, name: (typeof STAGE_NAMES)[number]) => r.stages.find(s => s.stage === name)!;
const releaseAt = (m: number) => ({ tag: `v${m}`, createdAt: Date.parse(min(m)) });

describe('buildLoopStages', () => {
  it('times every stage of a complete job, including the first release after the merge', () => {
    const r = buildLoopStages(complete('RQ-ONE', 1).join('\n'), [releaseAt(30), releaseAt(100), releaseAt(200)], now);
    expect(r.schema).toBe('metrics.loop-stages.v1');
    expect(r.jobs).toBe(1);
    expect(STAGE_NAMES.map(n => stage(r, n).p50_minutes)).toEqual([40, 10, 2, 3, 45]);
    expect(r.slowest).toEqual({ stage: 'merged_to_released', p50_minutes: 45 });
    expect(r.headline).toBe('Biggest wait: merged to released, p50 45 min');
    expect(r.releases).toBe('ok');
  });

  it('keeps a job with no release yet as pending, not unknown and not zero', () => {
    const r = buildLoopStages(complete('RQ-ONE', 1).join('\n'), [releaseAt(30)], now);
    expect(stage(r, 'merged_to_released')).toMatchObject({ known: 0, unknown: 0, pending: 1, p50_minutes: null });
    expect(r.slowest!.stage).toBe('queued_to_launched');
    expect(buildLoopStages(complete('RQ-ONE', 1).join('\n'), null, now).releases).toBe('unavailable');
    expect(stage(buildLoopStages(complete('RQ-ONE', 1).join('\n'), null, now), 'merged_to_released').unknown).toBe(1);
  });

  it('treats a merge older than every fetched release as unknown, because an earlier release may hold it', () => {
    expect(stage(buildLoopStages(complete('RQ-ONE', 1).join('\n'), [releaseAt(300)], now), 'merged_to_released').unknown).toBe(1);
  });

  it('counts a missing launch time as unknown for both stages that need it, never zero', () => {
    const lines = complete('RQ-ONE', 1).filter(l => !l.includes('"launch"'));
    const r = buildLoopStages(lines.join('\n'), null, now);
    expect(stage(r, 'queued_to_launched')).toMatchObject({ known: 0, unknown: 1, p50_minutes: null, p90_minutes: null });
    expect(stage(r, 'launched_to_finished')).toMatchObject({ known: 0, unknown: 1 });
    expect(stage(r, 'finished_to_pr').known).toBe(1);
    expect(loopStagesText(r).join('\n')).toContain('queued to launched: p50 unknown, p90 unknown (0 known, 1 unknown)');
  });

  it('computes p50 and p90 by linear interpolation over the known jobs', () => {
    const lines = [0, 1, 2, 3, 4].flatMap((i) => [row(`RQ-J${i}`, 'enqueue', 0), row(`RQ-J${i}`, 'launch', [10, 20, 30, 40, 100][i]!), row(`RQ-J${i}`, 'finish', 120)]);
    const r = buildLoopStages(lines.join('\n'), null, now);
    expect(stage(r, 'queued_to_launched')).toMatchObject({ known: 5, p50_minutes: 30, p90_minutes: 76 });
  });

  it('ignores jobs that have not finished and jobs outside the window; out-of-order stamps are unknown', () => {
    const open = [row('RQ-OPEN', 'enqueue', 0), row('RQ-OPEN', 'launch', 5)];
    const old = [row('RQ-OLD', 'enqueue', -3000), row('RQ-OLD', 'launch', -2990), row('RQ-OLD', 'finish', -2980)];
    const skew = [row('RQ-SKEW', 'enqueue', 60), row('RQ-SKEW', 'launch', 10), row('RQ-SKEW', 'finish', 70)];
    const r = buildLoopStages([...open, ...old, ...skew].join('\n'), null, now);
    expect(r.jobs).toBe(1);
    expect(stage(r, 'queued_to_launched')).toMatchObject({ known: 0, unknown: 1 });
  });

  it('says why the biggest wait is unknown', () => {
    expect(buildLoopStages(null, null, now).headline).toBe('Biggest wait: unknown (job ledger unreadable)');
    expect(buildLoopStages('', null, now).headline).toBe('Biggest wait: unknown (no job finished in this window)');
    expect(buildLoopStages(row('RQ-A', 'finish', 5), null, now).headline).toBe('Biggest wait: unknown (no job has two timestamps for any stage)');
  });

  it('flags a jobs tail cut at the read cap and says so in the text lines', () => {
    const ledger = complete('RQ-ONE', 1).join('\n');
    const cut = buildLoopStages(ledger, null, now, undefined, null, true);
    expect(cut.jobs_truncated).toBe(true);
    expect(loopStagesText(cut).join('\n')).toContain('tail was cut');
    expect(buildLoopStages(ledger, null, now, undefined, null, false).jobs_truncated).toBe(false);
    expect(buildLoopStages(ledger, null, now).jobs_truncated).toBeNull();
  });

  it('writes the slowest-stage sentence in minutes, seconds or hours', () => {
    expect(minutesText(41)).toBe('41 min');
    expect(minutesText(0.5)).toBe('30 s');
    expect(minutesText(150)).toBe('2.5 h');
    const slow = [row('RQ-S', 'enqueue', 0), row('RQ-S', 'launch', 41), row('RQ-S', 'finish', 42)].join('\n');
    expect(buildLoopStages(slow, null, now).headline).toBe('Biggest wait: queued to launched, p50 41 min');
  });
});

describe('parseSince', () => {
  it('takes minutes, hours and days up to 30 days', () => {
    expect([parseSince(undefined), parseSince('90m'), parseSince('24h'), parseSince('7d'), parseSince('30d')]).toEqual([86_400_000, 5_400_000, 86_400_000, 604_800_000, 2_592_000_000]);
    expect([parseSince('31d'), parseSince('0h'), parseSince('x'), parseSince('')]).toEqual([null, null, null, null]);
  });
});

describe('phm metrics loop --since --json', () => {
  const readers = (ledger: string): LoopReaders => ({
    runsDir: '/nowhere', now: () => now,
    readText: async (path: string) => path.endsWith('jobs.jsonl') ? { text: ledger, truncated: false } : null,
    gh: async (args: string[]) => args[0] === 'api' ? JSON.stringify([{ tag_name: 'v0', created_at: min(-100) }, { tag_name: 'v1', created_at: min(100) }]) : null,
    installed: async () => null, nodes: () => null, peerTasks: async () => null, ncpu: () => 4,
  } as unknown as LoopReaders);
  const run = async (args: string[], ledger = complete('RQ-ONE', 1).join('\n')) => {
    const out: string[] = [], err: string[] = [];
    const code = await cmdMetricsLoop(args, { out: l => out.push(l), err: l => err.push(l), readers: readers(ledger) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('prints the stages with a schema id in JSON', async () => {
    const r = await run(['--dry-run', '--json', '--since', '24h']);
    expect(r.code).toBe(0);
    const stages = JSON.parse(r.out).stages;
    expect(stages.schema).toBe('metrics.loop-stages.v1');
    expect(stages.headline).toBe('Biggest wait: merged to released, p50 45 min');
  });

  it('leads the plain output with the biggest wait and rejects a bad window', async () => {
    expect((await run(['--dry-run'])).out.split('\n')[0]).toContain('Biggest wait: merged to released, p50 45 min');
    const bad = await run(['--dry-run', '--since', '99y']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('--since 24h');
  });
});
