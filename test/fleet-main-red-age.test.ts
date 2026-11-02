import { describe, expect, it } from 'vitest';
import { buildMainRedAge, cmdFleetMainRedAge, parseGuardianState } from '../src/cli/fleet-main-red-age.js';

const now = '2026-11-02T12:00:00.000Z';
const state = {
  'o/one': { state: 'red', red_first: '2026-11-02T10:00:00Z', attempts: 2, cur_job: 'RQ-1' },
  'o/two': { state: 'red', red_since: '2026-11-02T11:30:00Z', attempts: 0 },
  'o/three': { state: 'green', attempts: 1 },
  'o/four': { state: 'red', red_first: 'not-a-time', red_since: '2026-11-02T11:45:00Z' },
  'o/five': { state: 'crimson', red_first: '2026-11-02T10:30:00Z', attempts: -3 },
};

async function run(argv: string[], files: Record<string, string> = { '/s': JSON.stringify(state) }) {
  const logs: string[] = []; const errors: string[] = [];
  const code = await cmdFleetMainRedAge(argv, { now: () => new Date(now), output: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
    readFile: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]!; } });
  return { code, logs, errors, report: argv.includes('--json') && logs[0] && logs[0] !== 'unknown' ? JSON.parse(logs[0]) : null };
}

describe('fleet main-red-age', () => {
  it('prints per-repo state, minutes red, attempts and current job', async () => {
    const { code, report } = await run(['--state', '/s', '--json']);
    expect(code).toBe(0);
    expect(report.source).toEqual({ path: '/s', status: 'read' });
    expect(report.repos).toEqual([
      // red_first wins over red_since; longest red first.
      { repo: 'o/one', state: 'red', redSince: '2026-11-02T10:00:00Z', redMinutes: 120, attempts: 2, currentJob: 'RQ-1' },
      { repo: 'o/two', state: 'red', redSince: '2026-11-02T11:30:00Z', redMinutes: 30, attempts: 0, currentJob: null },
      { repo: 'o/four', state: 'red', redSince: '2026-11-02T11:45:00Z', redMinutes: 15, attempts: null, currentJob: null },
      // An unrecognised state and a bad attempt count stay unknown, never guessed.
      { repo: 'o/five', state: 'unknown', redSince: '2026-11-02T10:30:00Z', redMinutes: 90, attempts: null, currentJob: null },
      { repo: 'o/three', state: 'green', redSince: null, redMinutes: null, attempts: 1, currentJob: null },
    ]);
  });

  it('prints unknown when the state file is missing', async () => {
    const { code, logs, errors } = await run(['--state', '/missing']);
    expect(code).toBe(1);
    expect(logs).toEqual(['unknown']);
    expect(errors[0]).toContain('unread guardian state');
    const json = await run(['--state', '/missing', '--json']);
    expect(json.code).toBe(1);
    expect(json.report.source.status).toBe('unread');
    expect(json.report.repos).toEqual([]);
  });

  it('marks a corrupt state file invalid instead of guessing', async () => {
    const { code, report } = await run(['--state', '/s', '--json'], { '/s': 'not json{' });
    expect(code).toBe(1);
    expect(report.source.status).toBe('invalid');
    expect(report.repos).toEqual([]);
  });

  it('accepts a top-level {"repos": {...}} wrapper', async () => {
    const { report } = await run(['--state', '/s', '--json'], { '/s': JSON.stringify({ repos: { 'o/one': state['o/one'] } }) });
    expect(report.repos.map((r: { repo: string }) => r.repo)).toEqual(['o/one']);
  });

  it('prints plain lines, one per repo, without --json', async () => {
    const { code, logs } = await run(['--state', '/s']);
    expect(code).toBe(0);
    expect(logs).toEqual([
      'o/one\tred\tred 120 min\tattempts 2\tjob RQ-1',
      'o/two\tred\tred 30 min\tattempts 0\tjob none',
      'o/four\tred\tred 15 min\tattempts unknown\tjob none',
      'o/five\tunknown\tred 90 min\tattempts unknown\tjob none',
      'o/three\tgreen\tred unknown min\tattempts 1\tjob none',
    ]);
  });

  it('rejects bad arguments', async () => {
    expect((await run(['--bogus'])).code).toBe(2);
    expect((await run(['--json', '--json'])).code).toBe(2);
    expect((await run(['--state'])).code).toBe(2);
    expect((await run(['--state', '/s', '--state', '/s'])).code).toBe(2);
    expect((await run(['--help'])).code).toBe(0);
  });
});

describe('parseGuardianState and buildMainRedAge', () => {
  it('rejects non-object roots and caps the table', () => {
    expect(parseGuardianState('[1,2]')).toBeNull();
    expect(parseGuardianState('"red"')).toBeNull();
    const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`o/r${i.toString().padStart(3, '0')}`, { state: 'green' }]));
    expect(Object.keys(parseGuardianState(JSON.stringify(many))!)).toHaveLength(200);
    expect(parseGuardianState(JSON.stringify({ 'bad repo name!': {}, 'o/ok': {} }))).toEqual({ 'o/ok': {} });
  });

  it('treats a future red stamp as clock skew, not red time', () => {
    const report = buildMainRedAge({ 'o/x': { state: 'red', red_since: '2026-11-03T00:00:00Z' } }, new Date(now));
    expect(report.repos[0]).toMatchObject({ redMinutes: null });
    const justNow = buildMainRedAge({ 'o/x': { state: 'red', red_since: now } }, new Date(now));
    expect(justNow.repos[0]).toMatchObject({ redMinutes: 0 });
  });

  it('ignores malformed entries without dropping the repo', () => {
    const report = buildMainRedAge({ 'o/x': null as never }, new Date(now));
    expect(report.repos).toEqual([{ repo: 'o/x', state: 'unknown', redSince: null, redMinutes: null, attempts: null, currentJob: null }]);
  });
});
