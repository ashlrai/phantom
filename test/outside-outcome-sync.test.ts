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
  author: 'ext-dev', head: 'fix/x', mergedAt: '2026-11-15T00:00:00.000Z', reverted, ...over,
});

const outcomes = (prs: OutsidePrOutcomeV1[], over: Partial<OutsidePrOutcomesV1> = {}): OutsidePrOutcomesV1 => ({
  v: 1, generatedAt: AT, sourceState: 'healthy', windowDays: 30,
  since: '2026-10-21T12:00:00.000Z', revertLedger: 'read',
  repos: [{ repo: 'acme/widgets', state: 'healthy', listed: prs.length, hitLimit: false, prs }],
  authors: [], ...over,
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
      expect(row).toMatchObject({ v: 1, at: AT, repo: 'acme/widgets', agent: null, model: null, mergedAt: '2026-11-15T00:00:00.000Z' });
    }
    expect(outcomeRows.find((r) => r['number'] === 7)).toMatchObject({ reverted: 'yes', author: 'ext-dev' });
    expect(scanRows[0]).toMatchObject({
      v: 1, at: AT, sourceState: 'healthy', windowDays: 30, revertLedger: 'read',
      repos: [{ repo: 'acme/widgets', state: 'healthy', listed: 3, hitLimit: false, prs: 3 }],
    });

    const second = await syncOutsidePrOutcomes({ runsDir, list, now: () => NOW });
    expect(second).toMatchObject({ state: 'read', appended: 0, scanAppended: true, seen: 3 });
    expect(readJournal(runsDir)).toHaveLength(5);
  });

  it('appends a new outcome row only when a PR is new or its verdict changes', async () => {
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

  it('returns an empty parse for an empty journal', () => {
    const parsed = parseOutsidePrOutcomeJournal('');
    expect(parsed.verdicts.size).toBe(0);
    expect(parsed.outcomes).toEqual([]);
    expect(parsed.scan).toBeNull();
    expect(parsed.ignored).toBe(0);
  });
});
