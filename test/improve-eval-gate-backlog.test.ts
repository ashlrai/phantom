import { mkdtempSync, mkdirSync, rmSync, appendFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EVAL_GATE_MIN_ADVERSE,
  EVAL_GATE_MIN_DAYS,
  EVAL_GATE_UNRESOLVED_GRACE_MS,
  EVAL_GATE_WINDOW_MS,
  evalGateBacklogItems,
  evalGateCells,
  foldEvalGateRows,
  parseEvalGateRows,
} from '../src/core/improve/eval-gate-backlog.js';
import { validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Fixed evaluation instant for the injected-text tests; the fold never reads the wall clock. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** One journal line in the writer's record() shape; valid unless a field breaks the contract. */
function line(spec: {
  atMs?: number;
  candidateId?: string;
  kind?: string;
  status?: string;
  reason?: string;
  pairs?: number;
  raw?: string;
} = {}): string {
  if (spec.raw !== undefined) return spec.raw;
  const pairs = spec.pairs ?? 2;
  return JSON.stringify({
    at: iso(spec.atMs ?? NOW_MS - DAY),
    candidateId: spec.candidateId ?? 'cand-1',
    kind: spec.kind ?? 'prior',
    status: spec.status ?? 'rejected',
    reason: spec.reason ?? 'evaluation-failed',
    pairs: Array.from({ length: pairs }, (_, i) => ({ taskId: `task-${i}`, baseline: 0.5, candidate: 0.6 })),
  });
}

const journal = (...lines: string[]): string => `${lines.join('\n')}\n`;

/** n rejected rows of one reason spread across `days` distinct UTC days ending NOW_MS. */
function rejectedSeries(reason: string, days: number, perDay: number, kind = 'prior'): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(line({
        atMs: NOW_MS - d * DAY - i * HOUR,
        candidateId: `cand-${reason}-${d}-${i}`,
        kind,
        status: 'rejected',
        reason,
      }));
    }
  }
  return rows;
}

/** n 'evaluated' checkpoints with no terminal row, older than the in-flight grace. */
function unresolvedSeries(days: number, perDay: number): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(line({
        atMs: NOW_MS - d * DAY - i * HOUR - EVAL_GATE_UNRESOLVED_GRACE_MS - HOUR,
        candidateId: `cand-open-${d}-${i}`,
        kind: 'playbook',
        status: 'evaluated',
        reason: 'no-regression',
        pairs: 3,
      }));
    }
  }
  return rows;
}

const parse = (text: string) => parseEvalGateRows(text);
const fold = (text: string) => {
  const { rows, malformed } = parse(text);
  const result = foldEvalGateRows(rows, NOW_MS, EVAL_GATE_WINDOW_MS);
  result.malformed = malformed;
  return result;
};

describe('parseEvalGateRows', () => {
  it('parses contract rows and counts every malformed line', () => {
    const { rows, malformed } = parse(journal(
      line({ candidateId: 'ok-1', status: 'promoted', reason: 'no-regression', pairs: 4 }),
      '{not json',
      '42',
      '"text"',
      '[1,2]',
      '{}',
      line({ candidateId: '' }),
      line({ candidateId: 'x'.repeat(201) }),
      line({ kind: 'bogus' }),
      line({ status: 'bogus' }),
      line({ reason: 'bogus' }),
      line({ atMs: Number.NaN, raw: JSON.stringify({ at: 'not-a-date', candidateId: 'c', kind: 'prior', status: 'rejected', reason: 'regression', pairs: [] }) }),
      JSON.stringify({ at: iso(NOW_MS - DAY), candidateId: 'c', kind: 'prior', status: 'rejected', reason: 'regression', pairs: 'nope' }),
      JSON.stringify({ at: iso(NOW_MS - DAY), candidateId: 'c', kind: 'prior', status: 'rejected', reason: 'regression', pairs: [{ taskId: 't', baseline: 'x', candidate: 1 }] }),
      JSON.stringify({ at: iso(NOW_MS - DAY), candidateId: 'c', kind: 'prior', status: 'rejected', reason: 'regression', pairs: [{ taskId: 'x'.repeat(201), baseline: 0, candidate: 1 }] }),
      '',
      '   ',
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ candidateId: 'ok-1', status: 'promoted', reason: 'no-regression', pairs: 4 });
    expect(malformed).toBe(14);
  });
});

describe('foldEvalGateRows', () => {
  it('windows rows on `at` and tallies context statuses', () => {
    const result = fold(journal(
      line({ atMs: NOW_MS - 8 * DAY, candidateId: 'old', reason: 'apply-failed' }),
      line({ atMs: NOW_MS + EVAL_GATE_WINDOW_MS, candidateId: 'future', reason: 'apply-failed' }),
      line({ atMs: NOW_MS - 2 * DAY, candidateId: 'p1', status: 'promoted', reason: 'no-regression' }),
      line({ atMs: NOW_MS - DAY, candidateId: 'r1', status: 'rejected', reason: 'regression' }),
      line({ atMs: NOW_MS - HOUR, candidateId: 'e1', status: 'evaluated', reason: 'no-regression' }),
      line({ atMs: NOW_MS - 3 * HOUR, candidateId: 'a1', status: 'rejected', reason: 'apply-failed' }),
    ));
    expect(result.rows).toBe(4);
    expect(result.promoted).toBe(1);
    expect(result.rejected).toBe(2);
    expect(result.regression).toBe(1);
    expect(result.evaluated).toBe(1);
    expect(result.buckets.apply.rows).toBe(1);
    expect(result.buckets.scorer.rows).toBe(0);
  });

  it('buckets rejected rows by failure locus and keeps regression as context', () => {
    const result = fold(journal(
      ...rejectedSeries('evaluation-failed', 1, 2),
      ...rejectedSeries('apply-failed', 1, 1),
      ...rejectedSeries('stale-baseline', 1, 1),
      ...rejectedSeries('missing-data', 1, 1),
      ...rejectedSeries('invalid-data', 1, 1),
      ...rejectedSeries('regression', 1, 1),
    ));
    expect(result.buckets.scorer.rows).toBe(2);
    expect(result.buckets.apply.rows).toBe(2);
    expect(result.buckets.input.rows).toBe(2);
    expect(result.buckets.unresolved.rows).toBe(0);
    expect(result.regression).toBe(1);
    expect(result.buckets.scorer.kinds.get('prior')).toBe(2);
  });

  it('marks evaluated checkpoints unresolved only without a later terminal row', () => {
    const result = fold(journal(
      // Resolved: evaluated then rejected for the same candidate.
      line({ atMs: NOW_MS - 2 * DAY, candidateId: 'done-1', status: 'evaluated', reason: 'no-regression' }),
      line({ atMs: NOW_MS - DAY, candidateId: 'done-1', status: 'rejected', reason: 'apply-failed' }),
      // Resolved by a later promotion of the same candidate.
      line({ atMs: NOW_MS - 2 * DAY, candidateId: 'done-2', status: 'evaluated', reason: 'no-regression' }),
      line({ atMs: NOW_MS - DAY, candidateId: 'done-2', status: 'promoted', reason: 'no-regression' }),
      // Unresolved: crashed before the terminal record, past the grace.
      line({ atMs: NOW_MS - 2 * DAY - EVAL_GATE_UNRESOLVED_GRACE_MS, candidateId: 'open-1', status: 'evaluated', reason: 'no-regression' }),
      // In-flight: inside the grace, never counts.
      line({ atMs: NOW_MS - 30 * 60 * 1000, candidateId: 'open-2', status: 'evaluated', reason: 'no-regression' }),
      // Out-of-window: unresolved state is old news.
      line({ atMs: NOW_MS - 8 * DAY - EVAL_GATE_UNRESOLVED_GRACE_MS, candidateId: 'open-3', status: 'evaluated', reason: 'no-regression' }),
    ));
    expect(result.buckets.unresolved.rows).toBe(1);
    expect(result.buckets.unresolved.ids).toEqual(['open-1']);
    expect(result.evaluated).toBe(4);
  });

  it('counts each crashed attempt: two unresolved checkpoints for one candidate stay two rows', () => {
    const result = fold(journal(
      line({ atMs: NOW_MS - 3 * DAY - EVAL_GATE_UNRESOLVED_GRACE_MS, candidateId: 'retry', status: 'evaluated', reason: 'no-regression' }),
      line({ atMs: NOW_MS - 2 * DAY - EVAL_GATE_UNRESOLVED_GRACE_MS, candidateId: 'retry', status: 'evaluated', reason: 'no-regression' }),
    ));
    expect(result.buckets.unresolved.rows).toBe(2);
    expect(result.buckets.unresolved.days.size).toBe(2);
  });
});

describe('evalGateCells', () => {
  it('emits only at the recurring bars: enough adverse rows across enough distinct days', () => {
    const underCount = fold(journal(...rejectedSeries('apply-failed', EVAL_GATE_MIN_DAYS, 1)));
    expect(evalGateCells(underCount)).toEqual([]);
    const underDays = fold(journal(...rejectedSeries('apply-failed', 1, EVAL_GATE_MIN_ADVERSE * 2)));
    expect(evalGateCells(underDays)).toEqual([]);

    const across = fold(journal(
      ...rejectedSeries('apply-failed', EVAL_GATE_MIN_DAYS, Math.ceil(EVAL_GATE_MIN_ADVERSE / EVAL_GATE_MIN_DAYS)).slice(0, EVAL_GATE_MIN_ADVERSE),
    ));
    const cells = evalGateCells(across);
    expect(cells).toHaveLength(1);
    expect(cells[0]?.bucket).toBe('apply');
    expect(cells[0]?.rows).toBe(EVAL_GATE_MIN_ADVERSE);
    expect(cells[0]?.days).toHaveLength(EVAL_GATE_MIN_DAYS);
    expect(cells[0]?.firstSeen).not.toBeNull();
    expect(cells[0]?.lastSeen).not.toBeNull();
  });

  it('orders cells scorer, apply, input, unresolved and keeps sub-bar buckets out', () => {
    const result = fold(journal(
      ...unresolvedSeries(EVAL_GATE_MIN_DAYS, Math.ceil(EVAL_GATE_MIN_ADVERSE / EVAL_GATE_MIN_DAYS)).slice(0, EVAL_GATE_MIN_ADVERSE),
      ...rejectedSeries('missing-data', EVAL_GATE_MIN_DAYS, Math.ceil(EVAL_GATE_MIN_ADVERSE / EVAL_GATE_MIN_DAYS)).slice(0, EVAL_GATE_MIN_ADVERSE),
      ...rejectedSeries('stale-baseline', EVAL_GATE_MIN_DAYS, Math.ceil(EVAL_GATE_MIN_ADVERSE / EVAL_GATE_MIN_DAYS)).slice(0, EVAL_GATE_MIN_ADVERSE),
      ...rejectedSeries('evaluation-failed', EVAL_GATE_MIN_DAYS, Math.ceil(EVAL_GATE_MIN_ADVERSE / EVAL_GATE_MIN_DAYS)).slice(0, EVAL_GATE_MIN_ADVERSE),
    ));
    const cells = evalGateCells(result);
    expect(cells.map((c) => c.bucket)).toEqual(['scorer', 'apply', 'input', 'unresolved']);
  });
});

describe('evalGateBacklogItems', () => {
  it('emits nothing for another repository, a missing journal, or a read failure', async () => {
    const text = journal(...rejectedSeries('apply-failed', EVAL_GATE_MIN_DAYS, EVAL_GATE_MIN_ADVERSE));
    expect(await evalGateBacklogItems({ repo: 'ashlrai/other-repo', now: NOW_MS, evalGateText: text })).toEqual([]);
    expect(await evalGateBacklogItems({ repo: 'not-a-repo', now: NOW_MS, evalGateText: text })).toEqual([]);
    expect(await evalGateBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, evalGateText: null })).toEqual([]);
    expect(await evalGateBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, evalGateText: '' })).toEqual([]);
    expect(await evalGateBacklogItems({
      repo: 'ashlrai/phantom', now: NOW_MS,
      evalGatePath: path.join(tmpdir(), 'definitely-missing-eval-gate.jsonl'),
    })).toEqual([]);
  });

  it('emits one stable item per recurring bucket with recorded detail', async () => {
    const items = await evalGateBacklogItems({
      repo: 'ashlrai/phantom', now: NOW_MS,
      evalGateText: journal(...rejectedSeries('evaluation-failed', EVAL_GATE_MIN_DAYS, EVAL_GATE_MIN_ADVERSE, 'prompt')),
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.repo).toBe('ashlrai/phantom');
    expect(item.area).toBe('eval-gate');
    expect(item.priority).toBe(3);
    expect(item.id).toMatch(/^eval-gate-scorer-[0-9a-f]{16}$/);
    expect(item.prompt).toContain('evaluation-failed');
    expect(item.prompt).toContain('eval-gate.jsonl');
    expect(item.prompt).toContain('promoteWithEval');
    expect(item.prompt).toContain('7-day window');
    expect(item.prompt).toMatch(/UTC day\(s\) \(/);
    expect(item.prompt).toContain(`'prompt'`);
    const again = await evalGateBacklogItems({
      repo: 'ashlrai/phantom', now: NOW_MS,
      evalGateText: journal(...rejectedSeries('evaluation-failed', EVAL_GATE_MIN_DAYS, EVAL_GATE_MIN_ADVERSE, 'prompt')),
    });
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it('emits all four bucket items at the bars and respects the limit', async () => {
    const perBucket = Math.ceil(EVAL_GATE_MIN_ADVERSE / EVAL_GATE_MIN_DAYS);
    const text = journal(
      ...rejectedSeries('evaluation-failed', EVAL_GATE_MIN_DAYS, perBucket).slice(0, EVAL_GATE_MIN_ADVERSE),
      ...rejectedSeries('apply-failed', EVAL_GATE_MIN_DAYS, perBucket).slice(0, EVAL_GATE_MIN_ADVERSE),
      ...rejectedSeries('missing-data', EVAL_GATE_MIN_DAYS, perBucket).slice(0, EVAL_GATE_MIN_ADVERSE),
      ...unresolvedSeries(EVAL_GATE_MIN_DAYS, perBucket).slice(0, EVAL_GATE_MIN_ADVERSE),
    );
    const items = await evalGateBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, evalGateText: text });
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.id)).toEqual([
      expect.stringMatching(/^eval-gate-scorer-/),
      expect.stringMatching(/^eval-gate-apply-/),
      expect.stringMatching(/^eval-gate-input-/),
      expect.stringMatching(/^eval-gate-unresolved-/),
    ]);
    const limited = await evalGateBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, limit: 2, evalGateText: text });
    expect(limited).toHaveLength(2);
  });

  it('emits nothing below the recurring bars', async () => {
    const text = journal(
      ...rejectedSeries('apply-failed', 1, EVAL_GATE_MIN_ADVERSE * 2),
      line({ atMs: NOW_MS - HOUR, candidateId: 'open', status: 'evaluated', reason: 'no-regression' }),
    );
    expect(await evalGateBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, evalGateText: text })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: real journal file through learnDir()'s homedir resolution
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ashlr-eval-gate-backlog-')));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

function learnDir(): string {
  const dir = path.join(tmpHome, '.ashlr', 'learn');
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('evalGateBacklogItems end-to-end', () => {
  it('folds a real journal file: recurring apply failures become one item, resolved ones do not', async () => {
    const now = Date.now();
    const at = (msAgo: number) => iso(now - msAgo);
    const row = (msAgo: number, candidateId: string, status: string, reason: string) => JSON.stringify({
      at: at(msAgo),
      candidateId,
      kind: 'prior',
      status,
      reason,
      pairs: [{ taskId: 't-1', baseline: 0.5, candidate: 0.6 }],
    });
    appendFileSync(path.join(learnDir(), 'eval-gate.jsonl'), [
      // Three apply-failed rejections across two UTC days.
      row(3 * DAY + 2 * HOUR, 'a-1', 'rejected', 'apply-failed'),
      row(2 * DAY + 2 * HOUR, 'a-2', 'rejected', 'apply-failed'),
      row(DAY + 2 * HOUR, 'a-3', 'rejected', 'apply-failed'),
      // A promoted decision and a regression rejection — context, never cells.
      row(2 * DAY, 'p-1', 'promoted', 'no-regression'),
      row(DAY, 'r-1', 'rejected', 'regression'),
      // An evaluated checkpoint closed by a later rejection — resolved.
      row(3 * DAY, 'e-1', 'evaluated', 'no-regression'),
      row(DAY + HOUR, 'e-1', 'rejected', 'stale-baseline'),
    ].join('\n') + '\n', 'utf8');

    const items = await evalGateBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toMatch(/^eval-gate-apply-/);
    expect(items[0]?.prompt).toContain(`'apply-failed'`);
    expect(validBacklogItem(items[0])).not.toBeNull();
  });

  it('emits nothing when the learn directory is absent', async () => {
    const items = await evalGateBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toEqual([]);
  });
});
