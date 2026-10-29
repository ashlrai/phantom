import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { queueReportFromText } from '../src/core/queue-metrics.js';
import { cmdQueue } from '../src/cli/queue.js';

const fixture = new URL('./fixtures/queue/stations.json', import.meta.url);
const text = readFileSync(fixture, 'utf8');
afterEach(() => vi.restoreAllMocks());

describe('queue report', () => {
  it('calculates fixture rates, observed W and saturated bottleneck', () => {
    const report = queueReportFromText(text);
    expect(report.schema).toBe('phantom-queue-report/v1');
    expect(report.window?.hours).toBe(2);
    expect(report.stations).toEqual([
      { station: 'build', arrivals: 2, completions: 2, lambda: 1, mu: 2, rho: 0.5, W: 0.75 },
      { station: 'review', arrivals: 2, completions: 1, lambda: 1, mu: 2 / 3, rho: 1.5, W: 2 },
    ]);
    expect(report.bottleneck).toBe('review');
  });
  it('accepts JSONL, unordered input and timezone offsets', () => {
    const rows = JSON.parse(text).events.reverse();
    const report = queueReportFromText(rows.map((r: unknown) => JSON.stringify(r)).join('\n\n'));
    expect(report).toEqual(queueReportFromText(text));
    expect(queueReportFromText(JSON.stringify([{station:'x', arrivedAt:'2026-10-26T01:00:00+01:00', startedAt:'2026-10-26T01:00:00+01:00', completedAt:'2026-10-26T02:00:00+01:00'}])).stations[0]?.W).toBe(1);
  });
  it('breaks utilization ties by station name and serializes unknown metrics', () => {
    const visit = { arrivedAt: '2026-10-26T00:00:00Z', startedAt: '2026-10-26T00:00:00Z', completedAt: '2026-10-26T01:00:00Z' };
    expect(queueReportFromText(JSON.stringify([{ ...visit, station: 'z' }, { ...visit, station: 'a' }])).bottleneck).toBe('a');
    const pending = { start: visit.arrivedAt, end: visit.completedAt, events: [{ station: 'x', arrivedAt: visit.arrivedAt }] };
    expect(JSON.parse(JSON.stringify(queueReportFromText(JSON.stringify(pending)))).stations[0].mu).toBeNull();
  });
  it('keeps empty and incomplete evidence unknown', () => {
    expect(queueReportFromText('').bottleneck).toBeNull();
    const report = queueReportFromText(JSON.stringify({start:'2026-10-26T00:00:00Z',end:'2026-10-26T02:00:00Z',events:[{station:'pending',arrivedAt:'2026-10-26T00:00:00Z'}]}));
    expect(report.stations[0]).toMatchObject({ lambda: 0.5, mu: null, rho: null, W: null });
    expect(report.bottleneck).toBeNull();
  });
  it.each([
    'not json', '42', '[null]', '[{"station":"x","arrivedAt":"bad"}]',
    '[{"station":"x","arrivedAt":"2026-10-26T00:00:00Z"}]',
    JSON.stringify({start:'2026-10-27T00:00:00Z',end:'2026-10-26T00:00:00Z',events:[]}),
    text.replace('2026-10-26T00:15:00Z', '2026-10-25T00:15:00Z'),
    text.replace('2026-10-26T00:45:00Z', '2026-10-26T00:15:00Z'),
    text.replace('"station":"build"', '"station":"\\u001bbuild"'),
    text.replace('"end": "2026-10-26T02:00:00Z"', '"end": "2026-10-26T01:00:00Z"'),
  ])('rejects malformed or inconsistent input %#', input => {
    expect(() => queueReportFromText(input)).toThrow();
  });
  it('prints machine JSON and a human table from the fixture', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdQueue(['report', '--events', fixture.pathname, '--json'])).toBe(0);
    expect(JSON.parse(out.mock.calls[0]![0] as string)).toEqual(queueReportFromText(text));
    out.mockClear();
    expect(await cmdQueue(['report', '--events', fixture.pathname])).toBe(0);
    expect(out.mock.calls.flat().join('\n')).toContain('build\t1.0000\t2.0000\t0.5000\t0.7500');
    expect(out.mock.calls.flat()).toContain('Bottleneck: review');
  });
  it.each([['report'], ['other'], ['report','--events'], ['report','--events','--json'], ['report','--wat']])('rejects bad usage %j', async (...args) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdQueue(args)).toBe(2);
  });
  it('returns failure for unreadable files and provides help', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdQueue(['report','--events',new URL('./fixtures/queue/missing.json', import.meta.url).pathname])).toBe(1);
    expect(await cmdQueue(['--help'])).toBe(0);
  });
  it('dispatches stats alongside report and lists both in help', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdQueue(['stats', '--json'])).toBe(0);
    expect(JSON.parse(out.mock.calls[0]![0] as string).schemaVersion).toBe(1);
    out.mockClear();
    expect(await cmdQueue([])).toBe(0);
    const help = out.mock.calls.flat().join('\n');
    expect(help).toContain('queue stats');
    expect(help).toContain('queue report');
  });
});
