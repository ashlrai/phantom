import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobProducers, queueProducers, unknownJobProducers } from '../src/core/fleet/job-producers.js';
import { cmdJobs } from '../src/cli/jobs-empty.js';
import { cmdJobsProducers } from '../src/cli/jobs-producers.js';

const now = Date.parse('2026-11-19T12:00:00Z');
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const launch = (job: string, minutesAgo: number, extra: Record<string, unknown> = {}) => JSON.stringify({ event: 'launch', job, repo: 'phantom', ts: at(minutesAgo), ...extra });

const queueText = [
  '- READY RQ-LEAD-ONE (P1, pool=devin, tier=work, repo=phantom, src=leader): task',
  '- CLAIMED RQ-BETS-ONE (P1, pool=claude, src=bets): task',
  '- READY RQ-DESK-ONE (P2, pool=claude, src=desk-loop): task',
  '- READY RQ-NOTAG-ONE (P2, pool=claude): task',
  '- READY RQ-BAD-ONE (P2, src=bad/value): task',
].join('\n');
const ledger = [
  launch('RQ-LEAD-ONE', 10), launch('RQ-LEAD-ONE', 70), launch('RQ-LEAD-TWO-GHOST', 30),
  launch('RQ-BETS-ONE', 130), launch('RQ-DESK-ONE', 359), launch('RQ-DESK-ONE', 20),
  launch('RQ-NOTAG-ONE', 45), launch('RQ-NOBODY', 50),
  launch('RQ-FIELD', 55, { src: 'manual' }),
  launch('RQ-LEAD-ONE', 361), // outside six hours
  launch('RQ-LEAD-ONE', -5), // future
  JSON.stringify({ event: 'finish', job: 'RQ-LEAD-ONE', ts: at(5) }),
  'not json', '[]',
];

describe('jobs producers', () => {
  it('parses producers from queue lines and ignores unsafe tags', () => {
    const map = queueProducers(queueText);
    expect(Object.fromEntries(map)).toEqual({ 'RQ-LEAD-ONE': 'leader', 'RQ-BETS-ONE': 'bets', 'RQ-DESK-ONE': 'desk-loop' });
  });

  it('counts starts per producer and hour with unknown attribution last', () => {
    const report = jobProducers(ledger, queueProducers(queueText), now);
    expect(report).toMatchObject({ schema: 'jobs.producers.v1', version: 1, window_hours: 6, known: true, queue_known: true, starts: 9 });
    expect(report.hourly).toEqual([6, 1, 1, 0, 0, 1]);
    expect(report.producers.map(p => [p.producer, p.starts, p.jobs])).toEqual([
      ['desk-loop', 2, 1], ['leader', 2, 1], ['bets', 1, 1], ['manual', 1, 1], ['unknown', 3, 3]]);
    expect(report.producers.find(p => p.producer === 'leader')!.hourly).toEqual([1, 1, 0, 0, 0, 0]);
    expect(report.producers.find(p => p.producer === 'desk-loop')!.hourly).toEqual([1, 0, 0, 0, 0, 1]);
    expect(report.producers.find(p => p.producer === 'bets')!.hourly).toEqual([0, 0, 1, 0, 0, 0]);
    expect(report.hourly.reduce((a, b) => a + b, 0)).toBe(report.starts);
    expect(report.summary).toBe('9 job starts in the last 6 hours from 4 producers; 3 unattributed');
  });

  it('marks everything unknown when the queue is unreadable', () => {
    const report = jobProducers([launch('RQ-LEAD-ONE', 10)], null, now);
    expect(report.queue_known).toBe(false);
    expect(report.producers).toEqual([{ producer: 'unknown', starts: 1, jobs: 1, hourly: [1, 0, 0, 0, 0, 0] }]);
  });

  it('reports an empty window plainly and an unreadable ledger as unknown', () => {
    expect(jobProducers([], new Map(), now).summary).toBe('No job starts in the last 6 hours');
    expect(unknownJobProducers()).toMatchObject({ known: false, starts: 0, producers: [] });
    expect(() => jobProducers([], null, now, 0)).toThrow(RangeError);
  });
});

describe('phm jobs producers CLI', () => {
  let dir: string, out: string[], err: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jobs-producers-'));
    out = []; err = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(String(s)); });
    vi.spyOn(console, 'error').mockImplementation((s: string) => { err.push(String(s)); });
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  const files = () => {
    writeFileSync(join(dir, 'jobs.jsonl'), ledger.join('\n'));
    writeFileSync(join(dir, 'queue.md'), queueText);
    return ['--metrics', join(dir, 'jobs.jsonl'), '--queue', join(dir, 'queue.md')];
  };
  const run = (args: string[]) => cmdJobsProducers(args, undefined, now);

  it('prints typed JSON for three producers plus unknown', async () => {
    expect(await run([...files(), '--json'])).toBe(0);
    const json = JSON.parse(out[0]!);
    expect(json.schema).toBe('jobs.producers.v1');
    expect(json.producers.map((p: { producer: string }) => p.producer)).toEqual(['desk-loop', 'leader', 'bets', 'manual', 'unknown']);
  });

  it('prints plain lines and honors --since', async () => {
    expect(await run([...files()])).toBe(0);
    expect(out.join('\n')).toContain('leader: 2 starts');
    out.length = 0;
    expect(await run([...files(), '--since', '1h', '--json'])).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ window_hours: 1, hourly: [6] });
  });

  it('exits 1 on unreadable metrics, 2 on bad usage, 0 on help', async () => {
    expect(await run(['--metrics', join(dir, 'missing.jsonl'), '--queue', join(dir, 'q.md')])).toBe(1);
    expect(err.join('')).toContain('unknown');
    expect(await run(['--since', 'soon'])).toBe(2);
    expect(await run(['--bogus'])).toBe(2);
    expect(await run(['--help'])).toBe(0);
  });

  it('missing queue still reports starts, all unknown', async () => {
    writeFileSync(join(dir, 'jobs.jsonl'), ledger.join('\n'));
    expect(await run(['--metrics', join(dir, 'jobs.jsonl'), '--queue', join(dir, 'none.md'), '--json'])).toBe(0);
    const json = JSON.parse(out[0]!);
    expect(json.queue_known).toBe(false);
    expect(json.producers.map((p: { producer: string }) => p.producer)).toEqual(['manual', 'unknown']);
  });

  it('is reachable as phm jobs producers', async () => {
    expect(await cmdJobs(['producers', '--help'])).toBe(0);
    expect(out.join('\n')).toContain('Usage: phm jobs producers');
  });
});
