import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdFleetKept, FLEET_KEPT_SCHEMA, summarizeFleetKept } from '../src/cli/fleet-kept.js';

afterEach(() => vi.restoreAllMocks());

const row = (job: string, cls: string | undefined, ts: string) => JSON.stringify({ job, ...(cls ? { class: cls } : {}), ts });

describe('summarizeFleetKept', () => {
  it('groups by the newest classed row and lists the 3 oldest ids', () => {
    const ledger = [
      row('a', 'abort_push', '2026-11-04T01:00:00-0500'),
      row('b', 'abort_push', '2026-11-04T02:00:00-0500'),
      row('c', 'abort_push', '2026-11-04T03:00:00-0500'),
      row('d', 'abort_push', '2026-11-04T04:00:00-0500'),
      row('e', 'abort_pr', '2026-11-04T01:00:00-0500'),
      row('e', 'empty', '2026-11-04T05:00:00-0500'),
      row('e', undefined, '2026-11-04T06:00:00-0500'),
      row('f', 'merged_ok', '2026-11-04T01:00:00-0500'),
      row('other-job', 'abort_pr', '2026-11-04T01:00:00-0500'),
      'not json',
    ].join('\n');
    const report = summarizeFleetKept(['d', 'c', 'b', 'a', 'e', 'f', 'g', 'h'], ledger);
    expect(report.reasons).toEqual([
      { reason: 'abort_push', count: 4, oldest: ['a', 'b', 'c'] },
      { reason: 'empty', count: 1, oldest: ['e'] },
      { reason: 'other', count: 1, oldest: ['f'] },
      { reason: 'unknown', count: 2, oldest: ['g', 'h'] },
    ]);
  });

  it('keeps a later row over an earlier one even when the file is out of order', () => {
    const ledger = [row('a', 'abort_pr', '2026-11-04T05:00:00-0500'), row('a', 'abort_push', '2026-11-04T01:00:00-0500')].join('\n');
    expect(summarizeFleetKept(['a'], ledger).reasons[0]?.reason).toBe('abort_pr');
  });

  it('only looks at the last 3000 lines', () => {
    const lines = [row('a', 'abort_push', '2026-11-04T01:00:00-0500'), ...Array.from({ length: 3000 }, () => '{}')];
    expect(summarizeFleetKept(['a'], lines.join('\n')).reasons[0]?.reason).toBe('unknown');
  });
});

describe('cmdFleetKept', () => {
  const statusPath = join(homedir(), '.ashlr-runs', 'queue', 'status.json');
  const jobsPath = join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl');
  const readers = (status: string, jobs: string) => ({
    status: vi.fn(async (_p: string) => status),
    jobs: vi.fn(async (_p: string) => jobs),
  });

  it('prints one plain line per reason and reads only the two files', async () => {
    const r = readers(JSON.stringify({ kept_worktrees: ['a', 'b'], secret: 'x' }), row('a', 'abort_pr', '2026-11-04T01:00:00-0500'));
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetKept([], r.status, r.jobs)).toBe(0);
    expect(r.status).toHaveBeenCalledExactlyOnceWith(statusPath);
    expect(r.jobs).toHaveBeenCalledExactlyOnceWith(jobsPath);
    expect(out.mock.calls.map(c => c[0])).toEqual(['abort_pr 1 a', 'unknown 1 b']);
  });

  it('prints json', async () => {
    const r = readers(JSON.stringify({ kept_worktrees: ['a'] }), '');
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetKept(['--json'], r.status, r.jobs)).toBe(0);
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toEqual({
      schema: FLEET_KEPT_SCHEMA, readOnly: true, kept: 1, reasons: [{ reason: 'unknown', count: 1, oldest: ['a'] }],
    });
  });

  it('says so when nothing is kept', async () => {
    const r = readers('{"kept_worktrees":[]}', '');
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetKept([], r.status, r.jobs)).toBe(0);
    expect(out).toHaveBeenCalledWith('No kept worktrees.');
  });

  it.each([['bad json', 'nope'], ['missing list', '{}'], ['unsafe id', '{"kept_worktrees":["../x"]}']])('fails closed on %s', async (_n, status) => {
    const r = readers(status, '');
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetKept(['--json'], r.status, r.jobs)).toBe(2);
    expect(JSON.parse(String(out.mock.calls[0]?.[0])).error).toBeTruthy();
  });

  it('fails when the ledger is unreadable', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetKept([], async () => '{"kept_worktrees":[]}', async () => { throw new Error('boom'); })).toBe(2);
  });

  it('prints usage for help and rejects other args', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdFleetKept(['--help'])).toBe(0);
    expect(out).toHaveBeenCalled();
    expect(await cmdFleetKept(['--bogus'])).toBe(2);
    expect(err).toHaveBeenCalled();
  });

  it('is registered', () => {
    expect(FLEET_SUBCOMMAND_LOADERS.kept).toBeTypeOf('function');
  });
});
