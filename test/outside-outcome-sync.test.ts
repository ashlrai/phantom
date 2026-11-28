/** Inert fixtures only. No provider calls, native profiles or credentials. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OutsidePrOutcomeV1, OutsidePrOutcomesV1 } from '../src/core/fleet/outside-pr-outcomes.js';
import {
  OUTSIDE_PR_OUTCOME_JOURNAL_NAME,
  OUTSIDE_PR_OUTCOME_SCHEMA,
  OUTSIDE_PR_SCAN_SCHEMA,
  outsidePrOutcomeJournalPath,
  parseOutsidePrOutcomeJournal,
} from '../src/core/fleet/outside-pr-outcome-ledger.js';
import { syncOutsidePrOutcomes } from '../src/core/fleet/outside-outcome-sync.js';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const AT = NOW.toISOString();

const pr = (number: number, reverted: OutsidePrOutcomeV1['reverted'], over: Partial<OutsidePrOutcomeV1> = {}): OutsidePrOutcomeV1 => ({
  repo: 'acme/widgets', number, title: `outside fix ${number}`,
  author: 'ext-dev', head: 'fix/x', mergedAt: '2026-11-15T00:00:00.000Z',
  createdAt: null, reviews: null, ci: null, diff: null, agent: null, model: null, reverted, ...over,
});

const outcomes = (prs: OutsidePrOutcomeV1[], over: Partial<OutsidePrOutcomesV1> = {}): OutsidePrOutcomesV1 => ({
  v: 1, generatedAt: AT, sourceState: 'healthy', windowDays: 30,
  since: '2026-10-21T12:00:00.000Z', revertLedger: 'read',
  repos: [{ repo: 'acme/widgets', state: 'healthy', listed: prs.length, hitLimit: false, prs }],
  authors: [], agents: [], ...over,
});

const JOURNAL = join('metrics', OUTSIDE_PR_OUTCOME_JOURNAL_NAME);
const readJournal = (runsDir: string): Record<string, unknown>[] =>
  readFileSync(join(runsDir, JOURNAL), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe('syncOutsidePrOutcomes', () => {
  let directory: string;
  let runsDir: string;

  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'outside-outcome-sync-')));
    runsDir = join(directory, 'runs');
    mkdirSync(runsDir, { recursive: true });
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('journals outcome rows plus one scan receipt on the first pass, then only the receipt', async () => {
    const list = async () => outcomes([pr(7, 'yes'), pr(8, 'no'), pr(9, 'unknown')]);
    const first = await syncOutsidePrOutcomes({ runsDir, list, now: () => NOW });
    expect(first).toMatchObject({
      state: 'missing', sourceState: 'healthy', appended: 3, scanAppended: true, seen: 3, truncated: false,
    });
    expect(first.journalPath).toBe(outsidePrOutcomeJournalPath(runsDir));

    const rows = readJournal(runsDir);
    expect(rows).toHaveLength(4);
    const outcomeRows = rows.filter((r) => r['kind'] === OUTSIDE_PR_OUTCOME_SCHEMA);
    const scanRows = rows.filter((r) => r['kind'] === OUTSIDE_PR_SCAN_SCHEMA);
    expect(outcomeRows).toHaveLength(3);
    expect(scanRows).toHaveLength(1);
    expect(outcomeRows.map((r) => r['number'])).toEqual([7, 8, 9]);
    for (const row of outcomeRows) {
      expect(row).toMatchObject({
        v: 1, at: AT, repo: 'acme/widgets', agent: null, model: null,
        mergedAt: '2026-11-15T00:00:00.000Z', createdAt: null, reviews: null, diff: null,
      });
    }
    expect(outcomeRows.find((r) => r['number'] === 7)).toMatchObject({ reverted: 'yes', author: 'ext-dev' });
    // Convention-attributed agent rides the row; unattributed stays null, model always null.
    const attributed = await syncOutsidePrOutcomes({
      runsDir: join(directory, 'runs-attributed'), now: () => NOW,
      list: async () => outcomes([pr(30, 'yes', { agent: 'devin' }), pr(31, 'no')]),
    });
    expect(attributed.appended).toBe(2);
    const attributedRows = readJournal(join(directory, 'runs-attributed'))
      .filter((r) => r['kind'] === OUTSIDE_PR_OUTCOME_SCHEMA);
    expect(attributedRows.find((r) => r['number'] === 30)).toMatchObject({ agent: 'devin', model: null });
    expect(attributedRows.find((r) => r['number'] === 31)).toMatchObject({ agent: null, model: null });
    expect(scanRows[0]).toMatchObject({
      v: 1, at: AT, sourceState: 'healthy', windowDays: 30, revertLedger: 'read',
      repos: [{ repo: 'acme/widgets', state: 'healthy', listed: 3, hitLimit: false, prs: 3 }],
    });

    const second = await syncOutsidePrOutcomes({ runsDir, list, now: () => NOW });
    expect(second).toMatchObject({ state: 'read', appended: 0, scanAppended: true, seen: 3 });
    expect(readJournal(runsDir)).toHaveLength(5);
  });

  it('appends a new outcome row only when a PR is new or its recorded evidence changes', async () => {
    const first = await syncOutsidePrOutcomes({
      runsDir, now: () => NOW,
      list: async () => outcomes([pr(7, 'no'), pr(8, 'yes')]),
    });
    expect(first.appended).toBe(2);

    const second = await syncOutsidePrOutcomes({
      runsDir, now: () => NOW,
      list: async () => outcomes([pr(7, 'yes'), pr(8, 'yes'), pr(9, 'no')]),
    });
    // #7 flipped no->yes and #9 is new; #8 is unchanged.
    expect(second.appended).toBe(2);
    const rows = readJournal(runsDir);
    const sevens = rows.filter((r) => r['kind'] === OUTSIDE_PR_OUTCOME_SCHEMA && r['number'] === 7);
    expect(sevens.map((r) => r['reverted'])).toEqual(['no', 'yes']);
    const parsed = parseOutsidePrOutcomeJournal(readFileSync(join(runsDir, JOURNAL), 'utf8'));
    expect(parsed.verdicts.get('acme/widgets#7')).toBe('yes');
    expect(parsed.verdicts.get('acme/widgets#9')).toBe('no');
    expect(parsed.outcomes).toHaveLength(3);
  });

  it('re-journals a PR when its verdict is unchanged but open/review evidence changed', async () => {
    const evidence = { createdAt: '2026-11-14T00:00:00.000Z', reviews: { decision: 'APPROVED' as const, latest: 1 } };
    const first = await syncOutsidePrOutcomes({
      runsDir, now: () => NOW,
      list: async () => outcomes([pr(7, 'no', evidence)]),
    });
    expect(first.appended).toBe(1);

    // A review lands after merge: same verdict, new review evidence → one new row.
    const second = await syncOutsidePrOutcomes({
      runsDir, now: () => NOW,
      list: async () => outcomes([pr(7, 'no', {
        createdAt: evidence.createdAt,
        reviews: { decision: 'CHANGES_REQUESTED', latest: 2 },
      })]),
    });
    expect(second.appended).toBe(1);
    const rows = readJournal(runsDir).filter((r) => r['kind'] === OUTSIDE_PR_OUTCOME_SCHEMA && r['number'] === 7);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      reverted: 'no', createdAt: '2026-11-14T00:00:00.000Z',
      reviews: { decision: 'CHANGES_REQUESTED', latest: 2 },
    });

    // Identical evidence goes quiet; losing the fields entirely is also a change.
    const third = await syncOutsidePrOutcomes({
      runsDir, now: () => NOW,
      list: async () => outcomes([pr(7, 'no', {
        createdAt: evidence.createdAt,
        reviews: { decision: 'CHANGES_REQUESTED', latest: 2 },
      })]),
    });
    expect(third.appended).toBe(0);
    const fourth = await syncOutsidePrOutcomes({
      runsDir, now: () => NOW,
      list: async () => outcomes([pr(7, 'no')]),
    });
    expect(fourth.appended).toBe(1);
    const parsed = parseOutsidePrOutcomeJournal(readFileSync(join(runsDir, JOURNAL), 'utf8'));
    expect(parsed.outcomes.at(-1)).toMatchObject({ number: 7, createdAt: null, reviews: null });
  });

  it('re-journals a PR when its CI verdict arrives or changes', async () => {
    const first = await syncOutsidePrOutcomes({
      runsDir, now: () => NOW,
      list: async () => outcomes([pr(7, 'no')]),
    });
    expect(first.appended).toBe(1);

    // The bounded per-PR rollup read lands after the first journal: same
    // revert verdict, new ci evidence → one new row, then quiet.
    const second = await syncOutsidePrOutcomes({
      runsDir, now: () => NOW,
      list: async () => outcomes([pr(7, 'no', { ci: 'failure' })]),
    });
    expect(second.appended).toBe(1);
    const rows = readJournal(runsDir).filter((r) => r['kind'] === OUTSIDE_PR_OUTCOME_SCHEMA && r['number'] === 7);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ reverted: 'no', ci: 'failure' });
    const parsed = parseOutsidePrOutcomeJournal(readFileSync(join(runsDir, JOURNAL), 'utf8'));
    expect(parsed.outcomes.at(-1)).toMatchObject({ number: 7, reverted: 'no', ci: 'failure' });

    const third = await syncOutsidePrOutcomes({
      runsDir, now: () => NOW,
      list: async () => outcomes([pr(7, 'no', { ci: 'failure' })]),
    });
    expect(third.appended).toBe(0);
  });

  it('re-journals a PR when its recorded diff size arrives or changes', async () => {
    const diff = { additions: 40, deletions: 10, changedFiles: 4 };
    const first = await syncOutsidePrOutcomes({
      runsDir, now: () => NOW,
      list: async () => outcomes([pr(7, 'no')]),
    });
    expect(first.appended).toBe(1);

    // The merged-list read starts carrying the diff triple: same revert
    // verdict, new diff evidence → one new row, then quiet.
    const second = await syncOutsidePrOutcomes({
      runsDir, now: () => NOW,
      list: async () => outcomes([pr(7, 'no', { diff })]),
    });
    expect(second.appended).toBe(1);
    const rows = readJournal(runsDir).filter((r) => r['kind'] === OUTSIDE_PR_OUTCOME_SCHEMA && r['number'] === 7);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ reverted: 'no', diff });
    const parsed = parseOutsidePrOutcomeJournal(readFileSync(join(runsDir, JOURNAL), 'utf8'));
    expect(parsed.outcomes.at(-1)).toMatchObject({ number: 7, reverted: 'no', diff });

    const third = await syncOutsidePrOutcomes({
      runsDir, now: () => NOW,
      list: async () => outcomes([pr(7, 'no', { diff })]),
    });
    expect(third.appended).toBe(0);
  });

  it('writes nothing when gh is absent — no tool, no evidence', async () => {
    const out = await syncOutsidePrOutcomes({
      runsDir, now: () => NOW,
      list: async () => outcomes([], { sourceState: 'missing', repos: [], authors: [] }),
    });
    expect(out).toMatchObject({ state: 'missing', sourceState: 'missing', appended: 0, scanAppended: false, seen: 0 });
    expect(existsSync(join(runsDir, JOURNAL))).toBe(false);
  });

  it('skips the pass entirely when the journal is not a readable file', async () => {
    const journalDir = join(runsDir, 'metrics', OUTSIDE_PR_OUTCOME_JOURNAL_NAME);
    mkdirSync(journalDir, { recursive: true });
    let calls = 0;
    const out = await syncOutsidePrOutcomes({
      runsDir, now: () => NOW,
      list: async () => { calls += 1; return outcomes([pr(7, 'yes')]); },
    });
    expect(out).toMatchObject({ state: 'not-file', appended: 0, scanAppended: false });
    // The journal gates before the expensive gh read: list never ran.
    expect(calls).toBe(0);
  });

  it('honours an explicit journalPath outside the runs dir', async () => {
    const journalPath = join(directory, 'elsewhere', 'journal.jsonl');
    const out = await syncOutsidePrOutcomes({
      journalPath, now: () => NOW, list: async () => outcomes([pr(7, 'yes')]),
    });
    expect(out.journalPath).toBe(journalPath);
    expect(out.appended).toBe(1);
    expect(readFileSync(journalPath, 'utf8')).toContain(OUTSIDE_PR_OUTCOME_SCHEMA);
    expect(existsSync(join(runsDir, JOURNAL))).toBe(false);
  });
});

describe('parseOutsidePrOutcomeJournal', () => {
  const outcome = (number: number, verdict: string, at = AT): string => JSON.stringify({
    v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at, repo: 'acme/widgets', number,
    title: 't', author: 'ext-dev', agent: null, model: null,
    mergedAt: '2026-11-15T00:00:00.000Z', reverted: verdict,
  });
  const scan = (): string => JSON.stringify({
    v: 1, kind: OUTSIDE_PR_SCAN_SCHEMA, at: AT, sourceState: 'degraded', windowDays: 30,
    since: '2026-10-21T00:00:00.000Z', revertLedger: 'unreadable',
    repos: [{ repo: 'acme/widgets', state: 'degraded', listed: 9, hitLimit: true, prs: 0 }],
  });

  it('keeps the newest verdict per PR, the last scan row, and counts ignored lines', () => {
    const parsed = parseOutsidePrOutcomeJournal([
      outcome(7, 'no', '2026-11-19T00:00:00.000Z'),
      outcome(7, 'yes', '2026-11-20T00:00:00.000Z'),
      outcome(8, 'unknown'),
      scan(),
      'not json at all',
      '{"v":1,"kind":"other.kind","at":"x"}',
      '{"v":2,"kind":"' + OUTSIDE_PR_OUTCOME_SCHEMA + '"}',
      '',
    ].join('\n'));
    expect(parsed.verdicts.get('acme/widgets#7')).toBe('yes');
    expect(parsed.verdicts.get('acme/widgets#8')).toBe('unknown');
    expect(parsed.outcomes.map((r) => r.number)).toEqual([7, 8]);
    expect(parsed.outcomes[0]).toMatchObject({ reverted: 'yes', at: '2026-11-20T00:00:00.000Z' });
    expect(parsed.scan).toMatchObject({ sourceState: 'degraded', revertLedger: 'unreadable' });
    expect(parsed.scan?.repos[0]).toMatchObject({ state: 'degraded', hitLimit: true });
    expect(parsed.ignored).toBe(3);
  });

  it('keeps a well-formed agent slug, nulls malformed ones, and never carries model', () => {
    const row = (number: number, agent: unknown, model: unknown = null): string => JSON.stringify({
      v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at: AT, repo: 'acme/widgets', number,
      title: 't', author: 'ext-dev', agent, model,
      mergedAt: '2026-11-15T00:00:00.000Z', reverted: 'yes',
    });
    const parsed = parseOutsidePrOutcomeJournal([
      row(41, 'devin'), row(42, 'Cursor-X'), row(43, 'has space'), row(44, 7), row(45, null, 'gpt-5'),
    ].join('\n'));
    expect(parsed.outcomes).toHaveLength(5);
    expect(parsed.outcomes.map((r) => r.agent)).toEqual(['devin', null, null, null, null]);
    expect(parsed.outcomes.every((r) => r.model === null)).toBe(true);
    // Rows written before the evidence fields existed read them as null, never as zero.
    expect(parsed.outcomes.every((r) => r.createdAt === null && r.reviews === null)).toBe(true);
  });

  it('parses journaled createdAt and review evidence tolerantly', () => {
    const row = (number: number, extra: Record<string, unknown>): string => JSON.stringify({
      v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at: AT, repo: 'acme/widgets', number,
      title: 't', author: 'ext-dev', agent: null, model: null,
      mergedAt: '2026-11-15T00:00:00.000Z', reverted: 'yes', ...extra,
    });
    const parsed = parseOutsidePrOutcomeJournal([
      row(51, { createdAt: '2026-11-14T00:00:00.000Z', reviews: { decision: 'APPROVED', latest: 2 } }),
      row(52, { createdAt: 'not a date', reviews: { decision: null, latest: 0 } }),
      row(53, { createdAt: 42, reviews: { decision: 'CHANGES_REQUESTED' } }),
      row(54, { reviews: { decision: 'MAYBE', latest: -1 } }),
      row(55, { reviews: 'not an object' }),
    ].join('\n'));
    expect(parsed.outcomes).toHaveLength(5);
    expect(parsed.outcomes[0]).toMatchObject({
      createdAt: '2026-11-14T00:00:00.000Z', reviews: { decision: 'APPROVED', latest: 2 },
    });
    // createdAt keeps the recorded string like mergedAt does — folds
    // Date.parse it and treat unparseable stamps as no evidence; a
    // non-string value nulls. A reviews object missing `latest` drops
    // the whole evidence.
    expect(parsed.outcomes[1]).toMatchObject({ createdAt: 'not a date', reviews: { decision: null, latest: 0 } });
    expect(parsed.outcomes[2]).toMatchObject({ createdAt: null, reviews: null });
    // Out-of-vocabulary decision and negative latest both reject honestly.
    expect(parsed.outcomes[3]).toMatchObject({ reviews: null });
    expect(parsed.outcomes[4]).toMatchObject({ reviews: null });
  });

  it('parses journaled CI verdicts tolerantly', () => {
    const row = (number: number, ci: unknown): string => JSON.stringify({
      v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at: AT, repo: 'acme/widgets', number,
      title: 't', author: 'ext-dev', agent: null, model: null,
      mergedAt: '2026-11-15T00:00:00.000Z', reverted: 'yes', ci,
    });
    const parsed = parseOutsidePrOutcomeJournal([
      row(61, 'success'), row(62, 'failure'), row(63, 'pending'), row(64, 'none'),
      row(65, 'bogus'), row(66, 42),
      // A pre-fields row carries no ci key at all — honest null, never a guessed verdict.
      JSON.stringify({
        v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at: AT, repo: 'acme/widgets', number: 67,
        title: 't', author: 'ext-dev', agent: null, model: null,
        mergedAt: '2026-11-15T00:00:00.000Z', reverted: 'yes',
      }),
    ].join('\n'));
    expect(parsed.outcomes.map((r) => r.ci)).toEqual([
      'success', 'failure', 'pending', 'none', null, null, null,
    ]);
  });

  it('parses journaled diff-size triples tolerantly', () => {
    const row = (number: number, diff: unknown): string => JSON.stringify({
      v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at: AT, repo: 'acme/widgets', number,
      title: 't', author: 'ext-dev', agent: null, model: null,
      mergedAt: '2026-11-15T00:00:00.000Z', reverted: 'yes', diff,
    });
    const parsed = parseOutsidePrOutcomeJournal([
      row(71, { additions: 40, deletions: 10, changedFiles: 4 }),
      row(72, { additions: 0, deletions: 0, changedFiles: 0 }),
      // A partial triple, a negative count, a float and a non-record all
      // read null — never a guessed zero.
      row(73, { additions: 40, deletions: 10 }),
      row(74, { additions: -1, deletions: 10, changedFiles: 4 }),
      row(75, { additions: 1.5, deletions: 10, changedFiles: 4 }),
      row(76, 'not an object'),
      // A pre-fields row carries no diff key at all — honest null.
      JSON.stringify({
        v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at: AT, repo: 'acme/widgets', number: 77,
        title: 't', author: 'ext-dev', agent: null, model: null,
        mergedAt: '2026-11-15T00:00:00.000Z', reverted: 'yes',
      }),
    ].join('\n'));
    expect(parsed.outcomes.map((r) => r.diff)).toEqual([
      { additions: 40, deletions: 10, changedFiles: 4 },
      { additions: 0, deletions: 0, changedFiles: 0 },
      null, null, null, null, null,
    ]);
  });

  it('returns an empty parse for an empty journal', () => {
    const parsed = parseOutsidePrOutcomeJournal('');
    expect(parsed.verdicts.size).toBe(0);
    expect(parsed.outcomes).toEqual([]);
    expect(parsed.scan).toBeNull();
    expect(parsed.ignored).toBe(0);
  });
});
