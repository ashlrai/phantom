import { describe, expect, it } from 'vitest';

const script = '../scripts/fleet-token-share.mjs';
const { tokenShare, textReport, options } = await import(script);
const now = Date.parse('2026-11-01T12:00:00Z');
const fixture = (rows: unknown[]) => rows.map(row => typeof row === 'string' ? row : JSON.stringify(row));

describe('fleet token share script', () => {
  it('splits token-weighted shares by lane using six or more suffix digits', async () => {
    const row = { event: 'finish', ts: new Date(now - 60_000).toISOString(), lane: 'codex' };
    const lines = fixture([
      { ...row, job: 'FAKE-A123456Q8', tokens_total: 30 },
      { ...row, job: 'FAKE-A1234567Q8', tokens_total: 10 },
      { ...row, job: 'FAKE-WORK', tokens_total: 60 },
      { ...row, lane: 'devin', job: 'FAKE-A12345Q8', tokens_total: 50 },
      { ...row, lane: 'devin', job: 'FAKE-A123456Q8-extra', tokens_total: 50 },
      { ...row, job: 'FAKE-OLD', ts: new Date(now - 3 * 3_600_000).toISOString(), tokens_total: 999 },
      { ...row, job: 'FAKE-FUTURE', ts: new Date(now + 3_600_000).toISOString(), tokens_total: 999 },
      { ...row, job: 'FAKE-LAUNCH', event: 'launch', tokens_total: 999 },
      ...[-1, null, '999', 1.5].map(tokens_total => ({ ...row, job: 'FAKE-BAD', tokens_total })),
      { ...row, job: 'FAKE-BAD-TIME', ts: 'invalid', tokens_total: 999 },
      { ...row, job: 'FAKE-NO-LANE', lane: null, tokens_total: 999 },
      '{broken', null, [], {}, '',
    ]);
    const report = await tokenShare(lines, 2, now);
    expect(report.hours).toBe(2);
    expect(report.lanes).toEqual([
      { lane: 'codex', author_tokens: 40, real_tokens: 60, tokens_total: 100, author_pct: 40, real_pct: 60 },
      { lane: 'devin', author_tokens: 0, real_tokens: 100, tokens_total: 100, author_pct: 0, real_pct: 100 },
    ]);
    expect(report.total).toEqual({ author_tokens: 40, real_tokens: 160, tokens_total: 200, author_pct: 20, real_pct: 80 });
    expect(textReport(report)).toContain('codex\t40 (40.0%)\t60 (60.0%)\t100');
    expect(textReport(report)).toContain('TOTAL\t40 (20.0%)\t160 (80.0%)\t200');
  });

  it('handles empty and zero-token ledgers without undefined shares', async () => {
    expect((await tokenShare([], 24, now)).total).toEqual({ author_tokens: 0, real_tokens: 0, tokens_total: 0, author_pct: 0, real_pct: 0 });
    const zero = fixture([{ event: 'finish', job: 'FAKE-ZERO', lane: 'zero', ts: new Date(now).toISOString(), tokens_total: 0 }]);
    expect((await tokenShare(zero, 24, now)).lanes[0].real_pct).toBe(0);
  });

  it.each([['--hours', '0'], ['--hours', '-1'], ['--hours', 'NaN'], ['--hours', 'Infinity'], ['--hours'], ['--unknown']].map(args => ({ args })))('rejects invalid usage $args', ({ args }) => {
    expect(() => options(args)).toThrow();
  });

  it('includes both window boundaries and excludes the preceding millisecond', async () => {
    const row = { event: 'finish', job: 'FAKE-BOUNDARY', lane: 'codex', tokens_total: 10 };
    const lines = fixture([now - 3_600_001, now - 3_600_000, now, now + 1].map(at => ({ ...row, ts: new Date(at).toISOString() })));
    expect((await tokenShare(lines, 1, now)).total.real_tokens).toBe(20);
  });

  it('parses fractional windows, JSON, help and defaults', () => {
    expect(options(['--hours', '0.5', '--json'])).toEqual({ hours: 0.5, json: true });
    expect(options([])).toEqual({ hours: 24 });
    expect(options(['--help']).help).toBe(true);
  });
});
