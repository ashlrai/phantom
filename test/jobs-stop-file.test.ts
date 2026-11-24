import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdJobsYield } from '../src/cli/jobs-yield.js';
import { readMetricsPanel } from '../src/core/fleet/metrics-panel.js';
import { readRecutGateFacts, shouldEmitRecut } from '../src/core/fleet/recut-gate.js';
import { jobKind, yieldTally } from '../src/core/fleet/slot-yield.js';
import { familyPattern, parseStopFile, planStopFile, readLiveStops, STOP_FILE_ENV, STOP_MARK, stopFilePath, stoppedBy, stoppedFamilies, stopRows } from '../src/core/fleet/stop-file.js';

const now = Date.parse('2026-11-18T00:00:00Z'), nowS = now / 1000;
const row = (fields: Record<string, unknown>) => JSON.stringify(fields);
const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
/** One job: launched `hoursAgo`, then empty or merged. */
const ran = (job: string, hoursAgo: number, merged = false, repo = 'phantom') => [row({ event: 'launch', job, repo, ts: at(hoursAgo) }),
  row({ event: 'finish', job, empty: !merged, ts: at(hoursAgo - 0.5) }),
  ...(merged ? [row({ event: 'publish', job, class: 'pr', url: `https://example.invalid/pr/${job}`, ts: at(hoursAgo - 0.5) }), row({ event: 'outcome', job, state: 'MERGED', ts: at(hoursAgo - 0.4) })] : [])];
const many = (prefix: string, count: number, merged: number[] = []) => Array.from({ length: count }, (_, i) => ran(`${prefix}${i + 1}`, 20 - i, merged.includes(i + 1))).flat();
const parts = (lines: string[]) => { const tally = yieldTally(now, 24); for (const line of lines) tally.add(line); return tally.jobYieldParts(); };

// stop: 6 empty. keep: 2 of 4 merged. watch: 1 of 6 merged. small: 5 empty. fresh: 1 of 12, merged last. stale: 1 of 12, merged first.
const fixture = [...many('RQ-PHX-RECUTCOREC', 6), ...many('RQ-DOCS-FIX-', 4, [1, 2]), ...many('RQ-WATCH-', 6, [2]), ...many('RQ-SMALL-', 5),
  ...many('RQ-FRESH-', 12, [11]), ...many('RQ-STALE-', 12, [1])];
const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'stop-file-')); dirs.push(dir); return dir; };
const ledger = (lines: string[]) => { const file = join(scratch(), 'jobs.jsonl'); writeFileSync(file, lines.join('\n')); return file; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('which kinds stop', () => {
  const verdicts = Object.fromEntries(parts(fixture).report.families.map(f => [f.family, f.verdict]));
  it('tells stop, keep and watch apart', () => {
    expect(verdicts).toMatchObject({ 'RQ-PHX-RECUTCORE': 'stop', 'RQ-DOCS-FIX': 'keep', 'RQ-WATCH': 'watch' });
  });
  it('keeps a kind with fewer than 6 launches', () => expect(verdicts['RQ-SMALL']).toBe('watch'));
  it('keeps a kind with a merge in its last 3 launches, and stops the same counts when the merge is old', () => {
    expect(verdicts).toMatchObject({ 'RQ-FRESH': 'watch', 'RQ-STALE': 'stop' });
  });
  it('writes one row per stop kind: pattern, until and a reason with no spaces', () => {
    expect(stopRows(parts(fixture), now, 24)).toEqual({ unsafe: [], rows: [
      { family: 'RQ-STALE', pattern: '^RQ-STALE(C[0-9]+)?(-N?[0-9]+)?((N[0-9]+[A-Z]?)?Q8)?$', until: nowS + 86_400, reason: 'RQ-STALE_1of12' },
      { family: 'RQ-PHX-RECUTCORE', pattern: '^RQ-PHX-RECUTCORE(C[0-9]+|[0-9][A-Za-z0-9]*)?(-N?[0-9]+)?((N[0-9]+[A-Z]?)?Q8)?$', until: nowS + 86_400, reason: 'RQ-PHX-RECUTCORE_0of6' }] });
  });
  it('names filler kinds by the repo codes in their ids, with dashes for spaces in the reason', () => {
    const filler = Array.from({ length: 6 }, (_, i) => ran(`RQ-MD${i + 1}A11180${i}Q8`, 10, false, 'md')).flat();
    expect(stopRows(parts(filler), now, 2).rows).toEqual([{ family: 'one-test filler md', pattern: '^RQ-(MD)[0-9]+A[0-9]+Q8$', until: nowS + 7200, reason: 'one-test-filler-md_0of6' }]);
  });
  it('does not write a kind whose pattern would stop another kind', () => {
    const lines = [...many('RQ-MD-', 6), ...Array.from({ length: 2 }, (_, i) => ran(`RQ-LOCUS${i + 1}A11180${i}Q8`, 10, true, 'md')).flat()];
    expect(familyPattern('one-test filler md', ['RQ-LOCUS1A111800Q8'])).toBe('^RQ-(LOCUS)[0-9]+A[0-9]+Q8$');
    expect(familyPattern('one-test filler md')).toBeNull();
    expect(stopRows(parts(lines), now).rows.map(r => r.family)).toEqual(['RQ-MD']);
    const clash = { report: parts(many('RQ-ODD-', 6)).report, ids: new Map([['RQ-ODD', ['RQ-ODD-1']], ['other', ['RQ-ODD-2']]]) };
    expect(stopRows(clash, now)).toEqual({ rows: [], unsafe: [{ family: 'RQ-ODD', why: 'its pattern would also stop other' }] });
  });
});

describe('familyPattern', () => {
  const ids = ['RQ-PHX-RECUTCOREC566', 'RQ-PHX-RECUTCOREC9', 'RQ-PHX-RECUTWEBUIC502', 'RQ-PHX-SLACKCOMPOSER498S', 'RQ-STOPFILEN18XQ8', 'RQ-RECUTDEDUPQ8',
    'RQ-PR-LEVERAGE-1', 'RQ-DEVINCLOUD-RUNNERKEY3-N17', 'RQ-DEVINCLOUD-RUNNERKEY-N17', 'RQ-V2.DOT-FIX-3', 'RQ-AC-1', 'RQ-AC55', 'RQ-A-7', 'RQ-TOKEN-2',
    'RQ-TOKEN18AQ8', 'RQ-TOKENN18AQ8', 'RQ-TOKE-1', 'RQ-MD-1', 'RQ-MD3A111800Q8', 'RQ-PLAINWORD', 'RQ-PHX-RECUTCOREFLEETC556', 'RQ-PHX-RECUT-1', 'FIXUP-CI-phantom-unrelated-pr-recover-560152'];
  const kinds = [...new Set(ids.map(id => jobKind(id)))].filter(kind => !kind.startsWith('one-test filler'));
  it('is anchored, escapes the kind and matches its own ids with dashes and digits', () => {
    expect(familyPattern('RQ-V2.DOT-FIX')).toBe('^RQ-V2\\.DOT-FIX(C[0-9]+|[0-9][A-Za-z0-9]*)?(-N?[0-9]+)?((N[0-9]+[A-Z]?)?Q8)?$');
    const test = new RegExp(familyPattern('RQ-V2.DOT-FIX')!);
    expect(['RQ-V2.DOT-FIX-3', 'RQ-V2.DOT-FIX-N17', 'RQ-V2.DOT-FIX'].every(id => test.test(id))).toBe(true);
    expect(['RQ-V2XDOT-FIX-3', 'XRQ-V2.DOT-FIX-3', 'RQ-V2.DOT-FIX-3-more', 'RQ-V2.DOT-FIXES-3', 'RQ-V2.DOT'].some(id => test.test(id))).toBe(false);
    for (const id of ['RQ-PHX-RECUTCOREC566', 'RQ-PHX-SLACKCOMPOSER498S', 'RQ-STOPFILEN18XQ8', 'RQ-PR-LEVERAGE-1', 'RQ-DEVINCLOUD-RUNNERKEY3-N17', 'RQ-TOKENN18AQ8']) {
      expect(new RegExp(familyPattern(jobKind(id))!).test(id), id).toBe(true);
    }
  });
  it('never matches an id of another kind, an unrelated id or every id', () => {
    for (const kind of kinds) {
      const pattern = familyPattern(kind);
      if (pattern === null) continue;
      expect(pattern.startsWith('^') && pattern.endsWith('$'), kind).toBe(true);
      const test = new RegExp(pattern);
      for (const id of [...ids, '', 'x', 'RQ-UNRELATED-1', `X${kind}-1`]) if (test.test(id)) expect(jobKind(id), `${pattern} matched ${id}`).toBe(kind);
    }
    expect(new RegExp(familyPattern('RQ-PHX-RECUTCORE')!).test('RQ-PHX-RECUTCOREFLEETC556')).toBe(false);
    expect(new RegExp(familyPattern('RQ-AC')!).test('RQ-AC55')).toBe(false);
    expect(new RegExp(familyPattern('RQ-TOKEN')!).test('RQ-TOKEN18AQ8')).toBe(false);
    expect(new RegExp(familyPattern('RQ-MD')!).test('RQ-MD3A111800Q8')).toBe(false);
  });
  it('gives no pattern for a kind it cannot pin down', () => {
    for (const kind of ['', '.*', 'RQ-A B', 'RQ-PR-LEVERAGE-1', 'RQ-PHX-RECUTCOREC566', 'RQ-TAIL-']) expect(familyPattern(kind), kind).toBeNull();
  });
});

describe('planStopFile', () => {
  const hand = ['# leader notes', '^RQ-HAND-[0-9]+$\t' + (nowS + 60) + '\tby_hand', '', '^RQ-OLDHAND$\t' + (nowS - 60) + '\told_hand', '# auto notes are not marks'];
  const before = [...hand, '^RQ-GONE-[0-9]+$\t' + (nowS - 1) + '\tRQ-GONE_0of6', STOP_MARK, '^RQ-LIVE$\t' + (nowS + 600) + '\tRQ-LIVE_0of7', STOP_MARK,
    '^RQ-AGAIN$\t' + (nowS + 5) + '\tRQ-AGAIN_0of6', STOP_MARK, ''].join('\n');
  const rows = [{ family: 'RQ-AGAIN', pattern: '^RQ-AGAIN$', until: nowS + 86_400, reason: 'RQ-AGAIN_0of9' },
    { family: 'RQ-HAND', pattern: '^RQ-HAND-[0-9]+$', until: nowS + 86_400, reason: 'RQ-HAND_0of6' }];
  it('keeps hand rows and comments, drops expired tool rows, keeps live ones and refreshes a repeat', () => {
    const plan = planStopFile(before, rows, now);
    expect(plan).toMatchObject({ kept_hand: 2, kept_auto: 1, dropped_expired: 1 });
    expect(plan.text.split('\n')).toEqual([...hand, '^RQ-LIVE$\t' + (nowS + 600) + '\tRQ-LIVE_0of7', STOP_MARK, '^RQ-AGAIN$\t' + (nowS + 86_400) + '\tRQ-AGAIN_0of9', STOP_MARK, '']);
    expect(planStopFile(plan.text, rows, now).text).toBe(plan.text);
  });
  it('starts an empty file and reads rows back with their mark', () => {
    expect(planStopFile('', [], now)).toEqual({ text: '', kept_hand: 0, kept_auto: 0, dropped_expired: 0 });
    expect(parseStopFile(planStopFile(hand.join('\n'), rows.slice(0, 1), now).text)).toEqual([
      { pattern: '^RQ-HAND-[0-9]+$', until: nowS + 60, reason: 'by_hand', auto: false }, { pattern: '^RQ-OLDHAND$', until: nowS - 60, reason: 'old_hand', auto: false },
      { pattern: '^RQ-AGAIN$', until: nowS + 86_400, reason: 'RQ-AGAIN_0of9', auto: true }]);
  });
});

describe('phm jobs yield --stop-file', () => {
  const run = async (args: string[]) => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {}), err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await cmdJobsYield(args, undefined, now);
    const result = { code, out: out.mock.calls.map(call => String(call[0])).join('\n'), err: err.mock.calls.map(call => String(call[0])).join('\n') };
    vi.restoreAllMocks();
    return result;
  };
  it('writes the rows with temp plus rename, keeps the hand rows and prints versioned JSON', async () => {
    const dir = scratch(), file = join(dir, 'stops.tsv');
    writeFileSync(file, '# by hand\n^RQ-HAND$\t' + (nowS + 60) + '\tby_hand\n');
    const result = await run(['--stop-file', '--out', file, '--metrics', ledger(fixture), '--ttl-hours', '48', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ schema: 'jobs.stop-file.v1', version: 1, dry_run: false, written: true, ttl_hours: 48, yield_known: true, error: null,
      rows: [{ family: 'RQ-STALE', until: nowS + 172_800, reason: 'RQ-STALE_1of12' }, { family: 'RQ-PHX-RECUTCORE', reason: 'RQ-PHX-RECUTCORE_0of6' }],
      unsafe: [], kept_hand: 1, kept_auto: 0, dropped_expired: 0 });
    expect(readdirSync(dir)).toEqual(['stops.tsv']);
    const lines = readFileSync(file, 'utf8').split('\n');
    expect(lines.slice(0, 2)).toEqual(['# by hand', '^RQ-HAND$\t' + (nowS + 60) + '\tby_hand']);
    expect(lines.filter(line => line === STOP_MARK)).toHaveLength(2);
    expect(stoppedBy((await readLiveStops(file, now))!, ['RQ-PHX-RECUTCOREC567'])?.reason).toBe('RQ-PHX-RECUTCORE_0of6');
    expect(stoppedBy((await readLiveStops(file, now))!, ['RQ-DOCS-FIX-9', 'RQ-FRESH-13', 'RQ-SMALL-6'])).toBeNull();
  });
  it('writes nothing with --dry-run, and says what it would write', async () => {
    const file = join(scratch(), 'stops.tsv');
    const result = await run(['--stop-file', '--dry-run', '--out', file, '--metrics', ledger(fixture)]);
    expect(result).toMatchObject({ code: 0, err: '' });
    expect(result.out).toContain('(nothing written)\n2 job kinds stopped for 24 hours:\n  ^RQ-STALE(');
    expect(result.out).toContain('\t' + (nowS + 86_400) + '\tRQ-PHX-RECUTCORE_0of6');
    expect(readdirSync(join(file, '..'))).toEqual([]);
  });
  it('reads unknown, never a guess, when no path is set, the yield is unreadable or the file is', async () => {
    vi.stubEnv(STOP_FILE_ENV, '');
    expect(stopFilePath()).toBeNull();
    expect(stopFilePath({ [STOP_FILE_ENV]: 'relative/stops.tsv' })).toBeNull();
    const metrics = ledger(fixture);
    expect(await run(['--stop-file', '--metrics', metrics])).toMatchObject({ code: 1, out: '', err: `Stop file: unknown. Pass --out <path> or set ${STOP_FILE_ENV}; add --dry-run to only see the rows` });
    expect((await run(['--stop-file', '--dry-run', '--metrics', metrics])).out).toContain('Stop file: unknown (nothing written)');
    const dir = scratch(), missing = join(dir, 'none.jsonl');
    expect(await run(['--stop-file', '--out', join(dir, 'stops.tsv'), '--metrics', missing])).toMatchObject({ code: 1, out: '', err: 'Job yield: unknown (job metrics file unreadable)' });
    const json = await run(['--stop-file', '--out', dir, '--metrics', metrics, '--json']);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({ schema: 'jobs.stop-file.v1', version: 1, written: false, error: 'Stop file: unknown (the file cannot be read); nothing written' });
    expect(readdirSync(dir)).toEqual([]);
  });
  it('rejects bad arguments', async () => {
    for (const args of [['--dry-run'], ['--out', 'x'], ['--ttl-hours', '2'], ['--stop-file', '--stop-list'], ['--stop-file', '--ttl-hours', '73'], ['--stop-file', '--ttl-hours', '0'],
      ['--stop-file', '--ttl-hours'], ['--stop-file', '--out'], ['--stop-file', '--stop-file']]) expect((await run(args)).code, args.join(' ')).toBe(2);
  });
});

describe('readers of the stop file', () => {
  const stops = [{ pattern: '^RQ-PHX-RECUTCORE(C[0-9]+)?$', until: nowS + 7200, reason: 'RQ-PHX-RECUTCORE_0of6', auto: true },
    { pattern: '^RQ-HAND', until: nowS + 90, reason: '', auto: false }, { pattern: '([', until: nowS + 90, reason: 'broken', auto: false }];
  const file = () => { const path = join(scratch(), 'stops.tsv'); writeFileSync(path, planStopFile('^RQ-HAND\t' + (nowS + 90) + '\n^RQ-PAST$\t' + (nowS - 1) + '\told\n', [{ family: 'RQ-PHX-RECUTCORE', ...stops[0]! }], now).text); return path; };
  it('makes shouldEmitRecut skip on a live row, even when the yield is unknown', () => {
    const input = { family: 'RQ-PHX-RECUTCORE', stopList: null, lastJobs: [], masterTouched: null, diffContained: null };
    expect(shouldEmitRecut({ ...input, stopRow: stops[0] })).toEqual({ emit: false, code: 'stop-file',
      reason: 'RQ-PHX-RECUTCORE is stopped by the stop file until 2026-11-18T02:00:00.000Z (RQ-PHX-RECUTCORE_0of6)' });
    expect(shouldEmitRecut({ ...input, stopRow: null }).code).toBe('yield-unknown');
    expect(stoppedBy(stops, ['RQ-OTHER-1'])).toBeNull();
  });
  it('finds the live row for a job id or an area, and nothing without a file', async () => {
    const opts = { metrics: join(scratch(), 'none.jsonl'), git: async () => ({ code: 0, stdout: '' }), now };
    for (const target of ['core', 'RQ-PHX-RECUTCOREC566']) expect(shouldEmitRecut((await readRecutGateFacts(target, { ...opts, stopFile: file() }))!).code).toBe('stop-file');
    expect((await readRecutGateFacts('webui', { ...opts, stopFile: file() }))?.stopRow).toBeNull();
    expect((await readRecutGateFacts('core', { ...opts, stopFile: null }))?.stopRow).toBeNull();
    expect(await readLiveStops(null, now)).toBeNull();
    expect(await readLiveStops(join(scratch(), 'none.tsv'), now)).toEqual([]);
  });
  it('gives the Metrics view family, why and time left, and null when the file is unknown', async () => {
    expect(stoppedFamilies(stops.slice(0, 2), now)).toEqual([
      { family: 'RQ-PHX-RECUTCORE', why: '0 merged from 6 launches', until: nowS + 7200, expires_in_s: 7200, auto: true },
      { family: '^RQ-HAND', why: 'unknown', until: nowS + 90, expires_in_s: 90, auto: false }]);
    const dir = scratch();
    expect((await readMetricsPanel(dir, now, file())).stopped?.map(row => row.family)).toEqual(['^RQ-HAND', 'RQ-PHX-RECUTCORE']);
    expect((await readMetricsPanel(dir, now, null)).stopped).toBeNull();
  });
});
