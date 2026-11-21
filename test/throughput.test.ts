import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cmdThroughput } from '../src/cli/throughput.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { buildThroughput, durationText, throughputOptions, throughputText, type ThroughputReport } from '../src/core/fleet/throughput.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const row = (event: string, minutesAgo: number, extra: Record<string, unknown>) => JSON.stringify({ event, ts: at(minutesAgo), ...extra });
const pr = (n: number, repo = 'phantom') => `https://github.com/ashlrai/${repo}/pull/${n}`;
const launch = (job: string, lane: string, repo: string, tier: string, minutesAgo = 55) => row('launch', minutesAgo, { job, lane, repo, tier });

// One fixture fleet with plainly fake values: a busy last hour on lane claude, lane grok with only empties,
// one merge known only by its PR link, one whose time comes from ttm_s, a re-emitted merge and two torn lines.
const LEDGER = [
  launch('RQ-A', 'claude', 'phantom', 'frontier'), launch('RQ-B', 'claude', 'phantom', 'frontier'), launch('RQ-C', 'claude', 'phantom', 'frontier'),
  row('publish', 50, { job: 'RQ-A', class: 'pr', url: pr(1) }), row('publish', 48, { job: 'RQ-B', class: 'pr', url: pr(2) }),
  row('publish', 47, { job: 'RQ-C', class: 'empty' }),
  row('finish', 49, { job: 'RQ-A', empty: false }), row('finish', 47, { job: 'RQ-B', empty: false }), row('finish', 46, { job: 'RQ-C', empty: true }),
  row('outcome', 40, { job: 'RQ-A', url: pr(1), state: 'MERGED', mergedAt: at(48) }),
  row('outcome', 20, { job: 'RQ-A', url: pr(1), state: 'MERGED', mergedAt: at(48) }),
  row('outcome', 40, { job: 'RQ-B', url: pr(2), state: 'MERGED', mergedAt: at(44) }),
  launch('RQ-G1', 'grok', 'locus', 'fast', 40), launch('RQ-G2', 'grok', 'locus', 'fast', 40),
  row('finish', 35, { job: 'RQ-G1', lane: 'grok', empty: true }), row('finish', 35, { job: 'RQ-G2', lane: 'grok', empty: true }),
  row('outcome', 30, { source: 'metrics-outcomes-reconciler', url: pr(3, 'locus'), state: 'MERGED' }),
  launch('RQ-T', 'claude', 'phantom', 'frontier', 115),
  row('outcome', 20, { job: 'RQ-T', url: pr(4), state: 'MERGED', ttm_s: 600 }),
  launch('RQ-OLD', 'claude', 'phantom', 'frontier', 30 * 60), row('publish', 29 * 60, { job: 'RQ-OLD', url: pr(9) }),
  row('outcome', 26 * 60, { job: 'RQ-OLD', url: pr(9), state: 'MERGED' }),
  '{torn', '[1,2]', '',
];
const build = (ledger: string | null, over: Partial<Parameters<typeof buildThroughput>[0]> = {}) =>
  buildThroughput({ ledger, now: NOW, hours: 24, by: 'lane', metricsPath: '/fake/jobs.jsonl', ...over });
const report = build(LEDGER.join('\n'));
const group = (r: ThroughputReport, name: string) => r.groups.find(g => g.name === name)?.totals;

describe('throughput report', () => {
  it('counts one busy hour, with totals, the headline and the as-of time', () => {
    expect(report).toMatchObject({ schema: 'throughput.v1', as_of: '2026-11-17T12:00:00.000Z', since: '2026-11-16T12:00:00.000Z', hours: 24, by: 'lane', metrics: 'ok', main: 'unknown' });
    expect(report.totals).toEqual({ launched: 6, published: 2, merged: 4, finished: 5, empty: 3, empty_rate: 0.6, median_publish_to_merge_s: 240, merge_time_unknown: 1 });
    expect(report.headline).toBe('4 merged in the last 24 hours, median 4m 0s');
    expect(report.buckets).toHaveLength(24);
    expect(report.buckets[23]).toEqual({ start: '2026-11-17T11:00:00.000Z', launched: 5, published: 2, merged: 4, finished: 5, empty: 3, empty_rate: 0.6, median_publish_to_merge_s: 240, merge_time_unknown: 1 });
    expect(report.buckets[22]).toMatchObject({ launched: 1, merged: 0, empty_rate: null, median_publish_to_merge_s: null });
    // A quiet hour in a readable file is a measured zero; its rate and median have no sample, so they stay unknown.
    expect(report.buckets[0]).toMatchObject({ launched: 0, published: 0, merged: 0, empty: 0, empty_rate: null, median_publish_to_merge_s: null });
    expect(build(LEDGER.join('\n'), { hours: 6 }).headline).toBe('4 merged in the last 6 hours, median 4m 0s');
  });

  it('groups by lane, repo or tier, and keeps a lane with only empties', () => {
    expect(report.groups.map(g => g.name)).toEqual(['claude', 'grok', 'unknown']);
    expect(group(report, 'claude')).toMatchObject({ launched: 4, published: 2, merged: 3, finished: 3, empty: 1, empty_rate: 0.333, median_publish_to_merge_s: 240 });
    expect(group(report, 'grok')).toEqual({ launched: 2, published: 0, merged: 0, finished: 2, empty: 2, empty_rate: 1, median_publish_to_merge_s: null, merge_time_unknown: 0 });
    expect(report.groups[1]!.buckets[23]).toMatchObject({ launched: 2, empty: 2 });
    // The merge known only by its PR link has no lane, and no publish time to measure from.
    expect(group(report, 'unknown')).toMatchObject({ launched: 0, merged: 1, empty_rate: null, median_publish_to_merge_s: null, merge_time_unknown: 1 });
    const repos = build(LEDGER.join('\n'), { by: 'repo' });
    expect(repos.groups.map(g => [g.name, g.totals.merged, g.totals.empty])).toEqual([['locus', 1, 2], ['phantom', 3, 1]]);
    expect(build(LEDGER.join('\n'), { by: 'tier' }).groups.map(g => g.name)).toEqual(['fast', 'frontier', 'unknown']);
  });

  it('reads jobs-ledger dialect spellings for events, phases and PR links', () => {
    const d = build([
      JSON.stringify({ type: 'launch', job_id: 'RQ-D', pool: 'claude', repo: 'phantom', tier: 'work', time: at(50) }),
      JSON.stringify({ kind: 'publish', id: 'RQ-D', html_url: pr(21), timestamp: at(45) }),
      JSON.stringify({ type: 'outcome', job: 'RQ-D', result: 'MERGED', updatedAt: at(40), url: pr(21) }),
    ].join('\n'));
    expect(d.totals).toMatchObject({ launched: 1, published: 1, merged: 1 });
  });
  it('skips and counts malformed lines', () => {
    expect(report.malformed_lines).toBe(2);
    expect(throughputText(report)).toContain('Metrics lines that could not be read and were skipped: 2.');
  });

  it('reports an empty window as measured zeros with unknown rate and median', () => {
    const quiet = build(LEDGER.slice(-6).join('\n'));
    expect(quiet.totals).toEqual({ launched: 0, published: 0, merged: 0, finished: 0, empty: 0, empty_rate: null, median_publish_to_merge_s: null, merge_time_unknown: 0 });
    expect(quiet.groups).toEqual([]);
    expect(quiet.headline).toBe('0 merged in the last 24 hours, median unknown');
    expect(throughputText(quiet)).toContain('No jobs or PRs were recorded.');
    expect(build('').totals.merged).toBe(0);
  });

  it('keeps every count unknown when the metrics file is unreadable', () => {
    const missing = build(null);
    expect(missing).toMatchObject({ metrics: 'unreadable', malformed_lines: null, groups: [] });
    expect(Object.values(missing.totals).every(value => value === null)).toBe(true);
    expect(missing.buckets.every(hour => hour.merged === null && hour.launched === null)).toBe(true);
    expect(throughputText(missing).join('\n')).toMatch(/^Merged in the last 24 hours: unknown \(cannot read the job metrics file\)\.\n.*merged unknown, empty unknown, median merge unknown\. Main is unknown\.\nCannot read/);
  });

  it('has a stable JSON order whatever the line order', () => {
    expect(Object.keys(report)).toEqual(['schema', 'as_of', 'since', 'hours', 'by', 'metrics_path', 'metrics', 'malformed_lines', 'main', 'headline', 'totals', 'buckets', 'groups']);
    expect(Object.keys(report.buckets[0]!)).toEqual(['start', 'launched', 'published', 'merged', 'finished', 'empty', 'empty_rate', 'median_publish_to_merge_s', 'merge_time_unknown']);
    expect(Object.keys(report.groups[0]!)).toEqual(['name', 'totals', 'buckets']);
    expect(JSON.stringify(build([...LEDGER].reverse().join('\n')))).toBe(JSON.stringify(report));
  });

  it('writes plain text: busy hours, groups and gaps', () => {
    const text = throughputText(build(LEDGER.join('\n'), { main: 'green' }));
    expect(text[0]).toBe('4 merged in the last 24 hours, median 4m 0s.');
    expect(text[1]).toBe('As of 2026-11-17T12:00:00.000Z: launched 6, published 2, merged 4, empty 3 of 5 finished (60%), median merge 4m 0s. Main is green.');
    expect(text).toContain('  2026-11-17 10:00: launched 1, published 0, merged 0, none finished, median merge unknown');
    expect(text).toContain('Quiet hours left out: 22.');
    expect(text).toContain('  grok: launched 2, published 0, merged 0, empty 2 of 2 finished (100%), median merge unknown');
    expect(text).toContain('Merged PRs with no publish time, left out of the median: 1.');
    expect([durationText(null), durationText(45), durationText(170), durationText(3725)]).toEqual(['unknown', '45s', '2m 50s', '1h 2m']);
  });

  it('validates the window and grouping', () => {
    expect(throughputOptions()).toEqual({ hours: 24, by: 'lane' });
    expect(throughputOptions('6', 'tier')).toEqual({ hours: 6, by: 'tier' });
    for (const [hours, by] of [['0', null], ['169', null], ['6h', null], ['1.5', null], [null, 'model']] as const) expect(throughputOptions(hours, by)).toBeNull();
  });
});

describe('phm throughput', () => {
  let runs: string;
  beforeAll(async () => {
    runs = await mkdtemp(join(tmpdir(), 'throughput-'));
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await mkdir(join(runs, 'supervisor'), { recursive: true });
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), LEDGER.join('\n'));
    const local = new Date(NOW - 300_000), two = (n: number) => String(n).padStart(2, '0');
    const stamp = `${local.getFullYear()}-${two(local.getMonth() + 1)}-${two(local.getDate())} ${two(local.getHours())}:${two(local.getMinutes())}:00`;
    await writeFile(join(runs, 'supervisor', 'status-main-guardian.md'), `# Main guardian status (${stamp})\n| repo | branch | sha | state |\n| --- | --- | --- | --- |\n| phantom | master | abc1234 | green |\n`);
  });
  afterAll(() => rm(runs, { recursive: true, force: true }));
  async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [], err: string[] = [];
    const code = await cmdThroughput(args, { now: () => NOW, out: line => out.push(line), err: line => err.push(line) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('prints JSON by default and plain lines with --text', async () => {
    const json = await run('--runs-dir', runs, '--hours', '6', '--by', 'repo');
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ schema: 'throughput.v1', hours: 6, by: 'repo', main: 'green', totals: { merged: 4, empty: 3 }, headline: '4 merged in the last 6 hours, median 4m 0s' });
    const text = await run('--runs-dir', runs, '--text');
    expect(text.out.split('\n')[0]).toBe('4 merged in the last 24 hours, median 4m 0s.');
    expect(text.out).toContain('By lane:');
  });

  it('serves the same report to the desktop pane', async () => {
    const api = createFleetRunsApi({ runsDir: runs, now: () => NOW });
    const path = '/api/verse/fleet/runs/throughput';
    const call = async (query: string, method = 'GET') => {
      const req = Readable.from([]) as unknown as IncomingMessage;
      req.url = path + query; req.method = method; req.headers = {};
      let status = 0, body: unknown = null;
      const res = { headersSent: false, writeHead(code: number) { status = code; }, end(text: string) { body = JSON.parse(text); } } as unknown as ServerResponse;
      expect(await api({ cfg: {}, token: 'fake-token', allowDispatch: false } as VerseApiContext, req, res, path, method)).toBe(true);
      return { status, body };
    };
    const cli = JSON.parse((await run('--runs-dir', runs, '--hours', '6')).out) as ThroughputReport;
    expect(await call('?hours=6&by=lane')).toEqual({ status: 200, body: cli });
    expect((await call('')).body).toMatchObject({ hours: 24, by: 'lane', totals: { merged: 4 } });
    expect((await call('?hours=999')).status).toBe(400);
    expect((await call('', 'POST')).status).toBe(405);
  });

  it('exits 1 with unknown counts when the metrics file is unreadable, and 2 on a bad option', async () => {
    const missing = await run('--runs-dir', runs, '--metrics', join(runs, 'none.jsonl'));
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.out)).toMatchObject({ metrics: 'unreadable', totals: { merged: null, launched: null } });
    for (const args of [['--hours', '0'], ['--by', 'model'], ['--since', '24h'], ['--hours']]) {
      const bad = await run(...args);
      expect([bad.code, bad.out]).toEqual([2, '']);
      expect(bad.err).toContain('Usage: phm throughput');
    }
    expect((await run('--help')).out).toContain('Usage: phm throughput');
  });
});
