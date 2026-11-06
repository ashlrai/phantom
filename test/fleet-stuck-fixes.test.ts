import { describe, expect, it } from 'vitest';
import { cmdFleetStuckFixes } from '../src/cli/fleet-stuck-fixes.js';

const now = '2026-11-02T12:00:00.000Z';
const pub = (job: string, url: string, ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ event: 'publish', class: 'pr', job, url, ts, ...extra });
const outcome = (job: string, state: string, ts: string) =>
  JSON.stringify({ event: 'outcome', job, state, ts });

const PR_OLD = 'https://github.com/ashlrai/phantom/pull/101';
const PR_STALE = 'https://github.com/ashlrai/lexicon/pull/77';

const files: Record<string, string> = {
  '/jobs': [
    // Stuck: published 60 min ago, no terminal outcome.
    pub('FIXUP-MAIN-phantom-a1f206c', PR_OLD, '2026-11-02T11:00:00Z', { repo: 'phantom' }),
    // Resolved: merged.
    pub('FIXUP-MAIN-ashlr-b2f3e4d', 'https://github.com/ashlrai/ashlr/pull/9', '2026-11-02T10:00:00Z'),
    outcome('FIXUP-MAIN-ashlr-b2f3e4d', 'MERGED', '2026-11-02T10:40:00Z'),
    // Resolved: closed without merge.
    pub('FIXUP-MAIN-stack-c3d4e5f', 'https://github.com/ashlrai/stack/pull/5', '2026-11-02T09:00:00Z'),
    outcome('FIXUP-MAIN-stack-c3d4e5f', 'CLOSED', '2026-11-02T09:30:00Z'),
    // Fresh: only 10 min old.
    pub('FIXUP-MAIN-plugin-d4e5f6a', 'https://github.com/ashlrai/plugin/pull/3', '2026-11-02T11:50:00Z'),
    // Stuck: no repo field — the id names it. 42 min old.
    pub('FIXUP-MAIN-lexicon-e5f6a7b', PR_STALE, '2026-11-02T11:18:00Z'),
    // No url row at all.
    outcome('FIXUP-MAIN-nourl-f6a7b8c', 'OPEN', '2026-11-02T08:00:00Z'),
    // Url but no dated row: age cannot be proven, so it stays out.
    JSON.stringify({ event: 'publish', class: 'pr', job: 'FIXUP-MAIN-nodate-a6b7c8d', url: 'https://github.com/ashlrai/x/pull/1' }),
    // Not a guardian fix id.
    pub('RQ-OTHER-9', 'https://github.com/ashlrai/phantom/pull/55', '2026-11-02T08:00:00Z'),
    'not json',
  ].join('\n'),
};

async function run(argv: string[], present: Record<string, string> = files) {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await cmdFleetStuckFixes(argv, {
    now: () => new Date(now),
    output: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
    readFile: (p) => { if (!(p in present)) throw new Error('ENOENT'); return present[p]!; },
  });
  return { code, logs, errors, report: argv.includes('--json') && logs[0] ? JSON.parse(logs[0]) : null };
}

const base = ['--jobs', '/jobs', '--json'];

describe('fleet stuck-fixes', () => {
  it('lists FIXUP-MAIN jobs with a PR url, no MERGED/CLOSED outcome and age over 20 min', async () => {
    const { code, report } = await run(base);
    expect(code).toBe(0);
    expect(report.known).toBe(true);
    expect(report.thresholdMinutes).toBe(20);
    expect(report.stuck).toEqual([
      { job: 'FIXUP-MAIN-phantom-a1f206c', repo: 'phantom', prUrl: PR_OLD,
        publishedAt: '2026-11-02T11:00:00.000Z', ageMinutes: 60 },
      { job: 'FIXUP-MAIN-lexicon-e5f6a7b', repo: 'lexicon', prUrl: PR_STALE,
        publishedAt: '2026-11-02T11:18:00.000Z', ageMinutes: 42 },
    ]);
  });

  it('keeps the newest dated url when a job republishes', async () => {
    const text = [
      pub('FIXUP-MAIN-phantom-a1f206c', 'https://github.com/ashlrai/phantom/pull/90', '2026-11-02T10:00:00Z'),
      pub('FIXUP-MAIN-phantom-a1f206c', PR_OLD, '2026-11-02T11:30:00Z'),
    ].join('\n');
    const { report } = await run(base, { '/jobs': text });
    expect(report.stuck[0].prUrl).toBe(PR_OLD);
    expect(report.stuck[0].ageMinutes).toBe(30);
  });

  it('returns known:false when the ledger is unread', async () => {
    const { code, report } = await run(base, {});
    expect(code).toBe(1);
    expect(report.known).toBe(false);
    expect(report.stuck).toEqual([]);
  });

  it('prints plain lines without --json and rejects bad arguments', async () => {
    const plain = await run(['--jobs', '/jobs']);
    expect(plain.code).toBe(0);
    expect(plain.logs).toEqual([
      `phantom\t60 min\t${PR_OLD}\tFIXUP-MAIN-phantom-a1f206c`,
      `lexicon\t42 min\t${PR_STALE}\tFIXUP-MAIN-lexicon-e5f6a7b`,
    ]);
    const empty = await run(['--jobs', '/jobs'], { '/jobs': '' });
    expect(empty.logs).toEqual(['no stuck FIXUP-MAIN pull requests']);
    const unread = await run(['--jobs', '/jobs'], {});
    expect(unread.errors[0]).toBe('unread jobs ledger: /jobs');
    expect((await run(['--bogus'])).code).toBe(2);
    expect((await run(['--json', '--json'])).code).toBe(2);
    expect((await run(['--jobs'])).code).toBe(2);
    expect((await run(['--help'])).code).toBe(0);
  });
});
