import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdEmpties } from '../src/cli/empties.js';
import {
  buildEmptiesReport, classifyEmptyReason, emptiesText, EMPTY_REASONS, jobFamilies, ledgerFinishes,
  type EmptiesReport, type EmptyReason,
} from '../src/core/fleet/empties.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ts = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const finish = (job: string, lane: string, extra: Record<string, unknown> = {}, hoursAgo = 1) =>
  JSON.stringify({ event: 'finish', job, lane, empty: true, ts: ts(hoursAgo), ...extra });

// One fixture fleet: every reason, a job with no notes, a malformed line. All values are plainly fake.
const LEDGER = [
  finish('RQ-PHX-RECUTCOREC518', 'codex-local', { tokens_total: 1000 }),
  finish('RQ-RECUTWEBUIC502', 'codex-local', { tokens_total: null }),
  finish('RQ-SWEEPN17A1', 'claude', { tokens_total: 500 }),
  finish('RQ-GHSYNCQ8', 'devin', { tokens_total: 200 }),
  finish('RQ-RECUTNOCHANGEQ8', 'claude'),
  finish('RQ-MISSINGQ8', 'devin'),
  JSON.stringify({ event: 'precheck_skip', job: 'RQ-SKIPPEDQ1', repo: 'phantom', lane: 'claude', code: 13, ts: ts(2) }),
  finish('RQ-SLOWQ2', 'claude', { tokens_total: 9000 }),
  finish('RQ-SLOWQ3', 'claude', { exit_code: 124 }),
  finish('RQ-LIMITQ4', 'codex-local', { pool_error: 'usage_limit', exit_code: 1 }),
  finish('RQ-MYSTERYQ5', 'grok'),
  finish('RQ-SHIPPEDQ6', 'claude', { empty: false, tokens_total: 7000 }),
  finish('RQ-OLDQ7', 'claude', {}, 30),
  '{torn',
  '[1,2]',
  '',
].join('\n');
const NOTES: Record<string, string> = {
  'RQ-PHX-RECUTCOREC518': '# Notes\nNo diff: the change is already on master (abc1234).',
  'RQ-RECUTWEBUIC502': 'EMPTY_REASON: duplicate-landed\nNothing else to report.',
  'RQ-SWEEPN17A1': 'No eligible target found: no conflicting PRs left.',
  'RQ-RECUTNOCHANGEQ8': 'No diff produced. Working tree clean.',
};
const LOGS: Record<string, string> = {
  'RQ-GHSYNCQ8': 'gh not logged in; cannot check open PRs.\nNo changes made.',
  'RQ-MISSINGQ8': 'bash: tsgo: command not found\nNo changes made.',
  'RQ-SLOWQ2': 'still running tests',
};
const EXPECTED: Record<EmptyReason, string[]> = {
  already_on_master: ['RQ-PHX-RECUTCOREC518', 'RQ-RECUTWEBUIC502'],
  no_eligible_target: ['RQ-SWEEPN17A1'],
  no_diff: ['RQ-RECUTNOCHANGEQ8'],
  blocked_tool: ['RQ-GHSYNCQ8'],
  tool_missing: ['RQ-MISSINGQ8'],
  precheck_skip: ['RQ-SKIPPEDQ1'],
  timeout: ['RQ-SLOWQ2', 'RQ-SLOWQ3'],
  model_error: ['RQ-LIMITQ4'],
  unknown: ['RQ-MYSTERYQ5'],
};

let root: string, runs: string, notes: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'empties-'));
  runs = join(root, 'runs'); notes = join(root, 'wt');
  await mkdir(join(runs, 'metrics'), { recursive: true });
  await mkdir(join(runs, 'queue', 'run'), { recursive: true });
  await writeFile(join(runs, 'metrics', 'jobs.jsonl'), LEDGER);
  await writeFile(join(runs, 'queue', 'run', 'RQ-SLOWQ2.timeout'), 'x');
  for (const [job, text] of Object.entries(LOGS)) await writeFile(join(runs, `${job}.log`), text);
  for (const [job, text] of Object.entries(NOTES)) {
    await mkdir(join(notes, job), { recursive: true });
    await writeFile(join(notes, job, 'BRIDGE_NOTES.md'), text);
  }
});
afterAll(() => rm(root, { recursive: true, force: true }));

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [], err: string[] = [];
  const code = await cmdEmpties(args, { now: () => NOW, out: line => out.push(line), err: line => err.push(line) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const fixture = (...args: string[]) => run('--runs-dir', runs, '--notes-dir', notes, ...args);

describe('phm empties', () => {
  it('prints JSON by default and groups every empty finish by reason', async () => {
    const { code, out } = await fixture();
    expect(code).toBe(0);
    const report = JSON.parse(out) as EmptiesReport;
    expect(report).toMatchObject({ schema: 'empties.v1', since_hours: 24, metrics: 'ok', finishes: 12, empties: 11, empty_share: 0.917 });
    expect(report.metrics_path.endsWith(join('metrics', 'jobs.jsonl'))).toBe(true);
    for (const reason of EMPTY_REASONS) {
      const row = report.reasons.find(r => r.reason === reason)!;
      expect(row.count, reason).toBe(EXPECTED[reason].length);
      expect(row.examples, reason).toEqual(EXPECTED[reason].slice(0, 2));
      expect(row.share_of_finishes, reason).toBe(Math.round(EXPECTED[reason].length / 12 * 1000) / 1000);
      expect(row.next_step, reason).toEqual(expect.any(String));
    }
    expect(report.reasons.map(r => r.reason)).toEqual(['already_on_master', 'timeout', 'no_eligible_target', 'no_diff', 'blocked_tool', 'tool_missing', 'precheck_skip', 'model_error', 'unknown']);
  });

  it('names the lanes and job families behind a reason and the step that stops the waste', async () => {
    const report = JSON.parse((await fixture()).out) as EmptiesReport;
    expect(report.reasons[0]).toMatchObject({
      reason: 'already_on_master', label: 'already on master',
      lanes: [{ name: 'codex-local', count: 2 }], prefixes: [{ name: 'RECUT', count: 2 }],
      next_step: 'Stop queuing RECUT jobs: the work is already on master. Check master before queuing more.',
    });
    expect(report.reasons.find(r => r.reason === 'blocked_tool')!.next_step).toContain('lane devin');
  });

  it('names the top three empty-job families across reasons in 24 hours, with stable ties', async () => {
    const report = JSON.parse((await fixture()).out) as EmptiesReport;
    expect(report.top_families).toEqual([
      { name: 'RECUT', count: 3 }, { name: 'SLOWQ', count: 2 }, { name: 'GHSYNCQ', count: 1 },
    ]);
    const reversed = buildEmptiesReport({
      ledger: ledgerFinishes(LEDGER.split('\n').reverse().join('\n'), NOW, 24),
      evidence: new Map(), hours: 24, metricsPath: '/fake/jobs.jsonl',
    });
    expect(reversed.top_families).toEqual(report.top_families);
  });

  it('reports missing data as unknown, never as zero', async () => {
    const report = JSON.parse((await fixture()).out) as EmptiesReport;
    const by = (reason: EmptyReason) => report.reasons.find(r => r.reason === reason)!;
    // One of the two jobs recorded tokens: the sum is partial and says so.
    expect(by('already_on_master')).toMatchObject({ tokens: 1000, tokens_unknown_jobs: 1 });
    expect(by('timeout')).toMatchObject({ tokens: 9000, tokens_unknown_jobs: 1 });
    // No job recorded tokens: null, not 0.
    expect(by('precheck_skip')).toMatchObject({ tokens: null, tokens_unknown_jobs: 1 });
    expect(by('unknown')).toMatchObject({ tokens: null, tokens_unknown_jobs: 1 });
    expect(report).toMatchObject({ tokens: 10700, tokens_unknown_jobs: 7, malformed_lines: 2, notes_missing: 6 });
    expect(by('unknown').next_step).toBe('Have workers end an empty run with an EMPTY_REASON line: 1 of these 1 left no notes.');
  });

  it('classifies a job with no notes from its log, and leaves it unknown with no log either', async () => {
    const report = JSON.parse((await fixture()).out) as EmptiesReport;
    expect(report.reasons.find(r => r.reason === 'blocked_tool')!.examples).toEqual(['RQ-GHSYNCQ8']);
    expect(report.reasons.find(r => r.reason === 'unknown')!.examples).toEqual(['RQ-MYSTERYQ5']);
  });

  it('keeps JSON key order stable', async () => {
    const report = JSON.parse((await fixture()).out) as EmptiesReport;
    expect(Object.keys(report)).toEqual(['schema', 'since_hours', 'metrics_path', 'metrics', 'finishes', 'empties', 'empty_share', 'tokens', 'tokens_unknown_jobs', 'malformed_lines', 'notes_missing', 'top_families', 'reasons', 'families']);
    for (const reason of report.reasons) {
      expect(Object.keys(reason)).toEqual(['reason', 'label', 'count', 'share_of_finishes', 'tokens', 'tokens_unknown_jobs', 'lanes', 'prefixes', 'examples', 'next_step']);
    }
    for (const family of report.families) {
      expect(Object.keys(family)).toEqual(['name', 'finishes', 'empties', 'empty_rate', 'wasted_tokens', 'tokens_unknown_jobs', 'recommendation']);
    }
    expect((await fixture()).out).toBe((await fixture('--json')).out);
  });

  it('fits --text in 20 lines with every reason present', async () => {
    const { code, out } = await fixture('--text');
    const lines = out.split('\n');
    expect(code).toBe(0);
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines[0]).toBe('Empty finishes in the last 24 h: 11 of 12 finishes (92%), 10,700 tokens (7 jobs unknown).');
    expect(lines[1]).toBe('already on master: 2 jobs, 17% of finishes, 1,000 tokens (1 job unknown). Lanes: codex-local 2. Jobs: RECUT 2.');
    expect(lines[2]).toBe('  Next: Stop queuing RECUT jobs: the work is already on master. Check master before queuing more.');
    expect(out).toContain('precheck skip: 1 job, 8% of finishes, tokens unknown.');
    expect(out).toContain('missing tool: 1 job, 8% of finishes, tokens unknown.');
    expect(lines.at(-1)).toBe('6 empty jobs left no notes, so their reason comes from the log alone. 2 metrics lines could not be read and were skipped.');
  });

  it('honours --since and a --metrics override', async () => {
    expect((JSON.parse((await fixture('--since', '2d')).out) as EmptiesReport)).toMatchObject({ since_hours: 48, finishes: 13, empties: 12 });
    const other = join(root, 'other.jsonl');
    await writeFile(other, finish('RQ-ONLYQ1', 'claude', { empty: false }));
    expect(JSON.parse((await fixture('--metrics', other)).out)).toMatchObject({ finishes: 1, empties: 0, empty_share: 0, tokens: null });
    expect((await fixture('--metrics', other, '--text')).out).toBe('Empty finishes in the last 24 h: 0 of 1 finish (0%), tokens unknown.');
  });

  it('says unknown and exits 1 when the metrics file is unreadable', async () => {
    const json = await run('--runs-dir', join(root, 'absent'));
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({ metrics: 'unreadable', finishes: null, empties: null, empty_share: null, tokens: null, malformed_lines: null, top_families: null, reasons: [], families: [] });
    const text = await run('--runs-dir', join(root, 'absent'), '--text');
    expect(text.out).toMatch(/^Empty finishes in the last 24 h: unknown\. Cannot read the job metrics file .*jobs\.jsonl\.$/);
  });

  it('prints usage for --help and exits 2 on a bad option', async () => {
    expect(await run('--help')).toMatchObject({ code: 0, err: '' });
    for (const args of [['--since', '0h'], ['--since', 'soon'], ['--metrics'], ['--nope']]) {
      const result = await run(...args);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.out).toBe('');
    }
  });
});

describe('classifyEmptyReason', () => {
  const launched = { skipped: false, exitCode: null, poolError: false };
  const cases: Array<[string, EmptyReason, string | null, string | null]> = [
    ['notes naming master', 'already_on_master', 'Already merged into master in an earlier job.', null],
    ['a no-candidate verdict that says why', 'already_on_master', null, 'NO CANDIDATE: the fix is already on master.'],
    ['a bare no-candidate verdict', 'no_eligible_target', null, 'NO CANDIDATE'],
    ['a stated unclear prompt', 'no_eligible_target', 'EMPTY_REASON: prompt-unclear', null],
    ['a stated block', 'blocked_tool', 'EMPTY_REASON: blocked', 'NO CANDIDATE'],
    ['a missing tool', 'tool_missing', null, 'bash: tsgo: command not found'],
    ['a spawn failure', 'tool_missing', null, 'spawn tsgo ENOENT'],
    ['an absent executable', 'tool_missing', 'tsgo is not installed', null],
    ['a plain no-diff outcome', 'no_diff', 'No diff produced.', null],
    ['an unchanged worktree', 'no_diff', null, 'nothing to commit, working tree clean'],
    ['a tool failure before no diff', 'tool_missing', 'No diff produced.', 'tsgo: command not found'],
    ['a timeout before no diff', 'timeout', 'No diff produced.', 'worker step timed out'],
    ['a denial beside a nothing-to-do note', 'blocked_tool', 'Nothing to do.', 'gh: operation not permitted'],
    ['a precheck marker in the log', 'precheck_skip', null, 'PARKED RQ-FAKE-1 [precheck code=13 reason=landed]'],
    ['a timed out step', 'timeout', null, 'worker step timed out after 1800s'],
    ['a provider limit', 'model_error', null, "You've hit your usage limit. Try again later."],
    ['notes with no reason', 'unknown', 'Summary written.', 'Done.'],
    ['missing evidence', 'unknown', null, null],
  ];
  it.each(cases)('tags %s as %s', (_name, reason, note, log) => {
    expect(classifyEmptyReason(launched, { notes: note, log, timedOut: false })).toBe(reason);
  });

  it('ignores a reason that only the echoed prompt names', () => {
    const log = `Task: report jobs already on master and NO CANDIDATE\n${Array.from({ length: 40 }, (_, i) => `step ${i}`).join('\n')}`;
    expect(classifyEmptyReason(launched, { notes: null, log, timedOut: false })).toBe('unknown');
  });
});

describe('ledgerFinishes and jobFamilies', () => {
  it('ranks only newest empty finishes in the requested window, including unknown reasons', () => {
    const ledger = [
      finish('RQ-RETRY1', 'claude', {}, 3), finish('RQ-RETRY1', 'claude', { empty: false }),
      finish('RQ-OLDER1', 'claude', {}, 25), finish('RQ-FUTURE1', 'claude', {}, -1),
      finish('RQ-BOUNDARY1', 'claude', {}, 24), finish('RQ-UNKNOWN1', 'unknown'),
    ].join('\n');
    const report = buildEmptiesReport({ ledger: ledgerFinishes(ledger, NOW, 24), evidence: new Map(), hours: 24, metricsPath: '/fake/jobs.jsonl' });
    expect(report.top_families).toEqual([{ name: 'BOUNDARY', count: 1 }, { name: 'UNKNOWN', count: 1 }]);
    expect(report.reasons.find(r => r.reason === 'unknown')!.count).toBe(2);
  });

  it('keeps the newest row per job, so a retry that published is not an empty', () => {
    const ledger = [
      finish('RQ-RETRYQ1', 'claude', { tokens_total: 10 }, 3), finish('RQ-RETRYQ1', 'claude', { empty: false }, 1),
      JSON.stringify({ event: 'launch', job: 'RQ-LIVEQ2', lane: 'claude', ts: ts(1) }), finish('../etc', 'claude'),
      JSON.stringify({ event: 'skipped_empty', job: 'RQ-DRYRUNQ3', lane: 'claude', applied: false, ts: ts(1) }),
    ].join('\n');
    expect(ledgerFinishes(ledger, NOW, 24)).toEqual({
      finishes: [{ id: 'RQ-RETRYQ1', lane: 'claude', empty: false, skipped: false, tokens: 10, exitCode: null, poolError: false }],
      malformed: 0,
    });
  });

  it('names a family by what its job ids share', () => {
    expect(jobFamilies(['RQ-PHX-RECUTCOREFLEETC518', 'RQ-RECUTWEBUIC502', 'RQ-PHX-RECUTCOMMSC500', 'RQ-DEVINCLOUD-WEBFIX2-N17', 'RQ-DEVINCLOUD-WIKI2-N17', 'FIXUP-CI-phantom-preflight-1'])).toEqual([
      { name: 'RECUT', count: 3 }, { name: 'DEVINCLOUD', count: 2 }, { name: 'phantom-preflight', count: 1 },
    ]);
  });

  it('reports a readable but empty window as zero finishes with no share', () => {
    const report = buildEmptiesReport({ ledger: { finishes: [], malformed: 0 }, evidence: new Map(), hours: 24, metricsPath: '/fake/jobs.jsonl' });
    expect(report).toMatchObject({ finishes: 0, empties: 0, empty_share: null, tokens: null, top_families: [], families: [] });
    expect(emptiesText(report)).toEqual(['No finishes recorded in the last 24 h (/fake/jobs.jsonl).']);
  });
});

describe('empty job family rankings', () => {
  const batch = (family: string, empty: number, total: number, tokens: number | null = 10) =>
    Array.from({ length: total }, (_, i) => finish(`RQ-${family}-${i}`, i % 2 ? 'claude' : 'codex-personal', { empty: i < empty, tokens_total: i < empty ? tokens : 1_000_000 }));
  const report = (rows: string[], hours = 24) => buildEmptiesReport({
    ledger: ledgerFinishes(rows.join('\n'), NOW, hours), evidence: new Map(), hours, metricsPath: '/fake/jobs.jsonl',
  });

  it('ranks mixed families by rate, wasted tokens and name, across lanes and productive finishes', () => {
    const rows = [...batch('RECUTCORE', 4, 4), finish('RQ-PHX-RECUTWEB', 'grok', { empty: false, tokens_total: 900_000 }),
      ...batch('BRAVO', 4, 5, 100), ...batch('ALPHA', 4, 5, 100), ...batch('SMALL', 4, 4), ...batch('LOWER', 3, 5, 1_000_000)];
    const result = report(rows);
    expect(result.families.map(row => row.name)).toEqual(['SMALL', 'ALPHA', 'BRAVO', 'RECUT', 'LOWER']);
    expect(result.families[3]).toEqual({ name: 'RECUT', finishes: 5, empties: 4, empty_rate: 0.8, wasted_tokens: 40, tokens_unknown_jobs: 0, recommendation: 'suppress' });
    expect(result.families[4]).toMatchObject({ empty_rate: 0.6, recommendation: 'keep' });
    expect(JSON.stringify(report([...rows].reverse()).families)).toBe(JSON.stringify(result.families));
    expect(emptiesText(result)).toContain('Family ALPHA: 4/5 empty (80%), wasted 400 tokens. Suppress new jobs in this family.');
    expect(emptiesText(result)).toContain('Family SMALL: 4/4 empty (100%), wasted 40 tokens. Collect at least five finishes before suppressing.');
  });

  it.each([[4, 4, 'observe'], [5, 3, 'keep'], [5, 4, 'suppress'], [5, 0, 'keep']] as const)(
    'recommends correctly for %i finishes with %i empty', (total, empty, recommendation) => {
      expect(report(batch('SAMPLE', empty, total)).families[0]).toMatchObject({ finishes: total, empties: empty, recommendation });
    },
  );

  it('counts only the newest finish per job in the 24-hour window', () => {
    const rows = [...batch('RECUT', 4, 5), finish('RQ-RECUT-0', 'claude', { empty: false }, 0),
      finish('RQ-RECUT-old', 'claude', {}, 24.01), finish('RQ-RECUT-future', 'claude', {}, -1),
      JSON.stringify({ event: 'launch', job: 'RQ-RECUT-live', ts: ts(0) })];
    expect(report(rows).families[0]).toMatchObject({ finishes: 5, empties: 3, empty_rate: 0.6, recommendation: 'keep' });
    expect(report(rows, 48).families[0]).toMatchObject({ finishes: 6, empties: 4, recommendation: 'suppress' });
  });

  it('preserves missing and partial token evidence and distinguishes measured zero waste', () => {
    const rows = [...batch('UNKNOWN', 1, 1, null), ...batch('ZEROES', 1, 1, 0), ...batch('KNOWN', 1, 1, 20),
      ...batch('PARTIAL', 1, 2, 20), finish('RQ-PARTIAL-2', 'claude'), ...batch('CLEAN', 0, 5)];
    const families = report(rows).families;
    expect(families.map(row => row.name)).toEqual(['KNOWN', 'ZEROES', 'UNKNOWN', 'PARTIAL', 'CLEAN']);
    expect(families[2]).toMatchObject({ wasted_tokens: null, tokens_unknown_jobs: 1 });
    expect(families[3]).toMatchObject({ wasted_tokens: 20, tokens_unknown_jobs: 1 });
    expect(families[4]).toMatchObject({ wasted_tokens: 0, tokens_unknown_jobs: 0, recommendation: 'keep' });
  });
});
