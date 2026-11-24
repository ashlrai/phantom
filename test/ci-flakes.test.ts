import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  enqueueFlakeFixes,
  flakeJobId,
  JOURNAL_TEST_MAX,
  MAX_FLAKE_FIX_ROWS,
  recurringFlakes,
  RECURRING_FLAKE_WINDOW_MS,
  type FlakeJournalRow,
  type RecurringFlake,
} from '../src/core/fleet/ci-flakes.js';

const NOW = Date.parse('2026-01-08T12:00:00Z');
const HEADS = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)];
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

function attempt(overrides: Partial<FlakeJournalRow> = {}): FlakeJournalRow {
  return { at: '2026-01-08T11:00:00Z', repo: 'org/repo', head: HEADS[0]!, outcome: 'attempt', test: 'test/a.test.ts > suite > flaky case', ...overrides };
}
function verdict(overrides: Partial<FlakeJournalRow> = {}): FlakeJournalRow {
  return { at: '2026-01-08T11:30:00Z', repo: 'org/repo', head: HEADS[0]!, outcome: 'verdict', test: 'test/a.test.ts > suite > flaky case', verdict: 'pass', ...overrides };
}
function flake(overrides: Partial<RecurringFlake> = {}): RecurringFlake {
  return { repo: 'org/repo', test: 'test/a.test.ts > suite > flaky case', heads: HEADS.slice(0, 3), attempts: 3, verdicts: { pass: 0, fail: 0, inconclusive: 0 }, ...overrides };
}

describe('recurringFlakes', () => {
  it('reports a test that flaked on enough distinct heads inside the window', () => {
    const rows = [
      attempt({ head: HEADS[0] }),
      attempt({ head: HEADS[1], at: '2026-01-07T11:00:00Z' }),
      attempt({ head: HEADS[2], at: '2026-01-06T11:00:00Z' }),
      attempt({ head: HEADS[2], at: '2026-01-05T11:00:00Z' }),
    ];
    const result = recurringFlakes(rows, { nowMs: NOW });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ repo: 'org/repo', attempts: 4 });
    expect(result[0]!.heads).toEqual([HEADS[0], HEADS[1], HEADS[2]]);
  });

  it('stays below the threshold on a pair of heads and on repeated same-head attempts', () => {
    const rows = [
      attempt({ head: HEADS[0] }),
      attempt({ head: HEADS[0], at: '2026-01-07T11:00:00Z' }),
      attempt({ head: HEADS[1] }),
    ];
    expect(recurringFlakes(rows, { nowMs: NOW })).toEqual([]);
  });

  it('ignores ok/failed outcome rows, rows without a test id and malformed repos', () => {
    const rows = [
      attempt({ head: HEADS[0] }),
      attempt({ head: HEADS[1], outcome: 'ok' }),
      attempt({ head: HEADS[2], outcome: 'failed' }),
      attempt({ head: HEADS[3], test: '' }),
      attempt({ head: HEADS[3], test: null }),
      attempt({ head: HEADS[3], repo: 'not-a-repo' }),
      attempt({ head: HEADS[3], repo: '' }),
    ];
    expect(recurringFlakes(rows, { nowMs: NOW })).toEqual([]);
  });

  it('ages attempts out of the window so a fixed flake stops recurring', () => {
    const fresh = attempt({ head: HEADS[0] });
    const stale = [
      attempt({ head: HEADS[1], at: new Date(NOW - RECURRING_FLAKE_WINDOW_MS - 1).toISOString() }),
      attempt({ head: HEADS[2], at: new Date(NOW - RECURRING_FLAKE_WINDOW_MS - 60_000).toISOString() }),
    ];
    expect(recurringFlakes([fresh, ...stale], { nowMs: NOW })).toEqual([]);
    const boundary = attempt({ head: HEADS[1], at: new Date(NOW - RECURRING_FLAKE_WINDOW_MS).toISOString() });
    expect(recurringFlakes([fresh, boundary, ...stale.slice(0, 1)], { nowMs: NOW })).toHaveLength(0);
    const third = attempt({ head: HEADS[2], at: '2026-01-08T10:00:00Z' });
    expect(recurringFlakes([fresh, boundary, third], { nowMs: NOW })).toHaveLength(1);
  });

  it('honors custom window and threshold bounds', () => {
    const rows = [attempt({ head: HEADS[0] }), attempt({ head: HEADS[1] }), attempt({ head: HEADS[2] })];
    expect(recurringFlakes(rows, { nowMs: NOW, minHeads: 4 })).toEqual([]);
    expect(recurringFlakes(rows, { nowMs: NOW, windowMs: 60_000 })).toEqual([]);
    expect(() => recurringFlakes(rows, { nowMs: NaN })).toThrow(RangeError);
    expect(() => recurringFlakes(rows, { windowMs: 0 })).toThrow(RangeError);
    expect(() => recurringFlakes(rows, { minHeads: 0 })).toThrow(RangeError);
  });

  it('tallies rerun verdict rows per repo and test inside the window', () => {
    const rows = [
      ...[HEADS[0]!, HEADS[1]!, HEADS[2]!].map((head, i) => attempt({ head, at: `2026-01-0${5 + i}T00:00:00Z` })),
      verdict({ verdict: 'pass' }),
      verdict({ verdict: 'pass', at: '2026-01-07T11:30:00Z' }),
      verdict({ verdict: 'fail', head: HEADS[1]! }),
      verdict({ verdict: 'inconclusive', repo: 'org/other' }),
      verdict({ verdict: 'inconclusive', test: 'test/other.test.ts > x' }),
      verdict({ verdict: 'bogus' }),
      verdict({ verdict: 'pass', at: new Date(NOW - RECURRING_FLAKE_WINDOW_MS - 1).toISOString() }),
    ];
    const result = recurringFlakes(rows, { nowMs: NOW });
    expect(result).toHaveLength(1);
    expect(result[0]!.verdicts).toEqual({ pass: 2, fail: 1, inconclusive: 0 });
  });

  it('reports zero verdict tallies when no verdict rows exist', () => {
    const rows = [HEADS[0]!, HEADS[1]!, HEADS[2]!].map(head => attempt({ head }));
    expect(recurringFlakes(rows, { nowMs: NOW })[0]!.verdicts).toEqual({ pass: 0, fail: 0, inconclusive: 0 });
  });

  it('sorts strongest recurrence first and separates repos and tests', () => {
    const rows = [
      ...[HEADS[0]!, HEADS[1]!, HEADS[2]!].map((head, i) => attempt({ repo: 'org/other', test: 'test/b.test.ts > b', head, at: `2026-01-0${5 + i}T00:00:00Z` })),
      ...[HEADS[0]!, HEADS[1]!, HEADS[2]!, HEADS[3]!].map((head, i) => attempt({ head, at: `2026-01-0${5 + i}T00:00:00Z` })),
    ];
    const result = recurringFlakes(rows, { nowMs: NOW });
    expect(result.map(r => [r.repo, r.test, r.heads.length])).toEqual([
      ['org/repo', 'test/a.test.ts > suite > flaky case', 4],
      ['org/other', 'test/b.test.ts > b', 3],
    ]);
  });
});

describe('enqueueFlakeFixes', () => {
  it('appends a deduplicated READY stabilization row and reports queued ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flakes-')); dirs.push(dir);
    const queue = join(dir, 'queue.md');
    writeFileSync(queue, '- READY RQ-OTHER-1 (P1, repo=repo, tier=work, needs=git|gh|node): unrelated\n');
    const queued = enqueueFlakeFixes([flake()], queue);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toBe(flakeJobId('org/repo', 'test/a.test.ts > suite > flaky case'));
    const text = readFileSync(queue, 'utf8');
    expect(text).toContain(`- READY ${queued[0]} (P1, repo=repo, tier=work, needs=git|gh|node): `);
    expect(text).toContain('Stabilize flaky test test/a.test.ts > suite > flaky case in org/repo');
    expect(text).toContain('3 distinct heads');
    expect(text).toContain(queued[0]!);
    expect(enqueueFlakeFixes([flake()], queue)).toEqual([]);
  });

  it('re-queues a still-recurring flake as the next generation after DONE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flakes-')); dirs.push(dir);
    const queue = join(dir, 'queue.md');
    const base = flakeJobId('org/repo', 'test/a.test.ts > suite > flaky case');
    writeFileSync(queue, `- DONE ${base} (P1, repo=repo, tier=work, needs=git|gh|node): earlier stabilization\n`);
    const queued = enqueueFlakeFixes([flake()], queue);
    expect(queued).toEqual([`${base}-G2`]);
    const text = readFileSync(queue, 'utf8');
    expect(text).toContain(`- READY ${base}-G2 (P1, repo=repo, tier=work, needs=git|gh|node): `);
    expect(text).toContain('stabilization attempt 2');
    expect(text).toContain(`${base}-G2`);
    expect(enqueueFlakeFixes([flake()], queue)).toEqual([]);
  });

  it('keeps dropped and in-flight flake rows suppressed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flakes-')); dirs.push(dir);
    const queue = join(dir, 'queue.md');
    const base = flakeJobId('org/repo', 'test/a.test.ts > suite > flaky case');
    writeFileSync(queue, `- DROPPED ${base} (P1, repo=repo, tier=work, needs=git|gh|node): abandoned\n`);
    expect(enqueueFlakeFixes([flake()], queue)).toEqual([]);
    writeFileSync(queue, `- CLAIMED ${base} (P1, repo=repo, tier=work, needs=git|gh|node): in flight\n`);
    expect(enqueueFlakeFixes([flake()], queue)).toEqual([]);
    expect(readFileSync(queue, 'utf8')).not.toContain('-G2');
  });

  it('includes recorded rerun verdicts in the stabilization brief', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flakes-')); dirs.push(dir);
    const queue = join(dir, 'queue.md');
    enqueueFlakeFixes([flake({ verdicts: { pass: 2, fail: 1, inconclusive: 0 } })], queue);
    const text = readFileSync(queue, 'utf8');
    expect(text).toContain('Recorded rerun verdicts for this test: 2 passed, 1 failed, 0 inconclusive.');
    enqueueFlakeFixes([flake({ test: 'test/b.test.ts > b' })], queue);
    const lines = readFileSync(queue, 'utf8').split('\n').filter(l => l.includes('test/b.test.ts'));
    expect(lines[0]).not.toContain('Recorded rerun verdicts');
  });

  it('keeps the brief on one line and caps new rows per call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flakes-')); dirs.push(dir);
    const queue = join(dir, 'queue.md');
    const flakes = Array.from({ length: MAX_FLAKE_FIX_ROWS + 2 }, (_, i) =>
      flake({ test: `test/f${i}.test.ts > case ${i}`, heads: HEADS.slice(0, 3) }));
    const queued = enqueueFlakeFixes(flakes, queue);
    expect(queued).toHaveLength(MAX_FLAKE_FIX_ROWS);
    const lines = readFileSync(queue, 'utf8').split('\n').filter(l => l.includes('RQ-CIFLAKE-'));
    expect(lines).toHaveLength(MAX_FLAKE_FIX_ROWS);
    for (const line of lines) expect(line).not.toContain('\n');
  });

  it('refuses a relative queue path', () => {
    expect(() => enqueueFlakeFixes([flake()], 'queue.md')).toThrow('queue-file must be absolute');
  });

  it('truncates stored test ids deterministically for grouping', () => {
    const long = `test/${'x'.repeat(JOURNAL_TEST_MAX + 50)}.test.ts > case`;
    const rows = [0, 1, 2].map(i => attempt({ head: HEADS[i]!, test: long }));
    expect(recurringFlakes(rows, { nowMs: NOW })[0]!.test).toBe(long);
    expect(flakeJobId('org/repo', long)).toMatch(/^RQ-CIFLAKE-[0-9A-F]{16}$/);
  });
});
