import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findLostLaunches, LOST_LAUNCHES_SCHEMA, readLostLaunches, requeueHint } from '../src/core/fleet/lost-launches.js';
import { readSupplyDoctor, supplyDoctorLines } from '../src/core/fleet/supply-doctor.js';
import { cmdJobsLost } from '../src/cli/jobs-lost.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const row = (event: string, job: string, min: number, extra: Record<string, unknown> = {}) => JSON.stringify({ event, job, lane: 'claude', repo: 'phantom', ts: ago(min), ...extra });

describe('findLostLaunches', () => {
  it('launch + finish is not lost; launch + publish is not lost', () => {
    expect(findLostLaunches([row('launch', 'A', 90), row('finish', 'A', 60), row('launch', 'B', 90), row('publish', 'B', 50)], undefined, NOW).lost).toEqual([]);
  });
  it('launch only, 40 min old is lost; 10 min old is not', () => {
    const { lost } = findLostLaunches([row('launch', 'OLD', 40), row('launch', 'NEW', 10)], undefined, NOW);
    expect(lost).toEqual([{ job: 'OLD', lane: 'claude', repo: 'phantom', launched_at: ago(40), reason: 'launched, never finished' }]);
  });
  it('a finish from before a relaunch does not hide the new launch', () => {
    expect(findLostLaunches([row('launch', 'A', 200), row('finish', 'A', 190), row('launch', 'A', 60)], undefined, NOW).lost.map(l => l.job)).toEqual(['A']);
  });
  it('an .launch file starting with error: is lost at any age, with the ref-lock reason', () => {
    const heads = { E: "error: cannot lock ref 'refs/remotes/origin/master': is at abc but expected def" };
    const { lost } = findLostLaunches([row('launch', 'E', 2)], heads, NOW);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBe('launch failed: git ref lock race');
    expect(findLostLaunches([], new Map([['X', 'error: disk full']]), NOW).lost[0]!.reason).toBe('launch failed: disk full');
    expect(findLostLaunches([row('launch', 'OK', 90)], { OK: 'started pid 4' }, NOW).lost[0]!.reason).toBe('launched, never finished');
  });
  it('skips malformed lines and counts them', () => {
    const r = findLostLaunches(['{nope', '[]', '{"event":"launch"}', '', row('launch', 'A', 45)], undefined, NOW);
    expect(r.lost.map(l => l.job)).toEqual(['A']);
    expect(r.skipped).toBe(3);
  });
  it('honours the window and sorts newest first', () => {
    const r = findLostLaunches([row('launch', 'A', 100), row('launch', 'B', 50), row('launch', 'OLD', 3000)], undefined, NOW, 24);
    expect(r.lost.map(l => l.job)).toEqual(['B', 'A']);
  });
  it('reads the jobs-ledger dialect: job_id/jobId/id, type/kind events, pool lanes and alternate timestamps', () => {
    const lines = [
      JSON.stringify({ type: 'launch', job_id: 'A', pool: 'claude', repo: 'phantom', time: ago(45) }),
      JSON.stringify({ kind: 'finish', id: 'A', recordedAt: ago(40) }),
      JSON.stringify({ type: 'launch', jobId: 'B', lane: 'work', updatedAt: ago(45) }),
      JSON.stringify({ event: 'launch', job: 'C', ts: ago(45), closedAt: ago(44) }),
    ];
    const { lost, skipped } = findLostLaunches(lines, undefined, NOW);
    expect(skipped).toBe(0);
    expect(lost.map(l => l.job)).toEqual(['B', 'C']);
    expect(lost.find(l => l.job === 'B')).toMatchObject({ lane: 'work', repo: null, launched_at: ago(45) });
  });
  it('requeueHint is a tab row and never claims unknown fields', () => {
    expect(requeueHint({ job: 'A', lane: 'claude', repo: 'phantom', launched_at: null, reason: 'x' })).toBe('A\tphantom\tclaude');
    expect(requeueHint({ job: 'A', lane: null, repo: null, launched_at: null, reason: 'x' })).toBe('A\t<repo>\t<lane>');
  });
});

describe('readers and commands', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'lost-')); await mkdir(join(root, 'metrics'), { recursive: true }); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
  const seed = async () => {
    await writeFile(join(root, 'metrics', 'jobs.jsonl'), [row('launch', 'RQ-LOCK', 20), row('launch', 'RQ-GONE', 60), row('launch', 'RQ-DONE', 60), row('finish', 'RQ-DONE', 30), 'garbage'].join('\n') + '\n');
    await writeFile(join(root, 'RQ-LOCK.launch'), "error: cannot lock ref 'refs/remotes/origin/master'\n");
    await writeFile(join(root, '..bad.launch'), 'error: ignored\n');
    await utimes(join(root, 'RQ-LOCK.launch'), new Date(NOW - 1000), new Date(NOW - 1000));
  };

  it('reads files into a jobs.lost.v1 report; unreadable ledger is unknown', async () => {
    await seed();
    const r = await readLostLaunches(24, { runsDir: root, now: () => NOW });
    expect(r).toMatchObject({ schema: LOST_LAUNCHES_SCHEMA, known: true, count: 2, skipped_lines: 1 });
    expect(r.lost.map(l => l.job)).toEqual(['RQ-LOCK', 'RQ-GONE']);
    expect((await readLostLaunches(24, { runsDir: join(root, 'nope'), now: () => NOW })).known).toBe(false);
  });

  it('phm jobs lost prints words, json, hints, and rejects bad usage', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => { out.push(m); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await seed();
    const read = (h: number) => readLostLaunches(h, { runsDir: root, now: () => NOW });
    expect(await cmdJobsLost(['--requeue-hint'], read)).toBe(0);
    expect(out.join('\n')).toMatch(/2 lost launches[\s\S]*RQ-GONE[\s\S]*never finished[\s\S]*RQ-GONE\tphantom\tclaude/);
    out.length = 0;
    expect(await cmdJobsLost(['--json', '--since', '0.5h'], read)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ schema: 'jobs.lost.v1', count: 1 });
    expect(await cmdJobsLost(['--since', 'soon'], read)).toBe(2);
    expect(await cmdJobsLost(['extra'], read)).toBe(2);
    expect(await cmdJobsLost([], async h => ({ ...(await read(h)), known: false }))).toBe(1);
  });

  it('phm doctor supply reports lost_launches and mentions them in the verdict', async () => {
    await seed();
    const noop = { now: () => NOW, runsDir: root, readOff: async () => false, readCandidates: async () => null };
    const report = await readSupplyDoctor(noop);
    expect(report.lost_launches).toMatchObject({ state: 'known', count: 2 });
    expect(report.verdict).toContain('2 jobs lost at launch in 24 h');
    expect(supplyDoctorLines(report).join('\n')).toContain('RQ-GONE (claude): launched, never finished');
    const clean = await readSupplyDoctor({ ...noop, readLost: async () => [] });
    expect(clean.verdict).not.toContain('lost at launch');
    expect(clean.lost_launches).toEqual({ state: 'known', count: 0, newest: [] });
    const many = await readSupplyDoctor({ ...noop, readLost: async () => Array.from({ length: 7 }, (_, i) => ({ job: `J${i}`, lane: null, repo: null, launched_at: null, reason: 'r' })) });
    expect(many.lost_launches).toMatchObject({ count: 7 });
    expect((many.lost_launches as { newest: unknown[] }).newest).toHaveLength(5);
  });
});
