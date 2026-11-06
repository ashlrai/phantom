import { describe, expect, it } from 'vitest';
import { cmdFleetMainRepairTime } from '../src/cli/fleet-main-repair-time.js';

const now = '2026-11-02T12:00:00.000Z';
const enq = (job: string, repo: string, at: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ event: 'enqueue', kind: 'FIXUP-MAIN', job, repo, at, ...extra });
const fin = (job: string, at: string) => JSON.stringify({ event: 'finish', job, at });
const files: Record<string, string> = {
  '/g': [enq('A', 'o/one', '2026-11-02T10:00:00Z'), enq('B', 'o/two', '2026-11-02T11:30:00Z'),
    enq('C', 'o/x', '2026-11-02T11:00:00Z', { kind: 'OTHER' }), 'not json', enq('A', 'o/one', '2026-11-02T10:05:00Z')].join('\n'),
  '/f': [fin('A', '2026-11-02T10:45:00Z'), fin('Z', '2026-11-02T10:50:00Z')].join('\n'),
};
async function run(argv: string[], present = files) {
  const logs: string[] = []; const errors: string[] = [];
  const code = await cmdFleetMainRepairTime(argv, { now: () => new Date(now), output: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
    readFile: (p) => { if (!(p in present)) throw new Error('ENOENT'); return present[p]!; } });
  return { code, logs, errors, report: argv.includes('--json') && logs[0] ? JSON.parse(logs[0]) : null };
}
const base = ['--guardian', '/g', '--finish', '/f', '--json'];

describe('fleet main-repair-time', () => {
  it('reports finished and open repairs with elapsed minutes', async () => {
    const { code, report } = await run(base);
    expect(code).toBe(0);
    expect(report.repairs).toEqual([
      { job: 'A', repo: 'o/one', status: 'finished', elapsedMinutes: 45, enqueuedAt: '2026-11-02T10:00:00Z', finishedAt: '2026-11-02T10:45:00Z' },
      { job: 'B', repo: 'o/two', status: 'open', elapsedMinutes: 30, enqueuedAt: '2026-11-02T11:30:00Z', finishedAt: null },
    ]);
    expect(report.sources.guardian).toMatchObject({ status: 'read', rows: 4 });
  });

  it('marks everything unknown when the finish source is unread', async () => {
    const { code, report } = await run(base, { '/g': files['/g']! });
    expect(code).toBe(1);
    expect(report.sources.finish.status).toBe('unread');
    expect(report.repairs.map((r: { status: string; elapsedMinutes: unknown }) => [r.status, r.elapsedMinutes])).toEqual([['unknown', null], ['unknown', null]]);
  });

  it('returns no repairs when the guardian source is unread', async () => {
    const { code, report } = await run(base, { '/f': files['/f']! });
    expect(code).toBe(1);
    expect(report.repairs).toEqual([]);
    expect(report.sources.guardian.status).toBe('unread');
  });

  it('prints plain lines without --json and rejects bad arguments', async () => {
    const plain = await run(['--guardian', '/g', '--finish', '/f']);
    expect(plain.logs).toEqual(['o/one\tfinished\t45 min\tA', 'o/two\topen\t30 min\tB']);
    expect((await run(['--bogus'])).code).toBe(2);
    expect((await run(['--json', '--json'])).code).toBe(2);
    expect((await run(['--guardian'])).code).toBe(2);
  });
});
