import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetTaskCheck, taskBatch, taskCheck } from '../src/cli/fleet-task-check.js';

const now = Date.parse('2026-11-02T12:00:00Z');
const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();
const row = (job: string, event: string, h = 1, extra = {}) => JSON.stringify({ job, event, ts: hoursAgo(h), ...extra });
const reader = (lines: string[]) => async () => lines.join('\n');

afterEach(() => vi.restoreAllMocks());

describe('taskBatch', () => {
  it('removes only the trailing number', () => {
    expect(taskBatch('RQ-PHX-FOO03')).toBe('RQ-PHX-FOO');
    expect(taskBatch('RQ-FILLERCHECKQ8')).toBe('RQ-FILLERCHECKQ');
    expect(taskBatch('RQ-A1-B')).toBe('RQ-A1-B');
    expect(taskBatch('123')).toBe('123');
  });
});

describe('taskCheck', () => {
  it('flags a batch with 3 skips in 24h and reports both counts', async () => {
    const r = await taskCheck('RQ-X-FILL04', reader([
      row('RQ-X-FILL01', 'skipped_empty'), row('RQ-X-FILL02', 'skipped_empty', 5), row('RQ-X-FILL03', 'precheck_skip', 23),
    ]), now);
    expect(r).toMatchObject({ known: true, likely_empty: true, skipped_empty: 2, precheck_skip: 1, batch: 'RQ-X-FILL', job: 'RQ-X-FILL04' });
  });

  it('stays false under 3, and ignores other batches, old, future and malformed rows', async () => {
    const r = await taskCheck('RQ-X-FILL04', reader([
      row('RQ-X-FILL01', 'skipped_empty'), row('RQ-X-FILL02', 'precheck_skip'),
      row('RQ-X-OTHER01', 'skipped_empty'), row('RQ-X-FILL05', 'skipped_empty', 25),
      row('RQ-X-FILL06', 'skipped_empty', -1), row('RQ-X-FILL07', 'finish'),
      'not json', '[]', JSON.stringify({ job: 'RQ-X-FILL08', event: 'skipped_empty' }),
    ]), now);
    expect(r).toMatchObject({ known: true, likely_empty: false, skipped_empty: 1, precheck_skip: 1 });
  });

  it('reads the outcome field too', async () => {
    const r = await taskCheck('RQ-X-FILL09', reader([1, 2, 3].map(n => row(`RQ-X-FILL0${n}`, 'finish', 1, { outcome: 'skipped_empty' }))), now);
    expect(r.likely_empty).toBe(true);
  });

  it('returns known:false when the file is unread or the reader throws', async () => {
    for (const read of [async () => null, async () => { throw new Error('boom'); }]) {
      expect(await taskCheck('RQ-X-FILL04', read, now)).toMatchObject({ known: false, likely_empty: false, skipped_empty: 0, precheck_skip: 0 });
    }
  });

  it('treats an empty file as known with zero counts', async () => {
    expect(await taskCheck('RQ-X-FILL04', async () => '', now)).toMatchObject({ known: true, likely_empty: false });
  });
});

describe('cmdFleetTaskCheck', () => {
  const capture = () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    return { out, err };
  };

  it('prints JSON', async () => {
    const { out } = capture();
    const code = await cmdFleetTaskCheck(['RQ-X-FILL04', '--json'], reader([row('RQ-X-FILL01', 'skipped_empty')]), now);
    expect(code).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ schema: 'fleet.task-check.v1', likely_empty: false, skipped_empty: 1 });
  });

  it('prints plain words without --json', async () => {
    const { out } = capture();
    await cmdFleetTaskCheck(['RQ-X-FILL04'], async () => null, now);
    expect(out[0]).toBe('RQ-X-FILL04: unknown (metrics unreadable)');
  });

  it('rejects bad arguments with exit 2 and prints help with 0', async () => {
    const { err } = capture();
    for (const args of [[], ['a', 'b'], ['--json'], ['../x'], ['x', '--json', '--json'], ['x', '--bogus']]) {
      expect(await cmdFleetTaskCheck(args, async () => null, now)).toBe(2);
    }
    expect(err).toHaveBeenCalled();
    expect(await cmdFleetTaskCheck(['--help'])).toBe(0);
  });
});
