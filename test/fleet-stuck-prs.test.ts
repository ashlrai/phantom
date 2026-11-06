import { describe, expect, it } from 'vitest';
import { cmdFleetStuckPrs } from '../src/cli/fleet-stuck-prs.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const pr = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
const FIXTURE = [
  { job: 'RQ-A', ts: '2026-11-02T08:00:00Z', event: 'publish', url: pr(1) },
  { job: 'RQ-A', ts: '2026-11-02T09:00:00Z', event: 'outcome', outcome: 'open', url: pr(9) },
  { job: 'RQ-B', ts: '2026-11-02T06:00:00Z', event: 'publish', pr_url: pr(2), repo: 'ashlrai/other' },
  { job: 'RQ-B', ts: '2026-11-02T06:30:00Z', event: 'outcome', outcome: 'open' },
  { job: 'RQ-C', ts: '2026-11-02T05:00:00Z', event: 'publish', url: pr(3) },
  { job: 'RQ-C', ts: '2026-11-02T05:10:00Z', event: 'outcome', outcome: 'open' },
  { job: 'RQ-C', ts: '2026-11-02T07:00:00Z', event: 'outcome', outcome: 'merged' },
  { job: 'RQ-D', ts: '2026-11-02T11:30:00Z', event: 'publish', url: pr(4) },
  { job: 'RQ-D', ts: '2026-11-02T11:31:00Z', event: 'outcome', outcome: 'open' },
  { job: 'RQ-E', ts: '2026-11-02T01:00:00Z', event: 'outcome', outcome: 'open' },
].map(r => JSON.stringify(r)).join('\n') + '\nnot json\n';

async function run(args: string[], read = async () => FIXTURE) {
  let out = '';
  const code = await cmdFleetStuckPrs([...args, '--json'], { read, now: () => NOW, output: t => { out = t; }, error: () => {} });
  return { code, report: out ? JSON.parse(out) : undefined };
}

describe('fleet stuck-prs', () => {
  it('lists open jobs older than the default hour, oldest first, using the first PR url', async () => {
    const { code, report } = await run([]);
    expect(code).toBe(0);
    expect(report.stuck).toEqual([
      { job: 'RQ-B', url: pr(2), repo: 'ashlrai/other', ageMinutes: 360 },
      { job: 'RQ-A', url: pr(1), repo: 'ashlrai/phantom', ageMinutes: 240 },
    ]);
  });
  it('honours --min-age', async () => {
    expect((await run(['--min-age', '10'])).report.stuck.map((s: { job: string }) => s.job)).toEqual(['RQ-B', 'RQ-A', 'RQ-D']);
    expect((await run(['--min-age', '300'])).report.stuck.map((s: { job: string }) => s.job)).toEqual(['RQ-B']);
  });
  it('rejects bad flags and reports unreadable metrics', async () => {
    expect((await run(['--min-age', 'x'])).code).toBe(2);
    expect((await run(['--bogus'])).code).toBe(2);
    const failed = await run([], async () => { throw new Error('nope'); });
    expect(failed.code).toBe(1);
    expect(failed.report.error).toBeTruthy();
  });
});
